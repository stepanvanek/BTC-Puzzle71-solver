import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITEMAP_TAB_PAIRS, pathnameForTab } from './src/i18n/locale.ts';
import { validateBitcoinAddress } from './src/shared/btcAddress.ts';
import { PUZZLE_71_ADDRESS, getRecommendedBatchBlockCount } from './src/shared/puzzle71.ts';
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
app.use(express.json({ limit: '1mb' }));

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
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'local';
}

function parsePowOffsetsBody(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 32)
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n >= 0);
}

// SEO crawlers: robots.txt & sitemap.xml (disallow private ?u= session URLs and /api/ endpoints)
function resolvePublicBaseUrl(req: express.Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto =
    typeof protoHeader === 'string' && protoHeader.trim()
      ? protoHeader.split(',')[0].trim()
      : req.protocol || 'https';
  const host = req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
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
  const baseUrl = resolvePublicBaseUrl(req);
  const lastMod = new Date().toISOString().slice(0, 10);

  const urlEntries: string[] = [];
  for (const item of SITEMAP_TAB_PAIRS) {
    const enPath = pathnameForTab(item.tab, 'en');
    const csPath = pathnameForTab(item.tab, 'cs');
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

// Create or retrieve user session for a validated Bitcoin payout address
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
    const blockMode = req.body?.blockMode === 'sequential' ? 'sequential' : 'random';
    const startPercent =
      req.body?.startPercent !== undefined ? Number(req.body.startPercent) : undefined;
    const deviceId =
      typeof req.body?.deviceId === 'string' && req.body.deviceId.trim()
        ? req.body.deviceId.trim().slice(0, 80)
        : undefined;

    const summary = store.updateSessionStrategy({
      shareToken: req.params.token,
      blockMode,
      startPercent,
      deviceId,
    });
    res.json(summary);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Failed to save block strategy.',
    });
  }
});

// Lease one or more contiguous 2^29 keyspace blocks (scaled by measured GPU speed)
app.post('/api/sessions/:token/blocks/lease', (req, res) => {
  try {
    if (!checkRateLimit(`lease:${getClientIp(req)}`, 45, 60_000)) {
      res.status(429).json({ error: 'Too many block lease requests. Please wait a moment.' });
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
    });
    res.json({
      block: blocks[0],
      blocks,
      recommendedBatchCount: blocks.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to lease keyspace block.';
    res.status(msg.includes('limit') ? 429 : 404).json({ error: msg });
  }
});

// Keep-alive heartbeat when a block is paused in an open browser tab
app.post('/api/sessions/:token/blocks/:blockId/heartbeat', (req, res) => {
  try {
    const blockId = Number(req.params.blockId);
    const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId : 'unknown';
    const result = store.heartbeatBlock({
      shareToken: req.params.token,
      blockId,
      deviceId,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to refresh block lease.' });
  }
});

// Save checkpoint progress and verified PoW shares inside a leased block
app.post('/api/sessions/:token/blocks/:blockId/checkpoint', (req, res) => {
  try {
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
    });
    res.json({ ok: true, powCount: result.powCount });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save block checkpoint.' });
  }
});

// Mark a leased block as 100% completed (requires verified cryptographic PoW shares)
app.post('/api/sessions/:token/blocks/:blockId/complete', (req, res) => {
  try {
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
    });
    const summary = store.getSessionSummary(req.params.token);
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to complete block.' });
  }
});

// Private mining pool broadcast endpoint (MARA Slipstream + Rebar Shield)
app.post('/api/broadcast-private', async (req, res) => {
  try {
    const rawTxHex = typeof req.body?.rawTxHex === 'string' ? req.body.rawTxHex : '';
    const dryRun = Boolean(req.body?.dryRun);
    const locale = req.body?.locale === 'cs' ? 'cs' : 'en';
    const shareToken = typeof req.body?.shareToken === 'string' ? req.body.shareToken : '';
    const txid = typeof req.body?.txid === 'string' ? req.body.txid : '';
    const userSats = String(req.body?.userSats ?? '0');
    const adminSats = String(req.body?.adminSats ?? '0');
    const feeSats = String(req.body?.feeSats ?? '0');

    const result = await broadcastPrivatePoolTransaction({ rawTxHex, dryRun, locale });

    if (shareToken) {
      store.recordRelaySubmission({
        shareToken,
        txid,
        rawTxHex,
        userSats,
        adminSats,
        feeSats,
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
        const hmrDisabled = process.env.DISABLE_HMR === 'true';
        viteServer = await createViteServer({
          server: {
            middlewareMode: true,
            allowedHosts: true,
            ws: {
              server: httpServer,
              timeout: 15_000,
            },
            hmr: !hmrDisabled,
          },
          appType: 'spa',
        });
      } catch (err) {
        viteInitError = err instanceof Error ? err : new Error(String(err));
        console.error('Vite middleware initialization failed:', viteInitError);
      }
    })();
  }

  const shutdown = async () => {
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
    httpServer.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

startServer().catch((err) => {
  console.error('Failed to start Puzzle71 server:', err);
  process.exit(1);
});
