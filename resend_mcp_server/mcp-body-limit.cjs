// Preloaded into the resend-mcp child process (node --require, see server.js).
//
// resend-mcp builds its HTTP server with @modelcontextprotocol/express, which
// calls express.json() without a limit, so Express's 100 KB default applies.
// Pulse's digest (spec 84) sends its charts as inline attachments and the
// request is ~0.5 MB, which came back 413 Request Entity Too Large. The MCP
// library has a jsonLimit option, but resend-mcp doesn't pass it through.
//
// This wraps express.json() before resend-mcp loads, adding a limit when the
// caller set none. It lives in our code, not a patch to node_modules, so a
// resend-mcp upgrade keeps it. If an upgrade stops honouring it, sends over
// 100 KB fail with 413 again, and Pulse retries without its charts.
const express = require('express');

const LIMIT = process.env.MCP_JSON_LIMIT || '5mb';
const original = express.json;

express.json = function json(options = {}) {
  return original({ ...options, limit: options.limit || LIMIT });
};
