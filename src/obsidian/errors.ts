/**
 * Thrown by ObsidianClient when the companion plugin is not reachable.
 * The message is formatted for direct display to the user — tools that catch
 * it can surface `err.message` verbatim to the MCP client.
 */
export class PluginUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `obsidian-brain companion plugin unavailable: ${reason}. ` +
        `Install the plugin from https://github.com/sweir1/obsidian-brain-plugin ` +
        `(BRAT: "sweir1/obsidian-brain-plugin") and make sure Obsidian is ` +
        `running with it enabled against the same vault as VAULT_PATH.`,
    );
    this.name = 'PluginUnavailableError';
  }
}
