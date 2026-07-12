/**
 * MCP Service Implementation
 *
 * Backend implementation of MCPService that bridges frontend preferences
 * to the embedded MCP server control. Also handles real-time notifications
 * for file changes made via MCP tools, and receives IDE state (current
 * sketch, board/port selection) pushed from the frontend.
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import {
  MCPService,
  MCPStatus,
  MCPServiceClient,
  MCPFileChangeEvent,
  MCPIDEState,
  ToolMode,
} from '../common/mcp-service';
import { ArduinoMCPServer } from './mcp-server';
import { mcpLog } from './mcp-logger';

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
        mcpLog.info('MCP server enabled via preferences');
        this.notifyStatusChanged();
      }
    } else {
      if (this.mcpServer.isServerRunning()) {
        await this.mcpServer.stop();
        mcpLog.info('MCP server disabled via preferences');
        this.notifyStatusChanged();
      }
    }
  }

  async restart(): Promise<void> {
    if (this.mcpServer.isServerRunning()) {
      await this.mcpServer.stop();
    }
    await this.mcpServer.start();
    mcpLog.info('MCP server restarted');
    this.notifyStatusChanged();
  }

  async setPort(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`Invalid port: ${port}`);
    }
    if (this.mcpServer.getPort() === port && this.mcpServer.isServerRunning()) {
      return;
    }
    if (this.mcpServer.isServerRunning()) {
      await this.mcpServer.stop();
    }
    await this.mcpServer.start(port);
    mcpLog.info(`MCP server moved to port ${port}`);
    this.notifyStatusChanged();
  }

  async getServerUrl(): Promise<string> {
    const port = this.mcpServer.getPort();
    return `http://127.0.0.1:${port}/mcp`;
  }

  async getClientConfig(): Promise<string> {
    return this.mcpServer.buildClientConfig();
  }

  async healthCheck(): Promise<boolean> {
    return this.mcpServer.isServerRunning();
  }

  async setToolMode(mode: ToolMode): Promise<void> {
    this.mcpServer.setToolMode(mode);
  }

  async updateIDEState(state: MCPIDEState): Promise<void> {
    this.mcpServer.setIDEState(state);
  }

  setClient(client: MCPServiceClient | undefined): void {
    this.client = client;
    // Register this service with the MCP server for file change notifications
    this.mcpServer.setFileChangeCallback((event) =>
      this.notifyFileChanged(event)
    );
  }

  /**
   * Notify the frontend client of a file change
   */
  notifyFileChanged(event: MCPFileChangeEvent): void {
    if (this.client) {
      try {
        this.client.onFileChanged(event);
      } catch (error) {
        mcpLog.error('Error notifying client of file change:', error);
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
        mcpLog.error('Error notifying client of status change:', error);
      }
    }
  }
}
