/**
 * Arduino MCP Extension - Backend Module
 *
 * This module registers the embedded MCP server with Theia's DI container.
 * The MCP server runs directly in the IDE backend using HTTP transport
 * (Streamable HTTP and legacy SSE).
 */

import { ContainerModule } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ArduinoMCPServer } from './mcp-server';
import { MCPContribution } from './mcp-contribution';
import { MCPService, MCPServicePath } from '../common/mcp-service';
import { MCPServiceImpl } from './mcp-service-impl';
import {
  MCPArduinoServices,
  MCPArduinoServicesProvider,
  createMCPArduinoServices,
} from './mcp-arduino-services';

export default new ContainerModule((bind) => {
  // Lazy provider for the Arduino services the MCP server needs. Most of them
  // are bound in per-frontend-connection containers by the IDE, so the MCP
  // server builds its own "connection" child container on first use.
  bind(MCPArduinoServicesProvider).toDynamicValue((ctx) => {
    let cached: MCPArduinoServices | undefined;
    return () => {
      if (!cached) {
        cached = createMCPArduinoServices(ctx.container);
      }
      return cached;
    };
  }).inSingletonScope();

  // Bind the embedded MCP Server as a singleton
  bind(ArduinoMCPServer).toSelf().inSingletonScope();

  // Bind the MCP Service implementation
  bind(MCPServiceImpl).toSelf().inSingletonScope();
  bind(MCPService).toService(MCPServiceImpl);

  // Expose MCP Service via JSON-RPC for frontend access
  bind(ConnectionHandler).toDynamicValue(ctx => {
    const service = ctx.container.get<MCPService>(MCPService);
    return new JsonRpcConnectionHandler(MCPServicePath, () => service);
  }).inSingletonScope();

  // Bind the MCP contribution that manages startup
  bind(MCPContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(MCPContribution);
});
