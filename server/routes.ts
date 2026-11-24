import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { SITEMAP_TAB_PAIRS, pathnameForTab } from '../src/i18n/locale.ts';
import { validateBitcoinAddress } from '../src/shared/btcAddress.ts';
import { verifySignedPuzzleTx } from '../src/shared/btcTx.ts';
import {
  ADMIN_PAYOUT_ADDRESS,
  PUZZLE_71_HASH160_HEX,
  getRecommendedBatchBlockCount,
} from '../src/shared/puzzle71.ts';
import { Puzzle71Store } from './db.ts';
import { broadcastPrivatePoolTransaction, fetchPuzzle71NetworkInfo } from './privateRelay.ts';

export interface AppRoutesHandle {
  router: express.Router;
  close: () => void;
}

export function createAppRoutes(options: {
  dbPath: string;
  rootDir: string;
  port: number;
}): AppRoutesHandle {
  const { dbPath, rootDir, port } = options;
  const store = new Puzzle71Store(dbPath);
  const router = express.Router();

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
    const safeHost = /^[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(rawHost) ? rawHost : `localhost:${port}`;
    return `${proto}://${safeHost}`;
  }

  router.get('/robots.txt', (req, res) => {
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

  router.get('/sitemap.xml', (req, res) => {
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

  // Live Puzzle #71 UTXO & recommended fee rates
  router.get('/api/puzzle71/network', async (_req, res) => {
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
  router.get('/api/leaderboard', (req, res) => {
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
  router.post('/api/sessions', (req, res) => {
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
  router.get('/api/sessions/:token', (req, res) => {
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
  router.patch('/api/sessions/:token/strategy', (req, res) => {
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
  router.post('/api/sessions/:token/blocks/lease', (req, res) => {
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
  router.post('/api/sessions/:token/blocks/:blockId/heartbeat', (req, res) => {
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
  router.post('/api/sessions/:token/blocks/:blockId/checkpoint', (req, res) => {
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
  router.post('/api/sessions/:token/blocks/:blockId/complete', (req, res) => {
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
  router.post('/api/broadcast-private', async (req, res) => {
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

      let resolvedBtcAddress: string | null = null;
      const sqliteSession = shareToken ? store.getSessionByToken(shareToken) : null;
      if (sqliteSession) {
        resolvedBtcAddress = sqliteSession.btc_address;
      } else if (shareToken && /^[A-Za-z0-9_-]{20,64}$/.test(shareToken)) {
        const fbConfigPath = path.join(rootDir, 'firebase-applet-config.json');
        if (fs.existsSync(fbConfigPath)) {
          try {
            const fbConfig = JSON.parse(fs.readFileSync(fbConfigPath, 'utf8')) as {
              projectId?: string;
              firestoreDatabaseId?: string;
              apiKey?: string;
            };
            if (fbConfig.projectId && fbConfig.firestoreDatabaseId && fbConfig.apiKey) {
              const docUrl =
                `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(fbConfig.projectId)}` +
                `/databases/${encodeURIComponent(fbConfig.firestoreDatabaseId)}` +
                `/documents/share_tokens/${encodeURIComponent(shareToken)}?key=${encodeURIComponent(fbConfig.apiKey)}`;
              const fbRes = await fetch(docUrl);
              if (fbRes.ok) {
                const fbDoc = (await fbRes.json()) as {
                  fields?: { btcAddress?: { stringValue?: string } };
                };
                const addr = fbDoc.fields?.btcAddress?.stringValue;
                if (addr) {
                  resolvedBtcAddress = addr;
                }
              }
            }
          } catch {
            // fallback error handled below if !dryRun
          }
        }
      }

      if (!dryRun && !resolvedBtcAddress) {
        res.status(401).json({
          error:
            locale === 'cs'
              ? 'Pro skutečné privátní odeslání transakce je vyžadována platná aktivní relace.'
              : 'A valid active session token is required for live private pool submission.',
        });
        return;
      }

      let expectedUserScript: Uint8Array | undefined;
      if (resolvedBtcAddress) {
        const userParsed = validateBitcoinAddress(resolvedBtcAddress, locale);
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

      if (sqliteSession) {
        store.recordRelaySubmission({
          shareToken: sqliteSession.share_token,
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

  return {
    router,
    close: () => {
      store.close();
    },
  };
}
