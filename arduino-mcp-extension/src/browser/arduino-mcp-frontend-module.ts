/**
 * Arduino MCP Extension - Frontend Module
 *
 * This module provides:
 * - MCP Enable/Disable setting in preferences
 * - MCP service proxy for controlling the backend
 * - Preference change listeners
 */

import { ContainerModule } from '@theia/core/shared/inversify';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { bindMCPPreferences, MCPPreferences } from './mcp-preferences';
import { MCPService, MCPServicePath } from '../common/mcp-service';
import { MCPFrontendContribution } from './mcp-frontend-contribution';

export default new ContainerModule((bind, unbind, isBound, rebind) => {
  // Bind MCP preferences to add settings to Arduino IDE preferences panel
  bindMCPPreferences(bind);

  // Bind the MCP service proxy to communicate with backend
  bind(MCPService).toDynamicValue(ctx => {
    const connection = ctx.container.get(WebSocketConnectionProvider);
    return connection.createProxy<MCPService>(MCPServicePath);
  }).inSingletonScope();

  // Bind frontend contribution to handle preference changes
  bind(MCPFrontendContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MCPFrontendContribution);

  console.log('[arduino-mcp] Frontend module loaded with MCP preferences and service proxy');
});
