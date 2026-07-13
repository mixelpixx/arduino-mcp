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
import { MCPService, MCPServiceClient, MCPServicePath } from '../common/mcp-service';
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

  // Expose MCP Service via JSON-RPC for frontend access. The factory MUST capture
  // the per-connection `client` proxy and register it on the service - otherwise
  // server->client callbacks (onFileChanged / onStatusChanged) have no channel back
  // to the frontend and the real-time editor sync silently does nothing. This
  // mirrors the NotificationService wiring in arduino-ide-extension.
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new JsonRpcConnectionHandler<MCPServiceClient>(MCPServicePath, client => {
      const service = ctx.container.get<MCPServiceImpl>(MCPServiceImpl);
      service.setClient(client);
      return service;
    })
  ).inSingletonScope();

  // Bind the MCP contribution that manages startup
  bind(MCPContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(MCPContribution);
});
