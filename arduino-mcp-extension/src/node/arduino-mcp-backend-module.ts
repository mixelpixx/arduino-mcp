/**
 * Arduino MCP Extension - Backend Module
 *
 * This module registers the embedded MCP server with Theia's DI container.
 * The MCP server runs directly in the IDE backend using HTTP/SSE transport.
 */

import { ContainerModule } from '@theia/core/shared/inversify';
import {
  BackendApplicationContribution,
} from '@theia/core/lib/node/backend-application';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ArduinoMCPServer } from './mcp-server';
import { MCPContribution } from './mcp-contribution';
import { MCPService, MCPServicePath } from '../common/mcp-service';
import { MCPServiceImpl } from './mcp-service-impl';

export default new ContainerModule((bind) => {
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

  console.log('[arduino-mcp] Backend module loaded (embedded HTTP/SSE architecture)');
});
