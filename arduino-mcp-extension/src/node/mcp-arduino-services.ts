/**
 * MCP Arduino Services
 *
 * The Arduino IDE binds most of its backend services (CoreService, BoardsService,
 * LibraryService, ResponseService, ...) inside per-frontend-connection DI containers
 * (`ConnectionContainerModule`), NOT in the main backend container. A singleton like
 * the MCP server therefore cannot `@inject` them directly - the injections resolve
 * to `undefined`.
 *
 * This module mirrors what the IDE does for each frontend connection: it creates a
 * child container of the main backend container and binds the service implementations
 * there, together with an MCP-owned `ResponseService`. The response service captures
 * compiler/upload output and progress events, which powers `arduino_build_output`
 * and real task progress.
 */

import { Container, interfaces } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';
import {
  ResponseService,
  OutputMessage,
  ProgressMessage,
} from 'arduino-ide-extension/lib/common/protocol/response-service';
import { CoreService } from 'arduino-ide-extension/lib/common/protocol/core-service';
import { BoardsService } from 'arduino-ide-extension/lib/common/protocol/boards-service';
import { LibraryService } from 'arduino-ide-extension/lib/common/protocol/library-service';
import { SketchesService } from 'arduino-ide-extension/lib/common/protocol/sketches-service';
import { ConfigService } from 'arduino-ide-extension/lib/common/protocol/config-service';
import { Formatter } from 'arduino-ide-extension/lib/common/protocol/formatter';
import { CoreServiceImpl } from 'arduino-ide-extension/lib/node/core-service-impl';
import { BoardsServiceImpl } from 'arduino-ide-extension/lib/node/boards-service-impl';
import { LibraryServiceImpl } from 'arduino-ide-extension/lib/node/library-service-impl';
import { ClangFormatter } from 'arduino-ide-extension/lib/node/clang-formatter';
import { MonitorManager } from 'arduino-ide-extension/lib/node/monitor-manager';

/**
 * Captures output and progress that Arduino services would normally stream to the
 * IDE frontend. One instance is shared by all MCP-triggered operations.
 */
export class MCPResponseService implements ResponseService {
  private stdoutChunks: string[] = [];
  private stderrChunks: string[] = [];

  private readonly progressEmitter = new Emitter<ProgressMessage>();
  readonly onProgress: Event<ProgressMessage> = this.progressEmitter.event;

  appendToOutput(message: OutputMessage): void {
    if (message.severity === OutputMessage.Severity.Error) {
      this.stderrChunks.push(message.chunk);
    } else {
      this.stdoutChunks.push(message.chunk);
    }
  }

  reportProgress(message: ProgressMessage): void {
    this.progressEmitter.fire(message);
  }

  reset(): void {
    this.stdoutChunks = [];
    this.stderrChunks = [];
  }

  snapshot(): { stdout: string; stderr: string } {
    return {
      stdout: this.stdoutChunks.join(''),
      stderr: this.stderrChunks.join(''),
    };
  }
}

export interface MCPArduinoServices {
  readonly coreService: CoreService;
  readonly boardsService: BoardsService;
  readonly libraryService: LibraryService;
  readonly sketchesService: SketchesService;
  readonly configService: ConfigService;
  readonly formatter: Formatter;
  readonly monitorManager: MonitorManager;
  readonly responseService: MCPResponseService;
}

export const MCPArduinoServicesProvider = Symbol('MCPArduinoServicesProvider');
export type MCPArduinoServicesProvider = () => MCPArduinoServices;

/**
 * Creates the MCP "connection" container. Must be called lazily (first tool use),
 * after all backend modules have loaded and the container is fully configured.
 */
export function createMCPArduinoServices(
  parent: interfaces.Container
): MCPArduinoServices {
  const child = (parent as Container).createChild();
  const responseService = new MCPResponseService();

  child.bind(ResponseService).toConstantValue(responseService);
  child.bind(CoreServiceImpl).toSelf().inSingletonScope();
  child.bind(CoreService).toService(CoreServiceImpl);
  child.bind(BoardsServiceImpl).toSelf().inSingletonScope();
  child.bind(BoardsService).toService(BoardsServiceImpl);
  child.bind(LibraryServiceImpl).toSelf().inSingletonScope();
  child.bind(LibraryService).toService(LibraryServiceImpl);
  // ClangFormatter is a main-container singleton; expose it under the protocol symbol.
  child.bind(Formatter).toService(ClangFormatter);

  return {
    get coreService(): CoreService {
      return child.get<CoreService>(CoreService);
    },
    get boardsService(): BoardsService {
      return child.get<BoardsService>(BoardsService);
    },
    get libraryService(): LibraryService {
      return child.get<LibraryService>(LibraryService);
    },
    get sketchesService(): SketchesService {
      return child.get<SketchesService>(SketchesService);
    },
    get configService(): ConfigService {
      return child.get<ConfigService>(ConfigService);
    },
    get formatter(): Formatter {
      return child.get<Formatter>(Formatter);
    },
    get monitorManager(): MonitorManager {
      return child.get(MonitorManager);
    },
    responseService,
  };
}
