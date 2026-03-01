/**
 * MCP Contribution
 *
 * Manages the embedded MCP server lifecycle.
 * Implements BackendApplicationContribution to hook into IDE startup.
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { ArduinoMCPServer } from './mcp-server';

@injectable()
export class MCPContribution implements BackendApplicationContribution {
  @inject(ArduinoMCPServer)
  private readonly mcpServer!: ArduinoMCPServer;

  // MCP is enabled by default - can be changed via preferences
  private mcpEnabled = true;

  async onStart(): Promise<void> {
    console.log('[arduino-mcp] MCP Contribution starting...');

    // Check environment variable / command line flag
    if (process.env.ARDUINO_MCP_DISABLED === '1') {
      console.log('[arduino-mcp] MCP disabled via environment');
      this.mcpEnabled = false;
      return;
    }

    // Check for auto-start preference (defaults to true)
    const autoStart = process.env.ARDUINO_MCP_AUTOSTART !== '0';
    if (!autoStart) {
      console.log('[arduino-mcp] MCP auto-start disabled');
      this.mcpEnabled = false;
      return;
    }

    try {
      // Start the embedded MCP server
      const port = parseInt(process.env.ARDUINO_MCP_PORT || '3847', 10);
      await this.mcpServer.start(port);

      console.log('[arduino-mcp] Embedded MCP server is ready');
      console.log('[arduino-mcp] The Arduino IDE IS the MCP server - no sidecar needed!');
      console.log('[arduino-mcp] ');
      console.log('[arduino-mcp] To connect Claude Code, add to your settings:');
      console.log('[arduino-mcp] {');
      console.log('[arduino-mcp]   "mcpServers": {');
      console.log('[arduino-mcp]     "arduino": {');
      console.log(`[arduino-mcp]       "url": "http://127.0.0.1:${port}/sse"`);
      console.log('[arduino-mcp]     }');
      console.log('[arduino-mcp]   }');
      console.log('[arduino-mcp] }');
      console.log('[arduino-mcp] ');
    } catch (error) {
      console.error('[arduino-mcp] Failed to start MCP server:', error);
    }
  }

  onStop(): void {
    console.log('[arduino-mcp] MCP Contribution stopping...');
    this.mcpServer.stop().catch((err) => {
      console.error('[arduino-mcp] Error stopping MCP server:', err);
    });
  }

  /**
   * Enable or disable MCP functionality
   */
  async setMCPEnabled(enabled: boolean): Promise<void> {
    if (this.mcpEnabled === enabled) return;

    this.mcpEnabled = enabled;
    if (enabled) {
      await this.mcpServer.start();
    } else {
      await this.mcpServer.stop();
    }
  }

  /**
   * Check if MCP is enabled
   */
  isMCPEnabled(): boolean {
    return this.mcpEnabled;
  }

  /**
   * Get the MCP server port
   */
  getMCPPort(): number {
    return this.mcpServer.getPort();
  }
}
