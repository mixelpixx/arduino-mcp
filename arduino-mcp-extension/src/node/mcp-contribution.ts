/**
 * MCP Contribution
 *
 * Manages the embedded MCP server lifecycle.
 * Implements BackendApplicationContribution to hook into IDE startup.
 *
 * Startup configuration is resolved in this order:
 *   1. Environment variables (ARDUINO_MCP_DISABLED, ARDUINO_MCP_AUTOSTART,
 *      ARDUINO_MCP_PORT, ARDUINO_MCP_NO_AUTH)
 *   2. IDE preferences persisted in ~/.arduinoIDE/settings.json
 *      (arduino.mcp.enabled, arduino.mcp.autoConnect, arduino.mcp.port,
 *       arduino.mcp.logLevel, arduino.mcp.toolMode, arduino.mcp.requireAuth)
 *   3. Built-in defaults.
 */

import { injectable, inject, optional } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { SettingsReader } from 'arduino-ide-extension/lib/node/settings-reader';
import { ArduinoMCPServer } from './mcp-server';
import { mcpLog, MCPLogLevel } from './mcp-logger';

interface MCPStartupSettings {
  enabled: boolean;
  autoStart: boolean;
  port: number;
  logLevel: MCPLogLevel;
  toolMode: 'router' | 'direct';
  requireAuth: boolean;
}

const DEFAULTS: MCPStartupSettings = {
  enabled: true,
  autoStart: true,
  port: 3847,
  logLevel: 'info',
  toolMode: 'router',
  requireAuth: true,
};

@injectable()
export class MCPContribution implements BackendApplicationContribution {
  @inject(ArduinoMCPServer)
  private readonly mcpServer!: ArduinoMCPServer;

  @inject(SettingsReader)
  @optional()
  private readonly settingsReader?: SettingsReader;

  private mcpEnabled = true;

  async onStart(): Promise<void> {
    const settings = await this.resolveStartupSettings();
    mcpLog.setLevel(settings.logLevel);
    this.mcpServer.setToolMode(settings.toolMode);
    this.mcpServer.setRequireAuth(settings.requireAuth);

    if (!settings.enabled) {
      mcpLog.info('MCP disabled via preferences/environment');
      this.mcpEnabled = false;
      return;
    }
    if (!settings.autoStart) {
      mcpLog.info(
        'MCP auto-start disabled; enable it from the IDE preferences'
      );
      this.mcpEnabled = false;
      return;
    }

    try {
      await this.mcpServer.start(settings.port);
      mcpLog.info('Embedded MCP server is ready');
    } catch (error) {
      mcpLog.error('Failed to start MCP server:', error);
    }
  }

  onStop(): void {
    mcpLog.info('MCP Contribution stopping...');
    this.mcpServer.stop().catch((err) => {
      mcpLog.error('Error stopping MCP server:', err);
    });
  }

  private async resolveStartupSettings(): Promise<MCPStartupSettings> {
    const settings = { ...DEFAULTS };

    // Preferences persisted by the IDE frontend.
    try {
      const persisted = (await this.settingsReader?.read()) ?? {};
      const bool = (key: string, fallback: boolean): boolean =>
        typeof persisted[key] === 'boolean'
          ? (persisted[key] as boolean)
          : fallback;
      settings.enabled = bool('arduino.mcp.enabled', settings.enabled);
      settings.autoStart = bool('arduino.mcp.autoConnect', settings.autoStart);
      settings.requireAuth = bool(
        'arduino.mcp.requireAuth',
        settings.requireAuth
      );
      const port = Number(persisted['arduino.mcp.port']);
      if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
        settings.port = port;
      }
      const logLevel = persisted['arduino.mcp.logLevel'];
      if (
        logLevel === 'none' ||
        logLevel === 'error' ||
        logLevel === 'info' ||
        logLevel === 'debug'
      ) {
        settings.logLevel = logLevel;
      }
      const toolMode = persisted['arduino.mcp.toolMode'];
      if (toolMode === 'router' || toolMode === 'direct') {
        settings.toolMode = toolMode;
      }
    } catch (error) {
      mcpLog.error('Could not read persisted MCP preferences:', error);
    }

    // Environment variable overrides.
    if (process.env.ARDUINO_MCP_DISABLED === '1') {
      settings.enabled = false;
    }
    if (process.env.ARDUINO_MCP_AUTOSTART === '0') {
      settings.autoStart = false;
    }
    const envPort = parseInt(process.env.ARDUINO_MCP_PORT || '', 10);
    if (Number.isInteger(envPort) && envPort >= 1024 && envPort <= 65535) {
      settings.port = envPort;
    }
    if (process.env.ARDUINO_MCP_NO_AUTH === '1') {
      settings.requireAuth = false;
    }

    return settings;
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

  isMCPEnabled(): boolean {
    return this.mcpEnabled;
  }

  getMCPPort(): number {
    return this.mcpServer.getPort();
  }
}
