/**
 * MCP Service Implementation
 *
 * Backend implementation of MCPService that bridges frontend preferences
 * to the embedded MCP server control. Also handles real-time notifications
 * for file changes made via MCP tools.
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { MCPService, MCPStatus, MCPServiceClient, MCPFileChangeEvent, ToolMode } from '../common/mcp-service';
import { ArduinoMCPServer } from './mcp-server';

@injectable()
export class MCPServiceImpl implements MCPService {
  @inject(ArduinoMCPServer)
  private readonly mcpServer!: ArduinoMCPServer;

  private client: MCPServiceClient | undefined;

  async getStatus(): Promise<MCPStatus> {
    return this.mcpServer.getStatus();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      if (!this.mcpServer.isServerRunning()) {
        await this.mcpServer.start();
        console.log('[arduino-mcp] MCP server enabled via preferences');
        this.notifyStatusChanged();
      }
    } else {
      if (this.mcpServer.isServerRunning()) {
        await this.mcpServer.stop();
        console.log('[arduino-mcp] MCP server disabled via preferences');
        this.notifyStatusChanged();
      }
    }
  }

  async restart(): Promise<void> {
    if (this.mcpServer.isServerRunning()) {
      await this.mcpServer.stop();
    }
    await this.mcpServer.start();
    console.log('[arduino-mcp] MCP server restarted');
    this.notifyStatusChanged();
  }

  async getServerUrl(): Promise<string> {
    const port = this.mcpServer.getPort();
    return `http://127.0.0.1:${port}/sse`;
  }

  async healthCheck(): Promise<boolean> {
    return this.mcpServer.isServerRunning();
  }

  async setToolMode(mode: ToolMode): Promise<void> {
    this.mcpServer.setToolMode(mode);
    console.log(`[arduino-mcp] Tool mode set to: ${mode}`);
  }

  setClient(client: MCPServiceClient | undefined): void {
    this.client = client;
    // Register this service with the MCP server for file change notifications
    this.mcpServer.setFileChangeCallback((event) => this.notifyFileChanged(event));
  }

  /**
   * Notify the frontend client of a file change
   */
  notifyFileChanged(event: MCPFileChangeEvent): void {
    if (this.client) {
      try {
        this.client.onFileChanged(event);
      } catch (error) {
        console.error('[arduino-mcp] Error notifying client of file change:', error);
      }
    }
  }

  /**
   * Notify the frontend client of a status change
   */
  private notifyStatusChanged(): void {
    if (this.client) {
      try {
        this.client.onStatusChanged(this.mcpServer.getStatus());
      } catch (error) {
        console.error('[arduino-mcp] Error notifying client of status change:', error);
      }
    }
  }
}
