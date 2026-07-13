/**
 * MCP Serial Manager
 *
 * Real serial-monitor support for the MCP server. The IDE's `MonitorService`
 * (node side) exposes each running pluggable monitor through a local WebSocket:
 * board output is flushed to WS clients as JSON arrays of string chunks, and
 * clients send data / settings changes as `{ command, data }` messages.
 *
 * The MCP server connects to that WebSocket exactly like the IDE frontend does.
 * This keeps the monitor alive (it disposes itself when the last client leaves)
 * and lets MCP read and write while the IDE's own serial monitor stays usable.
 */

import WebSocket from 'ws';
import type { MonitorManager } from 'arduino-ide-extension/lib/node/monitor-manager';
import type {
  BoardsService,
  Port,
} from 'arduino-ide-extension/lib/common/protocol/boards-service';
import { Monitor } from 'arduino-ide-extension/lib/common/protocol/monitor-service';

export const SUPPORTED_BAUD_RATES = [
  300, 600, 750, 1200, 2400, 4800, 9600, 19200, 31250, 38400, 57600, 74880,
  115200, 230400, 250000, 460800, 500000, 921600, 1000000, 2000000,
] as const;

const MAX_BUFFER_CHARS = 512 * 1024; // cap the capture buffer at 512 KB

interface ActiveConnection {
  board: { name: string; fqbn: string };
  port: Port;
  baudRate: number;
  ws: WebSocket;
  buffer: string;
  connected: boolean;
}

export class MCPSerialManager {
  private connection: ActiveConnection | null = null;

  constructor(
    private readonly monitorManager: () => MonitorManager,
    private readonly boardsService: () => BoardsService
  ) {}

  async connect(
    portAddress: string,
    baudRate: number,
    fqbnOverride?: string
  ): Promise<{ port: string; baudRate: number; board: string; fqbn: string }> {
    if (this.connection?.connected) {
      if (this.connection.port.address === portAddress) {
        return this.statusForResult();
      }
      throw new Error(
        `Already connected to ${this.connection.port.address}. Use the disconnect action first.`
      );
    }

    const detectedPorts = await this.boardsService().getDetectedPorts();
    // The IDE extension ships no type declarations; treat entries as untyped.
    const detectedEntries = Object.values(detectedPorts) as any[];
    const entry = detectedEntries.find(
      (dp) => dp.port.address === portAddress
    );
    if (!entry) {
      const known = detectedEntries
        .map((dp) => dp.port.address)
        .join(', ');
      throw new Error(
        `Port not found: ${portAddress}. Detected ports: ${known || '(none)'}`
      );
    }

    const detectedBoard = entry.boards?.[0] as
      | { name?: string; fqbn?: string }
      | undefined;
    const fqbn = fqbnOverride ?? detectedBoard?.fqbn;
    if (!fqbn) {
      throw new Error(
        `Cannot identify the board on ${portAddress}. Pass an explicit fqbn (e.g. arduino:avr:uno).`
      );
    }
    const board = { name: detectedBoard?.name ?? 'Unknown board', fqbn };
    const port = entry.port;
    const manager = this.monitorManager();

    // `changeMonitorSettings` only applies settings when it creates the monitor
    // service, so set the baud rate before starting it.
    manager.changeMonitorSettings(board, port, {
      baudrate: {
        id: 'baudrate',
        label: 'Baudrate',
        type: 'enum',
        values: SUPPORTED_BAUD_RATES.map(String),
        selectedValue: String(baudRate),
      },
    });

    await manager.startMonitor(board, port, async () => {
      const wsPort = manager.getWebsocketAddressPort(board, port);
      if (wsPort <= 0) {
        throw new Error('Monitor WebSocket is not available');
      }
      await this.openWebSocket(wsPort, board, port, baudRate);
    });

    if (!this.connection?.connected) {
      throw new Error(`Failed to connect the monitor on ${portAddress}`);
    }
    return this.statusForResult();
  }

  private openWebSocket(
    wsPort: number,
    board: { name: string; fqbn: string },
    port: Port,
    baudRate: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      const connection: ActiveConnection = {
        board,
        port,
        baudRate,
        ws,
        buffer: '',
        connected: false,
      };

      ws.on('open', () => {
        connection.connected = true;
        this.connection = connection;
        resolve();
      });
      ws.on('error', (err) => {
        if (!connection.connected) {
          reject(err);
        }
        connection.connected = false;
      });
      ws.on('close', () => {
        connection.connected = false;
      });
      ws.on('message', (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          if (Array.isArray(message)) {
            // Board output: an array of string chunks.
            connection.buffer += message.join('');
            if (connection.buffer.length > MAX_BUFFER_CHARS) {
              connection.buffer = connection.buffer.slice(-MAX_BUFFER_CHARS);
            }
          } else if (
            message?.command === Monitor.MiddlewareCommand.ON_SETTINGS_DID_CHANGE
          ) {
            const selected =
              message.data?.pluggableMonitorSettings?.baudrate?.selectedValue;
            if (selected) {
              connection.baudRate = Number(selected) || connection.baudRate;
            }
          }
        } catch {
          // Non-JSON payloads are unexpected; ignore them.
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      return;
    }
    this.connection = null;
    try {
      connection.ws.close();
    } catch {
      // best effort
    }
    // Closing the last WS client disposes the monitor, but stop explicitly for determinism.
    await this.monitorManager()
      .stopMonitor(connection.board, connection.port)
      .catch(() => undefined);
  }

  read(maxLines: number): { lines: string[]; count: number } {
    const connection = this.requireConnection();
    const lines = connection.buffer.split(/\r?\n/);
    // Drop a trailing empty segment caused by a terminating newline.
    if (lines.length && lines[lines.length - 1] === '') {
      lines.pop();
    }
    const slice = lines.slice(-maxLines);
    return { lines: slice, count: slice.length };
  }

  write(data: string): { bytesSent: number } {
    const connection = this.requireConnection();
    connection.ws.send(
      JSON.stringify({ command: Monitor.ClientCommand.SEND_MESSAGE, data })
    );
    return { bytesSent: Buffer.byteLength(data, 'utf8') };
  }

  setBaudRate(baudRate: number): { baudRate: number } {
    const connection = this.requireConnection();
    connection.ws.send(
      JSON.stringify({
        command: Monitor.ClientCommand.CHANGE_SETTINGS,
        data: {
          pluggableMonitorSettings: {
            baudrate: {
              id: 'baudrate',
              label: 'Baudrate',
              type: 'enum',
              values: SUPPORTED_BAUD_RATES.map(String),
              selectedValue: String(baudRate),
            },
          },
        },
      })
    );
    connection.baudRate = baudRate;
    return { baudRate };
  }

  clear(): void {
    if (this.connection) {
      this.connection.buffer = '';
    }
  }

  status(): {
    connected: boolean;
    port: string | null;
    baudRate: number | null;
    board: string | null;
  } {
    const c = this.connection;
    return {
      connected: c?.connected ?? false,
      port: c?.port.address ?? null,
      baudRate: c?.baudRate ?? null,
      board: c?.board.name ?? null,
    };
  }

  isConnected(): boolean {
    return this.connection?.connected ?? false;
  }

  private statusForResult(): {
    port: string;
    baudRate: number;
    board: string;
    fqbn: string;
  } {
    const c = this.connection!;
    return {
      port: c.port.address,
      baudRate: c.baudRate,
      board: c.board.name,
      fqbn: c.board.fqbn,
    };
  }

  private requireConnection(): ActiveConnection {
    if (!this.connection || !this.connection.connected) {
      throw new Error(
        'Not connected to a serial port. Use the connect action first.'
      );
    }
    return this.connection;
  }
}
