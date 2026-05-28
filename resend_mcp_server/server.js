const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;
const MCP_PORT = 3001;
// Server-side API key. When set, the proxy auto-injects the Authorization
// header so clients don't need to know or carry the Resend key. Wired via
// Secret Manager: --update-secrets RESEND_API_KEY=resend-api-key:latest.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
// Caller authentication token. When set, every inbound request must carry
// `Authorization: Bearer <MCP_CALLER_TOKEN>` or it gets a 401.
// Set via Secret Manager: --update-secrets MCP_CALLER_TOKEN=resend-mcp-caller-token:latest
const MCP_CALLER_TOKEN = process.env.MCP_CALLER_TOKEN || '';

console.log(`Starting Resend MCP proxy server...`);
console.log(`External port: ${PORT}, Internal MCP port: ${MCP_PORT}`);
console.log(`Server-side API key: ${RESEND_API_KEY ? 'configured' : 'not set (clients must supply Authorization header)'}`);
console.log(`Caller auth gate: ${MCP_CALLER_TOKEN ? 'enabled' : 'DISABLED — set MCP_CALLER_TOKEN to require bearer auth'}`);

// Start the resend-mcp server internally
const mcpProcess = spawn('npx', ['-y', 'resend-mcp', '--http', '--port', MCP_PORT.toString()], {
  stdio: 'inherit',
  env: process.env
});

mcpProcess.on('error', (err) => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
});

// Wait for MCP server to start, then create proxy
setTimeout(() => {
  const server = http.createServer((req, res) => {
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
      host: `127.0.0.1:${MCP_PORT}`  // Override host to localhost
    };
    // Swap the caller's token out for the Resend API key before proxying.
    // The internal MCP server expects RESEND_API_KEY as its Authorization header.
    if (RESEND_API_KEY) {
      headers.authorization = `Bearer ${RESEND_API_KEY}`;
    } else {
      delete headers.authorization;
    }
    const options = {
      hostname: '127.0.0.1',
      port: MCP_PORT,
      path: req.url,
      method: req.method,
      headers
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
    });

    req.pipe(proxyReq);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy server listening on port ${PORT}`);
    console.log(`Forwarding to internal MCP server on port ${MCP_PORT}`);
  });
}, 3000);

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  mcpProcess.kill();
  process.exit(0);
});
