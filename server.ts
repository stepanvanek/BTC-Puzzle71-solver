import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITEMAP_TAB_PAIRS, pathnameForTab } from './src/i18n/locale.ts';
import { validateBitcoinAddress } from './src/shared/btcAddress.ts';
import { verifySignedPuzzleTx } from './src/shared/btcTx.ts';
import {
  ADMIN_PAYOUT_ADDRESS,
  PUZZLE_71_ADDRESS,
  PUZZLE_71_HASH160_HEX,
  getRecommendedBatchBlockCount,
} from './src/shared/puzzle71.ts';
import { Puzzle71Store } from './server/db.ts';
import { broadcastPrivatePoolTransaction, fetchPuzzle71NetworkInfo } from './server/privateRelay.ts';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseCliArg(names: string[]): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    for (const name of names) {
      if (arg === name && i + 1 < argv.length) {
        return argv[i + 1];
      }
      if (arg.startsWith(`${name}=`)) {
        return arg.slice(name.length + 1);
      }
    }
  }
  return undefined;
}

function resolveListenPort(): number {
  const cliPortRaw = parseCliArg(['--port', '-p']);
  if (cliPortRaw) {
    const parsed = Number(cliPortRaw);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }

  const envPortRaw = process.env.PORT;
  const nginxPortRaw = process.env.NGINX_PORT;
  const defaultAppPort = Number(process.env.DEFAULT_APP_PORT || 3000);
  if (envPortRaw) {
    const parsed = Number(envPortRaw);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      // Never collide with the container nginx reverse proxy port in dev mode
      if (process.env.NODE_ENV !== 'production' && nginxPortRaw && envPortRaw === nginxPortRaw) {
        return Number.isInteger(defaultAppPort) && defaultAppPort > 0 ? defaultAppPort : 3000;
      }
      return parsed;
    }
  }

  return Number.isInteger(defaultAppPort) && defaultAppPort > 0 ? defaultAppPort : 3000;
}

function resolveListenHost(): string {
  return parseCliArg(['--host', '-H']) || process.env.HOST || '0.0.0.0';
}

const PORT = resolveListenPort();
const HOST = resolveListenHost();
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'puzzle71.db');

const store = new Puzzle71Store(DB_PATH);

const app = express();
const distPathForHeaders = path.join(__dirname, 'dist');
const isProdEnv = process.env.NODE_ENV === 'production' && fs.existsSync(distPathForHeaders);
const trustProxySetting =
  process.env.TRUST_PROXY === '0' || process.env.TRUST_PROXY === 'false' ? false : 1;
app.set('trust proxy', trustProxySetting);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Baseline browser security headers (keeps iframe compatibility for preview while setting nosniff, Referrer-Policy & CSP)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  const scriptSrc = isProdEnv ? "script-src 'self'" : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https: ws: wss:",
      "worker-src 'self' blob:",
    ].join('; '),
  );
  next();
});

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string, maxCount: number, windowMs: number): boolean {
  const now = Date.now();
  if (rateBuckets.size > 4000) {
    for (const [k, v] of rateBuckets) {
      if (v.resetAt <= now) rateBuckets.delete(k);
    }
  }
  const existing = rateBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (existing.count >= maxCount) {
    return false;
  }
  existing.count += 1;
  return true;
}

function getClientIp(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || 'local';
}

function extractDeviceSecret(req: express.Request): string | undefined {
  const headerVal = req.get('x-device-secret');
  const bodyVal = typeof req.body?.deviceSecret === 'string' ? req.body.deviceSecret : undefined;
  const candidate = (headerVal ?? bodyVal ?? '').trim();
  if (candidate.length >= 16 && candidate.length <= 200) {
    return candidate;
  }
  return undefined;
}

function parsePowOffsetsBody(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 32)
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n >= 0);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// SEO crawlers: robots.txt & sitemap.xml (disallow private ?u= session URLs and /api/ endpoints)
function resolvePublicBaseUrl(req: express.Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.origin;
      }
    } catch {
      // fall through to request-derived host check
    }
  }
  const protoHeader = req.headers['x-forwarded-proto'];
  const rawProto =
    typeof protoHeader === 'string' && protoHeader.trim()
      ? protoHeader.split(',')[0].trim().toLowerCase()
      : (req.protocol || 'https').toLowerCase();
  const proto = rawProto === 'http' || rawProto === 'https' ? rawProto : 'https';
  const rawHost = (req.get('host') || '').trim();
  const safeHost = /^[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(rawHost) ? rawHost : `localhost:${PORT}`;
  return `${proto}://${safeHost}`;
}

app.get('/robots.txt', (req, res) => {
  const baseUrl = resolvePublicBaseUrl(req);
  res.type('text/plain; charset=utf-8').send(
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      'Disallow: /*?u=*',
      '',
      `Sitemap: ${baseUrl}/sitemap.xml`,
    ].join('\n'),
  );
});

app.get('/sitemap.xml', (req, res) => {
  const baseUrl = escapeXml(resolvePublicBaseUrl(req));
  const lastMod = escapeXml(new Date().toISOString().slice(0, 10));

  const urlEntries: string[] = [];
  for (const item of SITEMAP_TAB_PAIRS) {
    const enPath = escapeXml(pathnameForTab(item.tab, 'en'));
    const csPath = escapeXml(pathnameForTab(item.tab, 'cs'));
    const alternates = [
      `    <xhtml:link rel="alternate" hreflang="en" href="${baseUrl}${enPath}" />`,
      `    <xhtml:link rel="alternate" hreflang="cs" href="${baseUrl}${csPath}" />`,
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${baseUrl}${enPath}" />`,
    ].join('\n');

    urlEntries.push(
      `  <url>\n    <loc>${baseUrl}${enPath}</loc>\n${alternates}\n    <lastmod>${lastMod}</lastmod>\n    <changefreq>${item.changefreq}</changefreq>\n    <priority>${item.priority}</priority>\n  </url>`,
    );
    const csPriority = Math.max(0.1, Number(item.priority) - 0.1).toFixed(1);
    urlEntries.push(
      `  <url>\n    <loc>${baseUrl}${csPath}</loc>\n${alternates}\n    <lastmod>${lastMod}</lastmod>\n    <changefreq>${item.changefreq}</changefreq>\n    <priority>${csPriority}</priority>\n  </url>`,
    );
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urlEntries,
    '</urlset>',
  ].join('\n');

  res.type('application/xml; charset=utf-8').send(xml);
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, puzzle: 71, targetAddress: PUZZLE_71_ADDRESS });
});

// Live Puzzle #71 UTXO & recommended fee rates
app.get('/api/puzzle71/network', async (_req, res) => {
  try {
    const info = await fetchPuzzle71NetworkInfo();
    res.json(info);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to fetch Puzzle #71 network metadata.',
    });
  }
});

// Public anonymized leaderboard (middle of BTC addresses masked for user safety)
app.get('/api/leaderboard', (req, res) => {
  try {
    if (!checkRateLimit(`leaderboard:${getClientIp(req)}`, 60, 60_000)) {
      res.status(429).json({ error: 'Too many leaderboard requests. Please wait a moment.' });
      return;
    }
    const rawLimit = Number(req.query?.limit ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 50;
    const leaderboard = store.getPublicLeaderboard(limit);
    res.json(leaderboard);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to load public leaderboard.',
    });
  }
});

// Create an isolated user session (or resume only if caller supplies the matching shareToken)
app.post('/api/sessions', (req, res) => {
  try {
    const locale = req.body?.locale === 'cs' ? 'cs' : 'en';
    if (!checkRateLimit(`session:${getClientIp(req)}`, 25, 60_000)) {
      res.status(429).json({
        error:
          locale === 'cs'
            ? 'Příliš mnoho požadavků na vytvoření relace. Zkuste za chvíli.'
            : 'Too many session creation requests. Please try again shortly.',
      });
      return;
    }

    const btcAddress = typeof req.body?.btcAddress === 'string' ? req.body.btcAddress.trim() : '';
    const existingShareToken =
      typeof req.body?.existingShareToken === 'string' ? req.body.existingShareToken.trim() : undefined;
    const validation = validateBitcoinAddress(btcAddress, locale);
    if (!validation.valid || !validation.parsed) {
      res.status(400).json({
        error:
          validation.error ||
          (locale === 'cs' ? 'Neplatná bitcoinová adresa.' : 'Invalid Bitcoin address.'),
      });
      return;
    }

    const session = store.createOrGetSession(
      validation.parsed.normalizedAddress,
      validation.parsed.type,
      existingShareToken,
    );
    const summary = store.getSessionSummary(session.share_token);
    res.status(201).json(summary);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Internal error while creating session.',
    });
  }
});

// Get session summary by share token (used when opening shareable URL on any device)
app.get('/api/sessions/:token', (req, res) => {
  try {
    if (!checkRateLimit(`get-session:${getClientIp(req)}`, 120, 60_000)) {
      res.status(429).json({ error: 'Too many session requests. Please wait a moment.' });
      return;
    }
    const summary = store.getSessionSummary(req.params.token);
    if (!summary) {
      res.status(404).json({ error: 'Session link not found.' });
      return;
    }
    res.json(summary);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Internal error while loading session.',
    });
  }
});

// Update block allocation strategy (random vs sequential + starting position percent)
app.patch('/api/sessions/:token/strategy', (req, res) => {
  try {
    if (!checkRateLimit(`strategy:${getClientIp(req)}`, 30, 60_000)) {
      res.status(429).json({ error: 'Too many strategy updates. Please wait a moment.' });
      return;
    }
    const blockMode = req.body?.blockMode === 'sequential' ? 'sequential' : 'random';
    const startPercent =
      req.body?.startPercent !== undefined ? Number(req.body.startPercent) : undefined;
    const deviceId =
      typeof req.body?.deviceId === 'string' && req.body.deviceId.trim()
        ? req.body.deviceId.trim().slice(0, 80)
        : undefined;
    const deviceSecret = extractDeviceSecret(req);
    if (deviceId && !deviceSecret) {
      res.status(401).json({ error: 'Missing device authorization secret.' });
      return;
    }

    const summary = store.updateSessionStrategy({
      shareToken: req.params.token,
      blockMode,
      startPercent,
      deviceId,
      deviceSecret,
    });
    res.json(summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to save block strategy.';
    res.status(msg.includes('Neoprávněný') ? 403 : 400).json({ error: msg });
  }
});

// Lease one or more contiguous 2^29 keyspace blocks (scaled by measured GPU speed)
app.post('/api/sessions/:token/blocks/lease', (req, res) => {
  try {
    if (!checkRateLimit(`lease:${getClientIp(req)}`, 45, 60_000)) {
      res.status(429).json({ error: 'Too many block lease requests. Please wait a moment.' });
      return;
    }

    const deviceSecret = extractDeviceSecret(req);
    if (!deviceSecret) {
      res.status(401).json({ error: 'Missing or invalid device authorization secret.' });
      return;
    }

    const deviceId =
      typeof req.body?.deviceId === 'string' && req.body.deviceId.trim()
        ? req.body.deviceId.trim().slice(0, 80)
        : 'unknown-device';
    const deviceLabel =
      typeof req.body?.deviceLabel === 'string' && req.body.deviceLabel.trim()
        ? req.body.deviceLabel.trim().slice(0, 80)
        : 'Browser';
    const computeMode = req.body?.computeMode === 'webgpu' ? 'webgpu' : 'cpu';
    const gpuName =
      typeof req.body?.gpuName === 'string' && req.body.gpuName.trim()
        ? req.body.gpuName.trim().slice(0, 120)
        : 'Standard Compute Core';
    const rateKps = Number(req.body?.rateKps);
    const desiredCount =
      req.body?.desiredCount !== undefined
        ? Number(req.body.desiredCount)
        : Number.isFinite(rateKps) && rateKps > 0
          ? getRecommendedBatchBlockCount(rateKps)
          : 1;

    const blocks = store.leaseBlockBatch({
      shareToken: req.params.token,
      deviceId,
      deviceLabel,
      computeMode,
      gpuName,
      desiredCount,
      rateKps: Number.isFinite(rateKps) && rateKps > 0 ? rateKps : undefined,
      deviceSecret,
    });
    res.json({
      block: blocks[0],
      blocks,
      recommendedBatchCount: blocks.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to lease keyspace block.';
    const status = msg.includes('limit') ? 429 : msg.includes('Neoprávněný') ? 403 : 404;
    res.status(status).json({ error: msg });
  }
});

// Keep-alive heartbeat when a block is paused in an open browser tab
app.post('/api/sessions/:token/blocks/:blockId/heartbeat', (req, res) => {
  try {
    if (!checkRateLimit(`heartbeat:${getClientIp(req)}`, 60, 60_000)) {
      res.status(429).json({ error: 'Too many heartbeat requests.' });
      return;
    }
    const deviceSecret = extractDeviceSecret(req);
    if (!deviceSecret) {
      res.status(401).json({ error: 'Missing or invalid device authorization secret.' });
      return;
    }
    const blockId = Number(req.params.blockId);
    const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId : 'unknown';
    const result = store.heartbeatBlock({
      shareToken: req.params.token,
      blockId,
      deviceId,
      deviceSecret,
    });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to refresh block lease.';
    res.status(msg.includes('Neoprávněný') ? 403 : 400).json({ error: msg });
  }
});

// Save checkpoint progress and verified PoW shares inside a leased block
app.post('/api/sessions/:token/blocks/:blockId/checkpoint', (req, res) => {
  try {
    if (!checkRateLimit(`checkpoint:${getClientIp(req)}`, 90, 60_000)) {
      res.status(429).json({ error: 'Too many checkpoint requests.' });
      return;
    }
    const deviceSecret = extractDeviceSecret(req);
    if (!deviceSecret) {
      res.status(401).json({ error: 'Missing or invalid device authorization secret.' });
      return;
    }
    const blockId = Number(req.params.blockId);
    const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId : 'unknown';
    const progressOffset = Number(req.body?.progressOffset ?? 0);
    const rateKps = Number(req.body?.rateKps ?? 0);
    const powOffsets = parsePowOffsetsBody(req.body?.powOffsets);
    const result = store.checkpointBlock({
      shareToken: req.params.token,
      blockId,
      deviceId,
      progressOffset,
      rateKps,
      powOffsets,
      deviceSecret,
    });
    res.json({ ok: true, powCount: result.powCount });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to save block checkpoint.';
    res.status(msg.includes('Neoprávněný') ? 403 : 400).json({ error: msg });
  }
});

// Mark a leased block as 100% completed (requires verified cryptographic PoW shares)
app.post('/api/sessions/:token/blocks/:blockId/complete', (req, res) => {
  try {
    if (!checkRateLimit(`complete:${getClientIp(req)}`, 30, 60_000)) {
      res.status(429).json({ error: 'Too many block completion requests.' });
      return;
    }
    const deviceSecret = extractDeviceSecret(req);
    if (!deviceSecret) {
      res.status(401).json({ error: 'Missing or invalid device authorization secret.' });
      return;
    }
    const blockId = Number(req.params.blockId);
    const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId : 'unknown';
    const rateKps = Number(req.body?.rateKps ?? 0);
    const powOffsets = parsePowOffsetsBody(req.body?.powOffsets);
    store.completeBlock({
      shareToken: req.params.token,
      blockId,
      deviceId,
      rateKps,
      powOffsets,
      deviceSecret,
    });
    const summary = store.getSessionSummary(req.params.token);
    res.json({ ok: true, summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to complete block.';
    res.status(msg.includes('Neoprávněný') ? 403 : 400).json({ error: msg });
  }
});

// Private mining pool broadcast endpoint (MARA Slipstream + Rebar Shield)
// Cryptographically verifies rawTxHex structure, ECDSA signatures, Puzzle #71 Hash160, UTXOs & 85/15 split before relaying.
app.post('/api/broadcast-private', async (req, res) => {
  try {
    if (!checkRateLimit(`broadcast:${getClientIp(req)}`, 20, 60_000)) {
      res.status(429).json({ error: 'Too many broadcast requests. Please wait a moment.' });
      return;
    }

    const rawTxHex = typeof req.body?.rawTxHex === 'string' ? req.body.rawTxHex : '';
    const dryRun = Boolean(req.body?.dryRun);
    const locale = req.body?.locale === 'cs' ? 'cs' : 'en';
    const shareToken = typeof req.body?.shareToken === 'string' ? req.body.shareToken.trim() : '';

    const adminParsed = validateBitcoinAddress(ADMIN_PAYOUT_ADDRESS, locale);
    if (!adminParsed.valid || !adminParsed.parsed) {
      throw new Error('Server platform payout address configuration is invalid.');
    }

    const session = shareToken ? store.getSessionByToken(shareToken) : null;
    if (!dryRun && !session) {
      res.status(401).json({
        error:
          locale === 'cs'
            ? 'Pro skutečné privátní odeslání transakce je vyžadována platná aktivní relace.'
            : 'A valid active session token is required for live private pool submission.',
      });
      return;
    }

    let expectedUserScript: Uint8Array | undefined;
    if (session) {
      const userParsed = validateBitcoinAddress(session.btc_address, locale);
      if (userParsed.valid && userParsed.parsed) {
        expectedUserScript = userParsed.parsed.scriptPubKey;
      }
    }

    let allowedUtxos: Array<{ txid: string; vout: number; valueSats: bigint }> | undefined;
    let enforceAllowedUtxos = false;
    if (!dryRun) {
      const net = await fetchPuzzle71NetworkInfo();
      if (net.source === 'live-mempool' && net.utxos.length > 0) {
        allowedUtxos = net.utxos.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          valueSats: BigInt(u.valueSats),
        }));
        enforceAllowedUtxos = true;
      }
    }

    const verified = verifySignedPuzzleTx({
      rawTxHex,
      expectedHash160Hex: dryRun ? undefined : PUZZLE_71_HASH160_HEX,
      expectedUserScript,
      expectedAdminScript: adminParsed.parsed.scriptPubKey,
      allowedUtxos,
      enforceAllowedUtxos,
    });

    const result = await broadcastPrivatePoolTransaction({ rawTxHex, dryRun, locale });

    if (session) {
      store.recordRelaySubmission({
        shareToken: session.share_token,
        txid: verified.txid,
        rawTxHex: rawTxHex.trim().toLowerCase(),
        userSats: verified.userSats.toString(),
        adminSats: verified.adminSats.toString(),
        feeSats: verified.feeSats.toString(),
        isDryRun: dryRun,
        relayResultsJson: JSON.stringify(result.receipts),
      });
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Private mining-pool submission failed.',
    });
  }
});

// Ensure /api/* errors always return JSON rather than Express HTML error pages
app.use('/api', (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : 'Unexpected API server error.';
  res.status(500).json({ error: message });
});

async function startServer() {
  const httpServer = http.createServer(app);
  const distPath = path.join(__dirname, 'dist');
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(distPath);

  let viteServer: { middlewares: express.RequestHandler; close: () => Promise<void> } | null = null;
  let viteInitError: Error | null = null;
  let viteReadyPromise: Promise<void> | null = null;

  // Keep repository markdown documentation (e.g. README.md) hidden from HTTP exposure on the live URL
  app.use((req, res, next) => {
    if (/\.md$/i.test(req.path) || /^\/readme$/i.test(req.path)) {
      res.status(404).type('text/plain').send('Not Found');
      return;
    }
    next();
  });

  if (isProd) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    app.use(async (req, res, next) => {
      if (req.path.startsWith('/api/')) {
        next();
        return;
      }
      if (viteReadyPromise) {
        await viteReadyPromise;
      }
      if (viteInitError) {
        next(viteInitError);
        return;
      }
      if (viteServer) {
        viteServer.middlewares(req, res, next);
        return;
      }
      next();
    });
  }

  // Bind HTTP port immediately so platform health probes succeed within milliseconds
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PORT, HOST, () => {
      console.log(`Puzzle71 server running on http://localhost:${PORT}`);
      resolve();
    });
  });

  if (!isProd) {
    viteReadyPromise = (async () => {
      try {
        const { createServer: createViteServer } = await import('vite');
        const hmrDisabled =
          process.env.DISABLE_HMR === 'true' ||
          Boolean(process.env.APPLET_ID) ||
          Boolean(process.env.NG_ALLOWED_HOSTS);
        viteServer = await createViteServer({
          plugins: hmrDisabled
            ? [
                {
                  name: 'disable-vite-client-hmr-ws',
                  enforce: 'post',
                  transform(code, id) {
                    const normalizedId = id.replace(/\\/g, '/');
                    if (
                      normalizedId.endsWith('/vite/dist/client/client.mjs') &&
                      code.includes('createWebSocketModuleRunnerTransport({')
                    ) {
                      const patched = code.replace(
                        /let\s+wsTransport\s*=\s*createWebSocketModuleRunnerTransport\(\{[\s\S]*?\}\);/,
                        'let wsTransport = { async connect() {}, disconnect() {}, send() {} };'
                      );
                      if (patched !== code) {
                        return { code: patched, map: null };
                      }
                    }
                    return null;
                  },
                },
              ]
            : [],
          server: {
            middlewareMode: true,
            allowedHosts: true,
            hmr: hmrDisabled ? false : { server: httpServer },
            ws: hmrDisabled ? false : undefined,
            watch: hmrDisabled ? null : undefined,
          },
          appType: 'spa',
        });
      } catch (err) {
        viteInitError = err instanceof Error ? err : new Error(String(err));
        console.error('Vite middleware initialization failed:', viteInitError);
      }
    })();
  }

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    const forceTimer = setTimeout(() => process.exit(0), 500);
    forceTimer.unref();
    try {
      if (viteServer) {
        await viteServer.close();
      }
    } catch {
      // ignore
    }
    try {
      store.close();
    } catch {
      // ignore
    }
    try {
      httpServer.closeAllConnections?.();
    } catch {
      // ignore
    }
    httpServer.close(() => {
      process.exit(0);
    });
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.once('SIGHUP', () => {
    void shutdown();
  });
}

startServer().catch((err) => {
  console.error('Failed to start Puzzle71 server:', err);
  process.exit(1);
});
