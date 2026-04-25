/**
 * v1.7.5: user-config layer — survives `npm update obsidian-brain`.
 *
 * Two files live in a per-user config directory outside the npm package:
 *   - `seed-models.json` — a user-fetched seed (via `obsidian-brain models
 *     fetch-seed`). When present, takes priority over the bundled seed.
 *     Lets users pull in upstream MTEB fixes without waiting for an npm
 *     release.
 *   - `model-overrides.json` — hand-edited per-model overrides for any of
 *     `maxTokens`, `queryPrefix`, `documentPrefix`. Layered on top of the
 *     resolved metadata in `metadata-resolver.materialise()`. Used to
 *     correct upstream errors locally (e.g. "MTEB says max_tokens=1024
 *     but the real model only supports 512" — set the override and ship
 *     it via dotfiles).
 *
 * Resolution order including these layers:
 *   override (this layer) → cache → seed (user-fetched > bundled) → HF →
 *   embedder probe → safe defaults.
 *
 * Override changes are detected automatically by the prefix-strategy hash
 * in `bootstrap.ts`: when `query_prefix` / `document_prefix` differ from
 * the previously-stamped values, `needsReindex = true` fires and the
 * vault re-embeds. `maxTokens` overrides take effect on the next reindex
 * (they don't auto-trigger one — chunker behaviour changes, but existing
 * vectors stay valid).
 *
 * Path resolution (XDG-compliant):
 *   - `$OBSIDIAN_BRAIN_CONFIG_DIR` (explicit override; takes precedence)
 *   - Windows: `%APPDATA%/obsidian-brain/`
 *   - macOS / Linux: `$XDG_CONFIG_HOME/obsidian-brain/` if set, else
 *     `~/.config/obsidian-brain/`
 *
 * The directory is created lazily on first write — no side effects on
 * import.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Returns the absolute path to the per-user obsidian-brain config dir.
 * The directory may not exist yet — callers writing to it must ensure
 * via `mkdirSync(dir, { recursive: true })`.
 */
export function getUserConfigDir(): string {
  const explicit = process.env.OBSIDIAN_BRAIN_CONFIG_DIR;
  if (explicit && explicit.trim()) return explicit.trim();

  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'obsidian-brain');
  }

  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return join(xdg.trim(), 'obsidian-brain');

  return join(homedir(), '.config', 'obsidian-brain');
}

/** Path to the user-fetched seed JSON (refreshed by `models fetch-seed`). */
export function getUserSeedPath(): string {
  return join(getUserConfigDir(), 'seed-models.json');
}

/** Path to the user model-overrides JSON (managed via `models override`). */
export function getOverridesPath(): string {
  return join(getUserConfigDir(), 'model-overrides.json');
}
