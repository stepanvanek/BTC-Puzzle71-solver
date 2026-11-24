import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUZZLE_71_ADDRESS = '1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU';

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

const app = express();
const distPath = path.join(__dirname, 'dist');
const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(distPath);
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
  const scriptSrc = isProd ? "script-src 'self'" : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
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

// Fast health check available immediately on socket bind
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, puzzle: 71, targetAddress: PUZZLE_71_ADDRESS });
});

async function startServer() {
  const httpServer = http.createServer(app);

  let routesHandle: { router: express.Router; close: () => void } | null = null;
  let routesInitError: Error | null = null;
  let routesReadyPromise: Promise<void> | null = null;

  let viteServer: { middlewares: express.RequestHandler; close: () => Promise<void> } | null = null;
  let viteInitError: Error | null = null;
  let viteReadyPromise: Promise<void> | null = null;

  // Delegate API and SEO crawler routes to the lazily initialized router
  app.use(async (req, res, next) => {
    const isRouteTarget =
      req.path.startsWith('/api/') || req.path === '/robots.txt' || req.path === '/sitemap.xml';
    if (!isRouteTarget) {
      next();
      return;
    }
    if (routesReadyPromise) {
      await routesReadyPromise;
    }
    if (routesInitError) {
      next(routesInitError);
      return;
    }
    if (routesHandle) {
      routesHandle.router(req, res, next);
      return;
    }
    next();
  });

  // Ensure /api/* errors always return JSON rather than Express HTML error pages
  app.use('/api', (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Unexpected API server error.';
    res.status(500).json({ error: message });
  });

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

  // Bind HTTP port immediately so platform health probes succeed before heavy imports/Vite init
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PORT, HOST, () => {
      console.log(`Puzzle71 server running on http://localhost:${PORT}`);
      resolve();
    });
  });

  routesReadyPromise = (async () => {
    try {
      const envPath = path.join(__dirname, '.env');
      if (fs.existsSync(envPath)) {
        const dotenv = await import('dotenv');
        dotenv.config({ path: envPath });
      }
      const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'puzzle71.db');
      const { createAppRoutes } = await import('./server/routes.ts');
      routesHandle = createAppRoutes({ dbPath, rootDir: __dirname, port: PORT });
    } catch (err) {
      routesInitError = err instanceof Error ? err : new Error(String(err));
      console.error('API routes initialization failed:', routesInitError);
    }
  })();

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
                        'let wsTransport = { async connect() {}, disconnect() {}, send() {} };',
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
      routesHandle?.close();
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
