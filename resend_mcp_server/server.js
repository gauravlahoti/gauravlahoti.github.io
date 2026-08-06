const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;
const MCP_PORT = 3001;
const MCP_HOST = '127.0.0.1';
// Server-side API key. When set, the proxy auto-injects the Authorization
// header so clients don't need to know or carry the Resend key. Wired via
// Secret Manager: --update-secrets RESEND_API_KEY=resend-api-key:latest.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
// Caller authentication token. When set, every inbound request must carry
// `Authorization: Bearer <MCP_CALLER_TOKEN>` or it gets a 401.
// Set via Secret Manager: --update-secrets MCP_CALLER_TOKEN=resend-mcp-caller-token:latest
const MCP_CALLER_TOKEN = (process.env.MCP_CALLER_TOKEN || '').trim();

// Readiness gate. Cloud Run's default startup probe is a TCP check on PORT, so
// the moment we bind PORT is the moment live traffic starts arriving. The MCP
// server we proxy to takes anywhere from ~3s to ~25s to come up, depending on
// how much CPU the instance gets. Binding on a fixed timer is therefore a coin
// flip: lose it and Cloud Run routes real requests into a proxy whose upstream
// is still down, which reaches visitors as "the email couldn't be sent".
// So poll the upstream and bind only once it answers. Cloud Run queues inbound
// requests until the port is listening, so a cold caller waits a few extra
// seconds instead of getting a 502.
const READY_POLL_MS = 250;
const READY_TIMEOUT_MS = 60_000;

console.log(`Starting Resend MCP proxy server...`);
console.log(`External port: ${PORT}, Internal MCP port: ${MCP_PORT}`);
console.log(`Server-side API key: ${RESEND_API_KEY ? 'configured' : 'not set (clients must supply Authorization header)'}`);
console.log(`Caller auth gate: ${MCP_CALLER_TOKEN ? 'enabled' : 'DISABLED — set MCP_CALLER_TOKEN to require bearer auth'}`);

// Resolve the MCP entrypoint from the local install rather than shelling out to
// `npx -y resend-mcp`, which can hit the npm registry on every cold boot.
function resolveMcpEntry() {
  try {
    return require.resolve('resend-mcp/dist/index.js');
  } catch {
    return path.join(__dirname, 'node_modules', 'resend-mcp', 'dist', 'index.js');
  }
}

const mcpEntry = resolveMcpEntry();
console.log(`MCP entrypoint: ${mcpEntry}`);

// Start the resend-mcp server internally
const mcpProcess = spawn(process.execPath, [mcpEntry, '--http', '--port', MCP_PORT.toString()], {
  stdio: 'inherit',
  env: process.env
});

mcpProcess.on('error', (err) => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
});

// If the upstream dies after boot, take the instance down with it. Staying up
// would mean serving 502s from a proxy that can never recover; exiting lets
// Cloud Run replace the instance.
mcpProcess.on('exit', (code, signal) => {
  console.error(`MCP_UPSTREAM_UNAVAILABLE upstream exited (code=${code} signal=${signal}); shutting down`);
  process.exit(1);
});

// One probe of the upstream. Deliberately an HTTP request rather than a bare TCP
// connect: a socket that merely accepts proves something is on the port, not
// that the MCP server is up and serving. Any HTTP status back means a real HTTP
// server answered, which is what we actually need before binding PORT. The
// endpoint is expected to reject a bare GET (400/405/406) — that still counts.
function probeUpstream() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: MCP_HOST, port: MCP_PORT, path: '/mcp', method: 'GET', timeout: 1000 },
      (res) => {
        res.resume();  // drain so the socket can be reused/closed cleanly
        resolve(true);
      }
    );
    const fail = () => {
      req.destroy();
      resolve(false);
    };
    req.once('error', fail);
    req.once('timeout', fail);
    req.end();
  });
}

async function waitForUpstream() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeUpstream()) return true;
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  return false;
}

const server = http.createServer((req, res) => {
  // Readiness probe. Deliberately ahead of the auth gate so it works as an
  // unauthenticated warm target — it discloses a boolean and nothing else.
  if (req.method === 'GET' && (req.url === '/healthz' || req.url.startsWith('/healthz?'))) {
    probeUpstream().then((ok) => {
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, upstream: ok ? 'ready' : 'unavailable' }));
    });
    return;
  }

  // Caller auth gate: reject requests that don't carry the expected bearer token.
  if (MCP_CALLER_TOKEN) {
    const incoming = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (incoming !== MCP_CALLER_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  const headers = {
    ...req.headers,
    host: `${MCP_HOST}:${MCP_PORT}`  // Override host to localhost
  };
  // Swap the caller's token out for the Resend API key before proxying.
  // The internal MCP server expects RESEND_API_KEY as its Authorization header.
  if (RESEND_API_KEY) {
    headers.authorization = `Bearer ${RESEND_API_KEY}`;
  } else {
    delete headers.authorization;
  }
  const options = {
    hostname: MCP_HOST,
    port: MCP_PORT,
    path: req.url,
    method: req.method,
    headers
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  // Backstop only — the readiness gate means we should never bind before the
  // upstream is up. The marker is what the Cloud Monitoring alert matches on.
  proxyReq.on('error', (err) => {
    console.error('MCP_UPSTREAM_UNAVAILABLE proxy error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
  });

  req.pipe(proxyReq);
});

waitForUpstream().then((ready) => {
  if (!ready) {
    // Fail loudly rather than binding and serving 502s forever.
    console.error(
      `MCP_UPSTREAM_UNAVAILABLE upstream never came up on ${MCP_HOST}:${MCP_PORT} ` +
      `within ${READY_TIMEOUT_MS}ms; exiting`
    );
    process.exit(1);
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Upstream ready. Proxy server listening on port ${PORT}`);
    console.log(`Forwarding to internal MCP server on port ${MCP_PORT}`);
  });
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  mcpProcess.removeAllListeners('exit');
  mcpProcess.kill();
  process.exit(0);
});
