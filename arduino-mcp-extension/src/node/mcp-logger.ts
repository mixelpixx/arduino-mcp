/**
 * Minimal leveled logger for the MCP backend, honoring the
 * `arduino.mcp.logLevel` preference.
 */

export type MCPLogLevel = 'none' | 'error' | 'info' | 'debug';

const LEVEL_ORDER: Record<MCPLogLevel, number> = {
  none: 0,
  error: 1,
  info: 2,
  debug: 3,
};

class MCPLogger {
  private level: MCPLogLevel = 'info';

  setLevel(level: MCPLogLevel): void {
    if (level in LEVEL_ORDER) {
      this.level = level;
    }
  }

  getLevel(): MCPLogLevel {
    return this.level;
  }

  error(...args: unknown[]): void {
    if (LEVEL_ORDER[this.level] >= LEVEL_ORDER.error) {
      console.error('[arduino-mcp]', ...args);
    }
  }

  info(...args: unknown[]): void {
    if (LEVEL_ORDER[this.level] >= LEVEL_ORDER.info) {
      console.log('[arduino-mcp]', ...args);
    }
  }

  debug(...args: unknown[]): void {
    if (LEVEL_ORDER[this.level] >= LEVEL_ORDER.debug) {
      console.log('[arduino-mcp:debug]', ...args);
    }
  }
}

export const mcpLog = new MCPLogger();
