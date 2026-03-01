/**
 * MCP Service Protocol
 *
 * Defines the interface between frontend and backend for MCP control.
 * This enables the preferences UI to control the MCP server.
 * Also provides real-time notifications for file changes made via MCP.
 */

export const MCPServicePath = '/services/mcp-service';
export const MCPService = Symbol('MCPService');

/**
 * MCP server status information
 */
export interface MCPStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  connectedClients: number;
  uptime: number; // seconds
}

/**
 * File change event from MCP tool execution
 */
export interface MCPFileChangeEvent {
  uri: string;
  type: 'created' | 'modified' | 'deleted';
  source: 'mcp'; // Always 'mcp' for changes via MCP tools
  tool: string;  // The tool that made the change (e.g., 'arduino_sketch')
  timestamp: number;
}

/**
 * MCP Service client interface - implemented by frontend to receive notifications
 */
export const MCPServiceClient = Symbol('MCPServiceClient');
export interface MCPServiceClient {
  /**
   * Called when a file is changed via MCP tools
   */
  onFileChanged(event: MCPFileChangeEvent): void;

  /**
   * Called when MCP server status changes
   */
  onStatusChanged(status: MCPStatus): void;
}

/**
 * Tool exposure mode
 */
export type ToolMode = 'router' | 'direct';

/**
 * MCP Service interface - called from frontend to control backend
 */
export interface MCPService {
  /**
   * Get current MCP server status
   */
  getStatus(): Promise<MCPStatus>;

  /**
   * Enable or disable the MCP server
   */
  setEnabled(enabled: boolean): Promise<void>;

  /**
   * Restart the MCP server (useful after config changes)
   */
  restart(): Promise<void>;

  /**
   * Get the server URL for client configuration
   */
  getServerUrl(): Promise<string>;

  /**
   * Check if MCP server is healthy and accepting connections
   */
  healthCheck(): Promise<boolean>;

  /**
   * Set the tool exposure mode (router or direct)
   */
  setToolMode(mode: ToolMode): Promise<void>;

  /**
   * Set the client to receive notifications (called by frontend)
   */
  setClient(client: MCPServiceClient | undefined): void;
}
