/**
 * MCP Frontend Contribution
 *
 * Handles frontend lifecycle and preference synchronization with backend.
 * When user changes MCP settings in preferences, this updates the backend.
 * Also handles real-time file change notifications from MCP tools.
 */

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { FrontendApplication } from '@theia/core/lib/browser/frontend-application';
import { PreferenceService } from '@theia/core/lib/browser/preferences';
import { MessageService } from '@theia/core/lib/common/message-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import URI from '@theia/core/lib/common/uri';
import { MCPService, MCPServiceClient, MCPFileChangeEvent, MCPStatus } from '../common/mcp-service';

@injectable()
export class MCPFrontendContribution implements FrontendApplicationContribution, MCPServiceClient {
  @inject(MCPService)
  private readonly mcpService!: MCPService;

  @inject(PreferenceService)
  private readonly preferenceService!: PreferenceService;

  @inject(MessageService)
  private readonly messageService!: MessageService;

  @inject(EditorManager)
  private readonly editorManager!: EditorManager;

  // Track recent file changes to avoid notification spam
  private recentFileChanges = new Map<string, number>();
  private readonly NOTIFICATION_DEBOUNCE_MS = 2000;

  @postConstruct()
  protected init(): void {
    // Listen for preference changes
    this.preferenceService.onPreferenceChanged(event => {
      if (event.preferenceName === 'arduino.mcp.enabled') {
        this.handleMCPEnabledChange(event.newValue as boolean);
      } else if (event.preferenceName === 'arduino.mcp.toolMode') {
        this.handleToolModeChange(event.newValue as 'router' | 'direct');
      }
    });
  }

  async onStart(app: FrontendApplication): Promise<void> {
    console.log('[arduino-mcp] Frontend contribution started');

    // Register this as the MCP service client to receive notifications
    try {
      this.mcpService.setClient(this);
      console.log('[arduino-mcp] Registered as MCP service client');
    } catch (error) {
      console.error('[arduino-mcp] Error registering as client:', error);
    }

    // Check initial MCP status
    try {
      const status = await this.mcpService.getStatus();
      console.log('[arduino-mcp] Initial MCP status:', status);

      if (status.running) {
        const url = await this.mcpService.getServerUrl();
        console.log(`[arduino-mcp] MCP server available at: ${url}`);
      }
    } catch (error) {
      console.error('[arduino-mcp] Error getting initial status:', error);
    }
  }

  onStop(app: FrontendApplication): void {
    // Unregister as client
    try {
      this.mcpService.setClient(undefined);
    } catch (error) {
      // Ignore errors during shutdown
    }
  }

  // ============================================================
  // MCPServiceClient Implementation
  // ============================================================

  /**
   * Called when a file is changed via MCP tools (real-time sync)
   */
  onFileChanged(event: MCPFileChangeEvent): void {
    console.log(`[arduino-mcp] File changed via MCP: ${event.type} ${event.uri}`);

    // Debounce notifications for the same file
    const now = Date.now();
    const lastChange = this.recentFileChanges.get(event.uri);
    if (lastChange && (now - lastChange) < this.NOTIFICATION_DEBOUNCE_MS) {
      return;
    }
    this.recentFileChanges.set(event.uri, now);

    // Clean up old entries
    for (const [uri, timestamp] of this.recentFileChanges.entries()) {
      if (now - timestamp > this.NOTIFICATION_DEBOUNCE_MS * 2) {
        this.recentFileChanges.delete(uri);
      }
    }

    // Focus the changed file in the editor
    this.focusFileInEditor(event.uri);

    // Show notification
    const fileName = event.uri.split('/').pop() || event.uri;
    const action = event.type === 'created' ? 'Created' : 'Updated';
    this.messageService.info(
      `${action} by Claude: ${fileName}`,
      { timeout: 3000 }
    );
  }

  /**
   * Called when MCP server status changes
   */
  onStatusChanged(status: MCPStatus): void {
    console.log('[arduino-mcp] MCP status changed:', status);
  }

  // ============================================================
  // Private Methods
  // ============================================================

  /**
   * Focus a file in the editor (open if not already open)
   */
  private async focusFileInEditor(uriString: string): Promise<void> {
    try {
      const uri = new URI(uriString);

      // Check if the file is already open in an editor
      const existingEditor = this.editorManager.all.find(
        editor => editor.editor.uri.toString() === uri.toString()
      );

      if (existingEditor) {
        // File is already open - just reveal it
        // The file system watcher should auto-reload the content
        await this.editorManager.open(uri, { mode: 'reveal' });
      } else {
        // Open the file
        await this.editorManager.open(uri, { mode: 'activate' });
      }
    } catch (error) {
      console.error('[arduino-mcp] Error focusing file in editor:', error);
    }
  }

  private async handleMCPEnabledChange(enabled: boolean): Promise<void> {
    try {
      await this.mcpService.setEnabled(enabled);

      if (enabled) {
        const url = await this.mcpService.getServerUrl();
        this.messageService.info(
          `MCP server enabled. Configure Claude Code with: ${url}`,
          { timeout: 10000 }
        );
      } else {
        this.messageService.info('MCP server disabled.', { timeout: 5000 });
      }
    } catch (error) {
      console.error('[arduino-mcp] Error changing MCP enabled state:', error);
      this.messageService.error(
        `Failed to ${enabled ? 'enable' : 'disable'} MCP server: ${error}`
      );
    }
  }

  private async handleToolModeChange(mode: 'router' | 'direct'): Promise<void> {
    try {
      await this.mcpService.setToolMode(mode);
      const modeDesc = mode === 'router'
        ? 'Router mode (4 meta-tools)'
        : 'Direct mode (all tools)';
      this.messageService.info(
        `MCP tool mode changed to: ${modeDesc}. Reconnect Claude Code to apply.`,
        { timeout: 5000 }
      );
    } catch (error) {
      console.error('[arduino-mcp] Error changing tool mode:', error);
      this.messageService.error(`Failed to change tool mode: ${error}`);
    }
  }

  /**
   * Get the current MCP server URL for display
   */
  async getMCPServerUrl(): Promise<string | null> {
    try {
      const status = await this.mcpService.getStatus();
      if (status.running) {
        return this.mcpService.getServerUrl();
      }
      return null;
    } catch {
      return null;
    }
  }
}
