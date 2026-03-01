#!/usr/bin/env node
/**
 * MCP Client Test - Tests the Arduino MCP server endpoints
 */

const http = require('http');
const EventSource = require('eventsource');

const SERVER = 'http://127.0.0.1:3847';

// Colors
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function log(color, prefix, message) {
  console.log(`${color}[${prefix}]${RESET} ${message}`);
}

async function testMCPConnection() {
  log(CYAN, 'TEST', 'Starting MCP client test...\n');

  // Test 1: Health check
  log(YELLOW, 'TEST', '1. Health check');
  try {
    const health = await fetch(`${SERVER}/health`);
    const data = await health.json();
    if (data.status === 'ok') {
      log(GREEN, 'PASS', `Server: ${data.server} v${data.version}`);
      log(GREEN, 'PASS', `Services: ${JSON.stringify(data.services)}`);
    } else {
      log(RED, 'FAIL', 'Health check failed');
      process.exit(1);
    }
  } catch (err) {
    log(RED, 'FAIL', `Health check error: ${err.message}`);
    process.exit(1);
  }

  console.log();

  // Test 2: SSE Connection and MCP Protocol
  log(YELLOW, 'TEST', '2. SSE Connection + MCP Protocol');

  return new Promise((resolve) => {
    const es = new EventSource(`${SERVER}/sse`);
    let messageUrl = null;
    let testsPassed = 0;

    es.onopen = () => {
      log(GREEN, 'PASS', 'SSE connection opened');
    };

    es.addEventListener('endpoint', async (event) => {
      messageUrl = event.data;
      log(GREEN, 'PASS', `Got message endpoint: ${messageUrl}`);

      // Now send MCP requests
      console.log();
      log(YELLOW, 'TEST', '3. MCP tools/list request');

      try {
        const response = await fetch(`${SERVER}${messageUrl}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {}
          })
        });

        if (response.ok) {
          log(GREEN, 'PASS', 'tools/list request sent successfully');
          testsPassed++;
        } else {
          const text = await response.text();
          log(RED, 'FAIL', `tools/list failed: ${text}`);
        }
      } catch (err) {
        log(RED, 'FAIL', `tools/list error: ${err.message}`);
      }
    });

    es.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.result && data.result.tools) {
          log(GREEN, 'PASS', `Received ${data.result.tools.length} tools:`);
          data.result.tools.forEach(tool => {
            console.log(`       - ${tool.name}`);
          });
          testsPassed++;

          // Test 4: Call arduino_context
          console.log();
          log(YELLOW, 'TEST', '4. Call arduino_context tool');

          fetch(`${SERVER}${messageUrl}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: {
                name: 'arduino_context',
                arguments: {}
              }
            })
          }).catch(err => log(RED, 'FAIL', `Context call error: ${err.message}`));

        } else if (data.id === 2) {
          // Response from arduino_context
          if (data.result && data.result.content) {
            const content = JSON.parse(data.result.content[0].text);
            log(GREEN, 'PASS', 'arduino_context response:');
            console.log(`       Connected: ${content.connected}`);
            console.log(`       Transport: ${content.transport}`);
            console.log(`       Open sketch: ${content.open_sketch ? content.open_sketch.name : 'none'}`);
            console.log(`       Connected boards: ${content.connected_boards?.length || 0}`);
            testsPassed++;

            // All tests done
            console.log();
            log(CYAN, 'DONE', `All tests completed! (${testsPassed}/3 passed)`);
            es.close();
            resolve(testsPassed >= 3);
          } else if (data.error) {
            log(RED, 'FAIL', `arduino_context error: ${data.error.message}`);
            es.close();
            resolve(false);
          }
        }
      } catch (err) {
        log(YELLOW, 'INFO', `Raw message: ${event.data}`);
      }
    });

    es.onerror = (err) => {
      log(RED, 'ERROR', `SSE error: ${err.message || 'connection error'}`);
      es.close();
      resolve(false);
    };

    // Timeout after 10 seconds
    setTimeout(() => {
      log(YELLOW, 'TIMEOUT', 'Test timed out');
      es.close();
      resolve(testsPassed >= 2);
    }, 10000);
  });
}

// Check if eventsource is available
try {
  require('eventsource');
} catch {
  console.log('Installing eventsource package...');
  require('child_process').execSync('npm install eventsource --no-save', {
    cwd: '/home/chris/MCP/arduino-mcp/arduino-ide-main/arduino-mcp-extension',
    stdio: 'inherit'
  });
}

testMCPConnection().then(success => {
  process.exit(success ? 0 : 1);
});
