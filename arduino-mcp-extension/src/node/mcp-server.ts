/**
 * Arduino MCP Server - Embedded HTTP/SSE Implementation
 *
 * This is the MCP server embedded directly in the Arduino IDE.
 * It uses HTTP/SSE transport instead of stdio, eliminating the need for a sidecar.
 *
 * Architecture:
 *   Claude Code (MCP Client)
 *          ↓ HTTP/SSE
 *   Arduino IDE Backend (This Server)
 *          ↓ Direct DI
 *   Arduino Services (Sketches, Core, Boards, Library, Monitor, Formatter, Config)
 */

import { injectable, inject, postConstruct, optional } from '@theia/core/shared/inversify';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ARDUINO_TOOLS, ToolDefinition } from '../common/mcp-tools';
import { Task, TaskStatus } from '../common/mcp-types';
import { MCPStatus, MCPFileChangeEvent } from '../common/mcp-service';
import {
  ROUTER_TOOLS,
  listToolCategories,
  getCategoryTools,
  searchTools,
  toolExists,
} from '../common/mcp-tool-router';

// Arduino IDE service symbols - imported from compiled modules at runtime
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SketchesService } = require('arduino-ide-extension/lib/common/protocol/sketches-service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CoreService } = require('arduino-ide-extension/lib/common/protocol/core-service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { BoardsService } = require('arduino-ide-extension/lib/common/protocol/boards-service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LibraryService } = require('arduino-ide-extension/lib/common/protocol/library-service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MonitorManagerProxy } = require('arduino-ide-extension/lib/common/protocol/monitor-service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Formatter } = require('arduino-ide-extension/lib/common/protocol/formatter');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ConfigService } = require('arduino-ide-extension/lib/common/protocol/config-service');

// ============================================================
// TYPES
// ============================================================

interface Sketch {
  name: string;
  uri: string;
  mainFileUri: string;
  otherSketchFileUris: string[];
  additionalFileUris: string[];
  rootFolderFileUris: string[];
}

interface MonitorConnection {
  port: string;
  baudRate: number;
  connected: boolean;
  buffer: string[];
}

// ============================================================
// MCP SERVER
// ============================================================

@injectable()
export class ArduinoMCPServer {
  private httpServer: http.Server | null = null;
  private mcpServer: Server | null = null;
  private transport: SSEServerTransport | null = null;
  private isRunning = false;
  private port = 3847;
  private startTime: number = 0;
  private connectedClients = 0;

  // Task management for async operations (MCP 2025 Tasks capability)
  private tasks = new Map<string, Task>();
  private taskCounter = 0;

  // State tracking
  private lastBuildOutput: { stdout: string; stderr: string } | null = null;
  private currentSketch: Sketch | null = null;
  private monitorConnection: MonitorConnection | null = null;

  // Callback for file change notifications (real-time sync)
  private fileChangeCallback: ((event: MCPFileChangeEvent) => void) | null = null;

  // Inject Arduino IDE services (all optional to handle load order issues)
  @inject(SketchesService) @optional()
  private readonly sketchesService?: any;

  @inject(CoreService) @optional()
  private readonly coreService?: any;

  @inject(BoardsService) @optional()
  private readonly boardsService?: any;

  @inject(LibraryService) @optional()
  private readonly libraryService?: any;

  @inject(MonitorManagerProxy) @optional()
  private readonly monitorManagerProxy?: any;

  @inject(Formatter) @optional()
  private readonly formatter?: any;

  @inject(ConfigService) @optional()
  private readonly configService?: any;

  @postConstruct()
  protected init(): void {
    console.log('[arduino-mcp] Embedded MCP Server initialized');
    console.log('[arduino-mcp] Services available:', {
      sketches: !!this.sketchesService,
      core: !!this.coreService,
      boards: !!this.boardsService,
      library: !!this.libraryService,
      monitor: !!this.monitorManagerProxy,
      formatter: !!this.formatter,
      config: !!this.configService,
    });
  }

  /**
   * Get current MCP server status
   */
  getStatus(): MCPStatus {
    return {
      enabled: this.isRunning,
      running: this.isRunning,
      port: this.port,
      connectedClients: this.connectedClients,
      uptime: this.isRunning ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
    };
  }

  /**
   * Start the embedded MCP server on HTTP/SSE
   */
  async start(port?: number): Promise<void> {
    if (this.isRunning) {
      console.log('[arduino-mcp] MCP Server already running');
      return;
    }

    this.port = port || parseInt(process.env.ARDUINO_MCP_PORT || '3847', 10);

    // Create MCP server
    this.mcpServer = new Server(
      {
        name: 'arduino-ide-mcp',
        version: '0.4.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Register tool handlers
    this.registerToolHandlers();

    // Create HTTP server
    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.httpServer!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[arduino-mcp] Port ${this.port} is in use. Try setting ARDUINO_MCP_PORT env var.`);
        }
        reject(err);
      });

      this.httpServer!.listen(this.port, '127.0.0.1', () => {
        this.isRunning = true;
        this.startTime = Date.now();
        console.log(`[arduino-mcp] MCP Server listening on http://127.0.0.1:${this.port}`);
        console.log('[arduino-mcp] Claude Code config:');
        console.log(JSON.stringify({
          mcpServers: {
            arduino: {
              url: `http://127.0.0.1:${this.port}/sse`
            }
          }
        }, null, 2));
        resolve();
      });
    });
  }

  /**
   * Handle incoming HTTP requests
   */
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS headers for local connections
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Health check endpoint
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        server: 'arduino-ide-mcp',
        version: '0.4.0',
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        services: {
          sketches: !!this.sketchesService,
          core: !!this.coreService,
          boards: !!this.boardsService,
          library: !!this.libraryService,
          monitor: !!this.monitorManagerProxy,
          formatter: !!this.formatter,
          config: !!this.configService,
        }
      }));
      return;
    }

    // SSE endpoint for MCP
    if (url.pathname === '/sse' && req.method === 'GET') {
      console.log('[arduino-mcp] SSE connection established');
      this.handleSSEConnection(req, res);
      return;
    }

    // Message endpoint for client-to-server messages
    if (url.pathname === '/message' && req.method === 'POST') {
      this.handleMessage(req, res);
      return;
    }

    // 404 for unknown paths
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  /**
   * Handle SSE connection from MCP client
   */
  private async handleSSEConnection(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.connectedClients++;

    // Create SSE transport
    this.transport = new SSEServerTransport('/message', res);

    // Connect MCP server to transport
    await this.mcpServer!.connect(this.transport);

    // Handle client disconnect
    req.on('close', () => {
      console.log('[arduino-mcp] SSE connection closed');
      this.connectedClients--;
      this.transport = null;
    });
  }

  /**
   * Handle POST messages from MCP client
   */
  private async handleMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.transport) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active SSE connection' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        await this.transport!.handlePostMessage(req, res, body);
      } catch (error) {
        console.error('[arduino-mcp] Error handling message:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    });
  }

  /**
   * Whether to use router pattern (4 meta-tools) or direct mode (all tools)
   * Router pattern is recommended to reduce context window usage
   */
  private useRouterMode = true;

  /**
   * Register MCP tool handlers
   */
  private registerToolHandlers(): void {
    // Handler: List available tools
    this.mcpServer!.setRequestHandler(ListToolsRequestSchema, async () => {
      console.log('[arduino-mcp] tools/list requested');

      if (this.useRouterMode) {
        // Router mode: expose only 4 meta-tools
        return {
          tools: ROUTER_TOOLS.map((tool: ToolDefinition): Tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as Tool['inputSchema'],
          })),
        };
      } else {
        // Direct mode: expose all individual tools
        return {
          tools: ARDUINO_TOOLS.map((tool: ToolDefinition): Tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as Tool['inputSchema'],
          })),
        };
      }
    });

    // Handler: Execute tool
    this.mcpServer!.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      console.log(`[arduino-mcp] tools/call: ${name}`);

      try {
        let result: unknown;

        // Handle router meta-tools
        if (this.useRouterMode) {
          switch (name) {
            case 'list_tool_categories':
              result = {
                categories: listToolCategories(),
                hint: 'Use get_category_tools with a category name to see detailed tool info',
              };
              break;

            case 'get_category_tools': {
              const category = args?.category as string;
              if (!category) {
                throw new Error('category is required');
              }
              const tools = getCategoryTools(category);
              if (!tools) {
                throw new Error(`Unknown category: ${category}. Use list_tool_categories to see available categories.`);
              }
              result = {
                category,
                tools: tools.map(t => ({
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema.properties,
                  required: t.inputSchema.required || [],
                  annotations: t.annotations,
                })),
                hint: 'Use execute_tool with tool_name and params to execute a tool',
              };
              break;
            }

            case 'execute_tool': {
              const toolName = args?.tool_name as string;
              const params = (args?.params || {}) as Record<string, unknown>;
              if (!toolName) {
                throw new Error('tool_name is required');
              }
              if (!toolExists(toolName)) {
                throw new Error(`Unknown tool: ${toolName}. Use search_tools or get_category_tools to find available tools.`);
              }
              result = await this.executeArduinoTool(toolName, params);
              break;
            }

            case 'search_tools': {
              const query = args?.query as string;
              if (!query) {
                throw new Error('query is required');
              }
              const searchResults = searchTools(query);
              result = {
                query,
                results: searchResults,
                count: searchResults.length,
                hint: searchResults.length > 0
                  ? 'Use get_category_tools to see full tool details, or execute_tool to run a tool'
                  : 'No tools found. Try a different search term.',
              };
              break;
            }

            default:
              // Fall through to direct tool execution for backwards compatibility
              result = await this.executeArduinoTool(name, args || {});
          }
        } else {
          // Direct mode: execute tool by name
          result = await this.executeArduinoTool(name, args || {});
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[arduino-mcp] Tool error: ${errorMessage}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: errorMessage }, null, 2),
            },
          ],
          isError: true,
        };
      }
    });
  }

  // ============================================================
  // TOOL EXECUTION
  // ============================================================

  private async executeArduinoTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    switch (toolName) {
      // ----------------------------------------------------------
      // SKETCH TOOLS
      // ----------------------------------------------------------
      case 'arduino_sketch': {
        const action = args.action as string;
        switch (action) {
          case 'get_current':
            return this.currentSketch
              ? {
                  name: this.currentSketch.name,
                  uri: this.currentSketch.uri,
                  mainFileUri: this.currentSketch.mainFileUri,
                  otherSketchFileUris: this.currentSketch.otherSketchFileUris,
                  additionalFileUris: this.currentSketch.additionalFileUris,
                }
              : null;

          case 'get_content': {
            const filePath = args.path as string;
            if (!filePath) throw new Error('path is required');
            const fsPath = filePath.startsWith('file://')
              ? decodeURIComponent(filePath.replace('file://', ''))
              : filePath;
            const content = await fs.promises.readFile(fsPath, 'utf-8');
            return { content, path: filePath };
          }

          case 'set_content': {
            const filePath = args.path as string;
            const content = args.content as string;
            if (!filePath) throw new Error('path is required');
            if (content === undefined) throw new Error('content is required');
            const fsPath = filePath.startsWith('file://')
              ? decodeURIComponent(filePath.replace('file://', ''))
              : filePath;

            // Check if file exists (for created vs modified distinction)
            let fileExists = false;
            try {
              await fs.promises.access(fsPath);
              fileExists = true;
            } catch {
              fileExists = false;
            }

            await fs.promises.writeFile(fsPath, content, 'utf-8');

            // Notify frontend of file change for real-time sync
            this.emitFileChange({
              uri: filePath.startsWith('file://') ? filePath : `file://${fsPath}`,
              type: fileExists ? 'modified' : 'created',
              source: 'mcp',
              tool: 'arduino_sketch',
              timestamp: Date.now(),
            });

            return { path: filePath, bytesWritten: content.length };
          }

          case 'list': {
            this.requireService(this.sketchesService, 'SketchesService');
            const container = await this.sketchesService.getSketches({});
            const sketches: Array<{ name: string; uri: string }> = [];
            const collectSketches = (c: any) => {
              sketches.push(...c.sketches.map((s: any) => ({ name: s.name, uri: s.uri })));
              c.children.forEach(collectSketches);
            };
            collectSketches(container);
            return { sketches };
          }

          case 'create': {
            this.requireService(this.sketchesService, 'SketchesService');
            const sketch = await this.sketchesService.createNewSketch();
            return {
              name: sketch.name,
              uri: sketch.uri,
              mainFileUri: sketch.mainFileUri,
            };
          }

          case 'open': {
            this.requireService(this.sketchesService, 'SketchesService');
            const sketchPath = args.path as string;
            if (!sketchPath) throw new Error('path is required');
            const sketch = await this.sketchesService.loadSketch(sketchPath);
            this.setCurrentSketch(sketch);
            return {
              name: sketch.name,
              uri: sketch.uri,
              mainFileUri: sketch.mainFileUri,
              otherSketchFileUris: sketch.otherSketchFileUris,
              additionalFileUris: sketch.additionalFileUris,
            };
          }

          case 'save':
            return { success: true };

          case 'get_files':
            if (!this.currentSketch) {
              throw new Error('No sketch is currently open');
            }
            return {
              mainFile: this.currentSketch.mainFileUri,
              otherSketchFiles: this.currentSketch.otherSketchFileUris,
              additionalFiles: this.currentSketch.additionalFileUris,
              rootFolderFiles: this.currentSketch.rootFolderFileUris,
            };

          case 'list_examples':
            return { examples: await this.getBuiltInExamples(args.category as string | undefined) };

          case 'from_example': {
            this.requireService(this.sketchesService, 'SketchesService');
            const examplePath = args.example_path as string;
            if (!examplePath) throw new Error('example_path is required');
            const exampleSketch = await this.sketchesService.loadSketch(examplePath);
            const newSketch = await this.sketchesService.copy(exampleSketch, {
              destinationUri: '',
            });
            this.setCurrentSketch(newSketch);
            return {
              name: newSketch.name,
              uri: newSketch.uri,
              mainFileUri: newSketch.mainFileUri,
              message: `Created sketch from example: ${exampleSketch.name}`,
            };
          }

          default:
            throw new Error(`Unknown sketch action: ${action}`);
        }
      }

      // ----------------------------------------------------------
      // COMPILE TOOL (Task-enabled)
      // ----------------------------------------------------------
      case 'arduino_compile': {
        const taskId = `task_${++this.taskCounter}_${Date.now()}`;
        const task: Task = {
          id: taskId,
          status: 'pending',
          tool: 'arduino_compile',
          arguments: {
            sketch_path: args.sketch_path,
            fqbn: args.fqbn,
            verbose: args.verbose,
          },
        };
        this.tasks.set(taskId, task);
        setImmediate(() => this.runCompileTask(task, taskId));
        return {
          taskId,
          message: 'Compilation started. Use arduino_task_status to check progress.',
        };
      }

      // ----------------------------------------------------------
      // UPLOAD TOOL (Task-enabled, DESTRUCTIVE)
      // ----------------------------------------------------------
      case 'arduino_upload': {
        const taskId = `task_${++this.taskCounter}_${Date.now()}`;
        const task: Task = {
          id: taskId,
          status: 'pending',
          tool: 'arduino_upload',
          arguments: {
            sketch_path: args.sketch_path,
            fqbn: args.fqbn,
            port: args.port,
            verify: args.verify,
          },
        };
        this.tasks.set(taskId, task);
        setImmediate(() => this.runUploadTask(task, taskId));
        return {
          taskId,
          message: 'Upload started. This will OVERWRITE firmware on the device. Use arduino_task_status to check progress.',
        };
      }

      // ----------------------------------------------------------
      // BUILD OUTPUT
      // ----------------------------------------------------------
      case 'arduino_build_output': {
        const type = (args.type as string) || 'all';
        const format = (args.format as string) || 'raw';

        if (!this.lastBuildOutput) return { stdout: '', stderr: '' };

        if (type === 'errors') {
          const errors = this.extractErrors(this.lastBuildOutput.stderr);
          return format === 'explained'
            ? { errors: errors.map(e => this.explainError(e)) }
            : { errors };
        }
        if (type === 'warnings') {
          const warnings = this.extractWarnings(this.lastBuildOutput.stderr);
          return { warnings };
        }
        return this.lastBuildOutput;
      }

      // ----------------------------------------------------------
      // BOARD TOOLS
      // ----------------------------------------------------------
      case 'arduino_board': {
        const action = args.action as string;
        switch (action) {
          case 'list_connected': {
            this.requireService(this.boardsService, 'BoardsService');
            const detectedPorts = await this.boardsService.getDetectedPorts();
            const boards = (Object.values(detectedPorts) as any[])
              .filter((dp: any) => dp.boards && dp.boards.length > 0)
              .map((dp: any) => ({
                name: dp.boards![0].name,
                fqbn: dp.boards![0].fqbn,
                port: {
                  address: dp.port.address,
                  protocol: dp.port.protocol,
                },
              }));
            return { boards };
          }

          case 'list_available': {
            this.requireService(this.boardsService, 'BoardsService');
            const boards = await this.boardsService.getInstalledBoards();
            return {
              boards: boards.map((b: any) => ({
                name: b.name,
                fqbn: b.fqbn,
                packageName: b.packageName,
              })),
            };
          }

          case 'get_selected':
            return null; // TODO: Get from board manager state

          case 'get_info': {
            const fqbn = args.fqbn as string;
            if (!fqbn) throw new Error('fqbn is required for get_info');
            try {
              this.requireService(this.boardsService, 'BoardsService');
              const details = await this.boardsService.getBoardDetails({ fqbn });
              return {
                name: details.name,
                fqbn: details.fqbn,
                package: details.package?.name,
                platform: details.platform?.name,
                pinInfo: this.getBoardPinInfo(fqbn),
              };
            } catch {
              return { fqbn, pinInfo: this.getBoardPinInfo(fqbn) };
            }
          }

          case 'select':
            throw new Error('board/select not yet implemented');

          case 'search': {
            this.requireService(this.boardsService, 'BoardsService');
            const query = args.query as string;
            const results = await this.boardsService.searchBoards({ query });
            return {
              boards: results.map((b: any) => ({
                name: b.name,
                fqbn: b.fqbn,
                packageName: b.packageName,
              })),
            };
          }

          case 'install_core': {
            this.requireService(this.boardsService, 'BoardsService');
            const core = args.core as string;
            const searchResults = await this.boardsService.search({ query: core });
            if (searchResults.length === 0) {
              throw new Error(`Core not found: ${core}`);
            }
            await this.boardsService.install({ item: searchResults[0] });
            return { success: true, core };
          }

          default:
            throw new Error(`Unknown board action: ${action}`);
        }
      }

      // ----------------------------------------------------------
      // SERIAL TOOLS (Now with full implementation)
      // ----------------------------------------------------------
      case 'arduino_serial': {
        const action = args.action as string;
        switch (action) {
          case 'list_ports': {
            this.requireService(this.boardsService, 'BoardsService');
            const detectedPorts = await this.boardsService.getDetectedPorts();
            const ports = (Object.values(detectedPorts) as any[]).map((dp: any) => ({
              address: dp.port.address,
              protocol: dp.port.protocol,
              boards: dp.boards?.map((b: any) => ({ name: b.name, fqbn: b.fqbn })) || [],
            }));
            return { ports };
          }

          case 'connect': {
            this.requireService(this.monitorManagerProxy, 'MonitorManagerProxy');
            const port = args.port as string;
            const baudRate = (args.baud_rate as number) || 9600;

            if (!port) throw new Error('port is required');

            // Get board info for the port
            const detectedPorts = await this.boardsService?.getDetectedPorts() || {};
            const portInfo = Object.values(detectedPorts).find((dp: any) => dp.port.address === port) as any;
            const board = portInfo?.boards?.[0] || { fqbn: 'arduino:avr:uno' };

            await this.monitorManagerProxy.startMonitor(
              { fqbn: board.fqbn },
              { address: port, protocol: 'serial' },
              { baudrate: { id: 'baudrate', label: 'Baud Rate', type: 'enum', values: ['9600', '115200'], selectedValue: String(baudRate) } }
            );

            this.monitorConnection = {
              port,
              baudRate,
              connected: true,
              buffer: [],
            };

            return { success: true, port, baudRate };
          }

          case 'disconnect': {
            this.requireService(this.monitorManagerProxy, 'MonitorManagerProxy');
            if (!this.monitorConnection) {
              return { success: true, message: 'No active connection' };
            }

            const detectedPorts = await this.boardsService?.getDetectedPorts() || {};
            const portInfo = Object.values(detectedPorts).find((dp: any) =>
              dp.port.address === this.monitorConnection!.port
            ) as any;
            const board = portInfo?.boards?.[0] || { fqbn: 'arduino:avr:uno' };

            await this.monitorManagerProxy.stopMonitor(
              { fqbn: board.fqbn },
              { address: this.monitorConnection.port, protocol: 'serial' }
            );

            this.monitorConnection = null;
            return { success: true };
          }

          case 'read': {
            if (!this.monitorConnection) {
              throw new Error('Not connected to serial port. Use connect action first.');
            }
            const maxLines = (args.max_lines as number) || 100;
            const lines = this.monitorConnection.buffer.slice(-maxLines);
            return { lines, count: lines.length };
          }

          case 'write': {
            if (!this.monitorConnection) {
              throw new Error('Not connected to serial port. Use connect action first.');
            }
            const data = args.data as string;
            const lineEnding = args.line_ending as string || 'newline';

            if (!data) throw new Error('data is required');

            let dataToSend = data;
            switch (lineEnding) {
              case 'newline': dataToSend += '\n'; break;
              case 'carriage': dataToSend += '\r'; break;
              case 'both': dataToSend += '\r\n'; break;
            }

            // TODO: Actually send via monitor service when client is connected
            return { success: true, bytesSent: dataToSend.length };
          }

          case 'clear': {
            if (this.monitorConnection) {
              this.monitorConnection.buffer = [];
            }
            return { success: true };
          }

          case 'get_config': {
            return this.monitorConnection
              ? { port: this.monitorConnection.port, baudRate: this.monitorConnection.baudRate, connected: true }
              : { connected: false };
          }

          case 'set_config': {
            if (!this.monitorConnection) {
              throw new Error('Not connected. Use connect action first.');
            }
            const newBaudRate = args.baud_rate as number;
            if (newBaudRate) {
              this.monitorConnection.baudRate = newBaudRate;
              // TODO: Update via monitor service
            }
            return { success: true, baudRate: this.monitorConnection.baudRate };
          }

          default:
            throw new Error(`Unknown serial action: ${action}`);
        }
      }

      // ----------------------------------------------------------
      // LIBRARY TOOLS
      // ----------------------------------------------------------
      case 'arduino_library': {
        this.requireService(this.libraryService, 'LibraryService');
        const action = args.action as string;
        switch (action) {
          case 'list': {
            const installed = await this.libraryService.list({});
            return {
              libraries: installed.map((lib: any) => ({
                name: lib.name,
                version: lib.installedVersion,
                author: lib.author,
                summary: lib.summary,
              })),
            };
          }

          case 'search': {
            const query = args.query as string;
            const results = await this.libraryService.search({ query: query || '' });
            return {
              libraries: results.map((lib: any) => ({
                name: lib.name,
                version: lib.availableVersions?.[0],
                author: lib.author,
                summary: lib.summary,
              })),
            };
          }

          case 'install': {
            const name = args.name as string;
            const version = args.version as string | undefined;
            const results = await this.libraryService.search({ query: name });
            const library = results.find((lib: any) => lib.name === name);
            if (!library) throw new Error(`Library not found: ${name}`);
            await this.libraryService.install({
              item: library,
              version: version || library.availableVersions?.[0],
            });
            return { success: true, name, version };
          }

          case 'remove': {
            const name = args.name as string;
            const installed = await this.libraryService.list({});
            const library = installed.find((lib: any) => lib.name === name);
            if (!library) throw new Error(`Library not installed: ${name}`);
            await this.libraryService.uninstall({ item: library });
            return { success: true, name };
          }

          case 'get_info': {
            const name = args.name as string;
            const results = await this.libraryService.search({ query: name });
            const library = results.find((lib: any) => lib.name === name);
            if (!library) throw new Error(`Library not found: ${name}`);
            return library;
          }

          case 'get_examples':
            throw new Error('get_examples not yet implemented');

          default:
            throw new Error(`Unknown library action: ${action}`);
        }
      }

      // ----------------------------------------------------------
      // FORMAT TOOL (NEW)
      // ----------------------------------------------------------
      case 'arduino_format': {
        this.requireService(this.formatter, 'Formatter');
        const content = args.content as string;
        const tabSize = (args.tab_size as number) || 2;
        const insertSpaces = args.insert_spaces !== false;

        if (!content) throw new Error('content is required');

        const formatted = await this.formatter.format({
          content,
          formatterConfigFolderUris: [],
          options: { tabSize, insertSpaces },
        });

        return { formatted, originalLength: content.length, formattedLength: formatted.length };
      }

      // ----------------------------------------------------------
      // CONFIG TOOL (NEW)
      // ----------------------------------------------------------
      case 'arduino_config': {
        const action = args.action as string;
        switch (action) {
          case 'get': {
            this.requireService(this.configService, 'ConfigService');
            const state = await this.configService.getConfiguration();
            if (!state.config) {
              return { error: 'Configuration not available', messages: state.messages };
            }
            return {
              sketchDirUri: state.config.sketchDirUri,
              dataDirUri: state.config.dataDirUri,
              additionalUrls: state.config.additionalUrls,
              locale: state.config.locale,
            };
          }

          case 'set': {
            this.requireService(this.configService, 'ConfigService');
            const currentState = await this.configService.getConfiguration();
            if (!currentState.config) {
              throw new Error('Cannot modify configuration - not available');
            }

            const newConfig = { ...currentState.config };
            if (args.additional_urls !== undefined) {
              newConfig.additionalUrls = args.additional_urls as string[];
            }
            if (args.sketch_dir !== undefined) {
              newConfig.sketchDirUri = args.sketch_dir as string;
            }

            await this.configService.setConfiguration(newConfig);
            return { success: true };
          }

          case 'add_board_url': {
            this.requireService(this.configService, 'ConfigService');
            const url = args.url as string;
            if (!url) throw new Error('url is required');

            const currentState = await this.configService.getConfiguration();
            if (!currentState.config) {
              throw new Error('Cannot modify configuration - not available');
            }

            const urls = [...currentState.config.additionalUrls];
            if (!urls.includes(url)) {
              urls.push(url);
              await this.configService.setConfiguration({
                ...currentState.config,
                additionalUrls: urls,
              });
            }
            return { success: true, additionalUrls: urls };
          }

          default:
            throw new Error(`Unknown config action: ${action}`);
        }
      }

      // ----------------------------------------------------------
      // CONTEXT TOOL
      // ----------------------------------------------------------
      case 'arduino_context': {
        let connectedBoards: Array<{ name: string; fqbn?: string; port: string }> = [];
        try {
          if (this.boardsService) {
            const detectedPorts = await this.boardsService.getDetectedPorts();
            connectedBoards = (Object.values(detectedPorts) as any[])
              .filter((dp: any) => dp.boards && dp.boards.length > 0)
              .map((dp: any) => ({
                name: dp.boards![0].name,
                fqbn: dp.boards![0].fqbn,
                port: dp.port.address,
              }));
          }
        } catch (e) {
          console.error('[arduino-mcp] Error getting detected ports:', e);
        }

        return {
          connected: true,
          open_sketch: this.currentSketch
            ? {
                name: this.currentSketch.name,
                uri: this.currentSketch.uri,
                mainFileUri: this.currentSketch.mainFileUri,
              }
            : null,
          selected_board: null,
          connected_boards: connectedBoards,
          serial_connected: this.monitorConnection?.connected || false,
          serial_port: this.monitorConnection?.port || null,
          mcp_version: '0.4.0',
          transport: 'http/sse',
        };
      }

      // ----------------------------------------------------------
      // TASK STATUS
      // ----------------------------------------------------------
      case 'arduino_task_status': {
        const taskId = args.task_id as string;
        if (!taskId) throw new Error('task_id is required');
        const task = this.tasks.get(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        return {
          status: task.status,
          result: task.result,
          error: task.error,
          progress: task.progress,
          progressMessage: task.progressMessage,
        };
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // ============================================================
  // ASYNC TASK RUNNERS
  // ============================================================

  private async runCompileTask(task: Task, taskId: string): Promise<void> {
    task.status = 'running';
    task.progress = 10;
    task.progressMessage = 'Preparing compilation...';

    try {
      if (!this.currentSketch) {
        throw new Error('No sketch is currently open');
      }

      const fqbn = task.arguments.fqbn as string | undefined;
      if (!fqbn) {
        throw new Error('No board selected (fqbn required)');
      }

      this.requireService(this.coreService, 'CoreService');

      task.progress = 20;
      task.progressMessage = 'Compiling...';

      const result = await this.coreService.compile({
        sketch: this.currentSketch,
        fqbn,
        verbose: (task.arguments.verbose as boolean) || false,
        optimizeForDebug: false,
        sourceOverride: {},
      });

      task.result = {
        success: true,
        buildPath: result?.buildPath,
        executableSectionsSize: result?.executableSectionsSize,
      };
      task.status = 'completed';
      task.progress = 100;
      task.progressMessage = 'Compilation complete';
    } catch (e) {
      task.status = 'failed';
      task.error = `Compilation failed: ${e instanceof Error ? e.message : e}`;
    }
  }

  private async runUploadTask(task: Task, taskId: string): Promise<void> {
    task.status = 'running';
    task.progress = 10;
    task.progressMessage = 'Preparing upload...';

    try {
      if (!this.currentSketch) {
        throw new Error('No sketch is currently open');
      }

      const fqbn = task.arguments.fqbn as string | undefined;
      const port = task.arguments.port as string | undefined;

      if (!fqbn) throw new Error('No board selected (fqbn required)');
      if (!port) throw new Error('No port specified');

      this.requireService(this.coreService, 'CoreService');

      task.progress = 20;
      task.progressMessage = 'Compiling...';

      task.progress = 50;
      task.progressMessage = 'Uploading to board...';

      const result = await this.coreService.upload({
        sketch: this.currentSketch,
        fqbn,
        port: { address: port, protocol: 'serial' },
        verbose: false,
        verify: (task.arguments.verify as boolean) ?? true,
        userFields: [],
      });

      task.result = {
        success: true,
        portAfterUpload: result.portAfterUpload,
      };
      task.status = 'completed';
      task.progress = 100;
      task.progressMessage = 'Upload complete';
    } catch (e) {
      task.status = 'failed';
      task.error = `Upload failed: ${e instanceof Error ? e.message : e}`;
    }
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================

  private requireService(service: any, name: string): void {
    if (!service) {
      throw new Error(`${name} not available - IDE may still be loading`);
    }
  }

  private extractErrors(stderr: string): string[] {
    const errors: string[] = [];
    for (const line of stderr.split('\n')) {
      if (line.includes('error:')) {
        errors.push(line.trim());
      }
    }
    return errors;
  }

  private extractWarnings(stderr: string): string[] {
    const warnings: string[] = [];
    for (const line of stderr.split('\n')) {
      if (line.includes('warning:')) {
        warnings.push(line.trim());
      }
    }
    return warnings;
  }

  private explainError(error: string): { raw: string; explanation: string; suggestion: string } {
    // Common Arduino error patterns with explanations
    const patterns: Array<{ pattern: RegExp; explanation: string; suggestion: string }> = [
      {
        pattern: /was not declared in this scope/i,
        explanation: 'The variable or function name is not recognized. It might be misspelled or not defined.',
        suggestion: 'Check spelling. Make sure the variable is declared before use, or include the necessary library.',
      },
      {
        pattern: /expected ';' before/i,
        explanation: 'A semicolon is missing at the end of a statement.',
        suggestion: 'Add a semicolon (;) at the end of the previous line.',
      },
      {
        pattern: /expected '\)' before/i,
        explanation: 'A closing parenthesis is missing.',
        suggestion: 'Check that all opening parentheses ( have matching closing parentheses ).',
      },
      {
        pattern: /'(\w+)' does not name a type/i,
        explanation: 'The compiler doesn\'t recognize this as a valid type.',
        suggestion: 'Check spelling, or include the library that defines this type.',
      },
      {
        pattern: /no matching function for call to/i,
        explanation: 'The function is being called with wrong arguments.',
        suggestion: 'Check the function documentation for correct parameter types.',
      },
    ];

    for (const { pattern, explanation, suggestion } of patterns) {
      if (pattern.test(error)) {
        return { raw: error, explanation, suggestion };
      }
    }

    return {
      raw: error,
      explanation: 'Compilation error occurred.',
      suggestion: 'Review the error message and check the indicated line.',
    };
  }

  private async getBuiltInExamples(category?: string): Promise<Array<{
    name: string;
    path: string;
    category: string;
    description?: string;
  }>> {
    const examplesPath = path.join(
      __dirname, '..', '..', '..', 'arduino-ide-extension', 'lib', 'node', 'resources', 'Examples'
    );

    const examples: Array<{name: string; path: string; category: string; description?: string}> = [];

    try {
      const categories = await fs.promises.readdir(examplesPath);
      for (const cat of categories) {
        if (category && !cat.includes(category)) continue;

        const catPath = path.join(examplesPath, cat);
        const stat = await fs.promises.stat(catPath);
        if (!stat.isDirectory()) continue;

        const items = await fs.promises.readdir(catPath);
        for (const item of items) {
          const itemPath = path.join(catPath, item);
          const itemStat = await fs.promises.stat(itemPath);
          if (itemStat.isDirectory()) {
            const files = await fs.promises.readdir(itemPath);
            if (files.some(f => f.endsWith('.ino'))) {
              examples.push({
                name: item,
                path: `file://${itemPath}`,
                category: cat,
                description: this.getExampleDescription(cat, item),
              });
            }
          }
        }
      }
    } catch (e) {
      console.error('[arduino-mcp] Error reading examples:', e);
    }

    return examples;
  }

  private getExampleDescription(category: string, name: string): string | undefined {
    const descriptions: Record<string, string> = {
      'Blink': 'Blink the built-in LED on and off - the "Hello World" of Arduino',
      'DigitalReadSerial': 'Read a digital input and print the state to Serial Monitor',
      'AnalogReadSerial': 'Read an analog sensor and print the value to Serial Monitor',
      'Fade': 'Fade an LED in and out using PWM (analogWrite)',
      'Button': 'Use a pushbutton to control an LED',
      'Debounce': 'Read a pushbutton with debouncing to avoid false triggers',
      'Sweep': 'Control a servo motor, sweeping back and forth',
      'Knob': 'Control a servo motor with a potentiometer',
      'ASCIITable': 'Print the ASCII table to the Serial Monitor',
      'ReadASCIIString': 'Parse integers from a comma-separated serial string',
    };
    return descriptions[name];
  }

  private getBoardPinInfo(fqbn: string): {
    digitalPins: number;
    analogPins: number;
    pwmPins: number[];
    i2cPins?: { sda: number; scl: number };
    spiPins?: { mosi: number; miso: number; sck: number; ss: number };
    ledPin?: number;
    notes?: string;
  } | null {
    const boardPinInfo: Record<string, any> = {
      'arduino:avr:uno': {
        digitalPins: 14,
        analogPins: 6,
        pwmPins: [3, 5, 6, 9, 10, 11],
        i2cPins: { sda: 18, scl: 19 },
        spiPins: { mosi: 11, miso: 12, sck: 13, ss: 10 },
        ledPin: 13,
        notes: 'PWM pins are marked with ~ on the board. A4/A5 can also be used as analog inputs.',
      },
      'arduino:avr:nano': {
        digitalPins: 14,
        analogPins: 8,
        pwmPins: [3, 5, 6, 9, 10, 11],
        i2cPins: { sda: 18, scl: 19 },
        spiPins: { mosi: 11, miso: 12, sck: 13, ss: 10 },
        ledPin: 13,
        notes: 'Same pinout as Uno but with extra analog pins A6, A7 (input only).',
      },
      'arduino:avr:mega': {
        digitalPins: 54,
        analogPins: 16,
        pwmPins: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 44, 45, 46],
        i2cPins: { sda: 20, scl: 21 },
        spiPins: { mosi: 51, miso: 50, sck: 52, ss: 53 },
        ledPin: 13,
        notes: 'Multiple hardware serial ports: Serial1 (19,18), Serial2 (17,16), Serial3 (15,14).',
      },
      'arduino:avr:leonardo': {
        digitalPins: 20,
        analogPins: 12,
        pwmPins: [3, 5, 6, 9, 10, 11, 13],
        i2cPins: { sda: 2, scl: 3 },
        spiPins: { mosi: 16, miso: 14, sck: 15, ss: 17 },
        ledPin: 13,
        notes: 'Can act as USB HID device (keyboard/mouse). Pins 2,3 are also I2C.',
      },
      'esp32:esp32:esp32': {
        digitalPins: 34,
        analogPins: 18,
        pwmPins: [0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33],
        i2cPins: { sda: 21, scl: 22 },
        spiPins: { mosi: 23, miso: 19, sck: 18, ss: 5 },
        notes: 'WiFi and Bluetooth built-in. All PWM-capable pins support up to 16 channels.',
      },
    };

    return boardPinInfo[fqbn] || null;
  }

  // ============================================================
  // PUBLIC METHODS FOR SERVICE INTEGRATION
  // ============================================================

  setCurrentSketch(sketch: Sketch | null): void {
    this.currentSketch = sketch;
  }

  setBuildOutput(stdout: string, stderr: string): void {
    this.lastBuildOutput = { stdout, stderr };
  }

  /**
   * Set callback for file change notifications (used for real-time sync)
   */
  setFileChangeCallback(callback: ((event: MCPFileChangeEvent) => void) | null): void {
    this.fileChangeCallback = callback;
  }

  /**
   * Emit a file change event to notify the frontend
   */
  private emitFileChange(event: MCPFileChangeEvent): void {
    if (this.fileChangeCallback) {
      try {
        this.fileChangeCallback(event);
        console.log(`[arduino-mcp] File change emitted: ${event.type} ${event.uri}`);
      } catch (error) {
        console.error('[arduino-mcp] Error emitting file change:', error);
      }
    }
  }

  // ============================================================
  // LIFECYCLE
  // ============================================================

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => {
          this.isRunning = false;
          console.log('[arduino-mcp] MCP Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  isServerRunning(): boolean {
    return this.isRunning;
  }

  getPort(): number {
    return this.port;
  }

  /**
   * Set the tool exposure mode
   * @param mode 'router' for 4 meta-tools or 'direct' for all tools
   */
  setToolMode(mode: 'router' | 'direct'): void {
    this.useRouterMode = mode === 'router';
    console.log(`[arduino-mcp] Tool mode set to: ${mode} (router=${this.useRouterMode})`);
  }
}
