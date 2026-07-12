#!/usr/bin/env node
/**
 * Arduino MCP Server smoke test (manual).
 *
 * Run the Arduino IDE, then:
 *   node test/manual/smoke-test.js
 *
 * The auth token is read from the ARDUINO_MCP_TOKEN environment variable or
 * from ~/.arduinoIDE/mcp-token. Uses only built-in Node.js modules.
 *
 * Verifies:
 *   1. /health responds
 *   2. Requests without the token are rejected (401)
 *   3. Requests with a browser Origin header are rejected (403)
 *   4. A Streamable HTTP session can be initialized at /mcp
 *   5. tools/list returns the router meta-tools
 *   6. execute_tool(arduino_context) returns IDE state
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.ARDUINO_MCP_PORT || '3847', 10);

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let failures = 0;
function pass(msg) {
  console.log(`${GREEN}[PASS]${RESET} ${msg}`);
}
function fail(msg) {
  failures++;
  console.log(`${RED}[FAIL]${RESET} ${msg}`);
}
function info(msg) {
  console.log(`${YELLOW}[INFO]${RESET} ${msg}`);
}

function readToken() {
  if (process.env.ARDUINO_MCP_TOKEN) {
    return process.env.ARDUINO_MCP_TOKEN.trim();
  }
  try {
    return fs
      .readFileSync(path.join(os.homedir(), '.arduinoIDE', 'mcp-token'), 'utf8')
      .trim();
  } catch {
    return null;
  }
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, ...options },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/** Extracts the JSON-RPC payload from a JSON or SSE-formatted response body. */
function parsePayload(response) {
  const contentType = response.headers['content-type'] || '';
  if (contentType.includes('text/event-stream')) {
    for (const line of response.body.split('\n')) {
      if (line.startsWith('data:')) {
        return JSON.parse(line.slice(5).trim());
      }
    }
    throw new Error('No data event in SSE response');
  }
  return JSON.parse(response.body);
}

async function mcpRequest(token, sessionId, payload) {
  const response = await request(
    {
      method: 'POST',
      path: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
    },
    JSON.stringify(payload)
  );
  return response;
}

async function main() {
  info(`Target: http://${HOST}:${PORT}`);

  // 1. Health
  const health = await request({ method: 'GET', path: '/health' });
  if (health.status === 200 && JSON.parse(health.body).status === 'ok') {
    const parsed = JSON.parse(health.body);
    pass(`health: server ${parsed.server} v${parsed.version} (auth: ${parsed.auth})`);
  } else {
    fail(`health returned ${health.status}. Is the Arduino IDE running?`);
    process.exit(1);
  }

  const authEnabled = JSON.parse(health.body).auth;
  const token = readToken();
  if (authEnabled && !token) {
    fail(
      'Auth is enabled but no token found (~/.arduinoIDE/mcp-token or ARDUINO_MCP_TOKEN)'
    );
    process.exit(1);
  }

  // 2. Unauthorized request rejected
  if (authEnabled) {
    const unauthorized = await request(
      {
        method: 'POST',
        path: '/mcp',
        headers: { 'Content-Type': 'application/json' },
      },
      '{}'
    );
    if (unauthorized.status === 401) {
      pass('request without token rejected with 401');
    } else {
      fail(`request without token returned ${unauthorized.status} (expected 401)`);
    }
  } else {
    info('auth disabled; skipping 401 check');
  }

  // 3. Browser Origin rejected
  const browserish = await request({
    method: 'GET',
    path: '/health',
    headers: { Origin: 'https://evil.example' },
  });
  if (browserish.status === 403) {
    pass('request with browser Origin rejected with 403');
  } else {
    fail(`request with Origin returned ${browserish.status} (expected 403)`);
  }

  // 4. Initialize a Streamable HTTP session
  const initResponse = await mcpRequest(token, undefined, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    },
  });
  const sessionId = initResponse.headers['mcp-session-id'];
  if (initResponse.status === 200 && sessionId) {
    const initPayload = parsePayload(initResponse);
    pass(
      `initialized session ${sessionId} (server: ${initPayload.result?.serverInfo?.name})`
    );
  } else {
    fail(`initialize failed with status ${initResponse.status}: ${initResponse.body}`);
    process.exit(1);
  }

  await mcpRequest(token, sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  // 5. tools/list
  const toolsResponse = await mcpRequest(token, sessionId, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  });
  const tools = parsePayload(toolsResponse).result?.tools ?? [];
  if (tools.length > 0) {
    pass(`tools/list returned ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);
  } else {
    fail('tools/list returned no tools');
  }

  // 6. arduino_context via execute_tool (router mode) or directly
  const isRouter = tools.some((t) => t.name === 'execute_tool');
  const contextResponse = await mcpRequest(token, sessionId, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: isRouter
      ? {
          name: 'execute_tool',
          arguments: { tool_name: 'arduino_context', params: {} },
        }
      : { name: 'arduino_context', arguments: {} },
  });
  const contextPayload = parsePayload(contextResponse);
  const text = contextPayload.result?.content?.[0]?.text;
  if (text && JSON.parse(text).connected === true) {
    pass('arduino_context returned IDE state:');
    console.log(text);
  } else {
    fail(`arduino_context failed: ${JSON.stringify(contextPayload)}`);
  }

  console.log();
  if (failures) {
    fail(`${failures} check(s) failed`);
    process.exit(1);
  }
  pass('All checks passed');
}

main().catch((err) => {
  fail(`Unexpected error: ${err.message}`);
  process.exit(1);
});
