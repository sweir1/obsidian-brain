#!/bin/bash
# obsidian-brain one-line macOS installer
# version: 2026-04-24
#
# Usage:
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/sweir1/obsidian-brain/main/scripts/install.sh)"
#
# Optional: pass the vault path as the first positional argument to skip the prompt:
#   /bin/bash -c "$(curl -fsSL .../install.sh)" -- "/absolute/path/to/vault"
#
# Or via env:
#   VAULT_PATH=/absolute/path/to/vault /bin/bash -c "$(curl -fsSL .../install.sh)"
#
# Does: Homebrew, Node 20+, the /usr/local/bin symlink fix for GUI apps, the
# Claude Desktop config merge, pre-warms the npx cache, and opens the Full Disk
# Access pane. Mirrors docs/install-mac-nontechnical.md exactly so this script
# is a faithful automation of an already-public walkthrough.

set -euo pipefail
umask 022

# ---------------------------- pretty output ---------------------------- #

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_CYAN=$'\033[36m'
else
  C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_CYAN=''
fi

CURRENT_STEP="preflight"

info()  { printf '%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$1" "$C_RESET"; }
note()  { printf '    %s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }
ok()    { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn()  { printf '%s⚠%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
die()   { printf '\n%sError:%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; exit 1; }

on_error() {
  local exit_code=$?
  printf '\n%s✗ Step "%s" failed (exit %d).%s\n' "$C_RED" "$CURRENT_STEP" "$exit_code" "$C_RESET" >&2
  printf '  Troubleshooting: https://sweir1.github.io/obsidian-brain/troubleshooting/\n' >&2
  printf '  Manual walkthrough: https://sweir1.github.io/obsidian-brain/install-mac-nontechnical/\n' >&2
}
trap on_error ERR

# ---------------------------- /dev/tty helpers ---------------------------- #
# When this script is run via `/bin/bash -c "$(curl ...)"` the surrounding shell
# still has a controlling terminal, and /dev/tty is readable. We route all
# interactive reads explicitly to /dev/tty so it works even if something has
# redirected our stdin.

have_tty() { [[ -r /dev/tty && -w /dev/tty ]]; }

prompt() {
  # prompt "message" varname
  local msg=$1 var=$2 answer=""
  if ! have_tty; then
    die "No terminal available for interactive prompt ($msg). Pass VAULT_PATH as an env var or positional arg."
  fi
  printf '%s%s%s ' "$C_CYAN" "$msg" "$C_RESET" > /dev/tty
  IFS= read -r answer < /dev/tty
  printf -v "$var" '%s' "$answer"
}

pause_enter() {
  # pause_enter "message"
  local msg=$1
  if ! have_tty; then
    warn "Non-interactive run — skipping pause."
    return 0
  fi
  printf '\n%s%s%s ' "$C_YELLOW" "$msg" "$C_RESET" > /dev/tty
  IFS= read -r _ < /dev/tty || true
}

# ---------------------------- Step 0: preflight ---------------------------- #

CURRENT_STEP="preflight"
info "Preflight checks"

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  die "Do not run this installer as root. Run it as your regular user — sudo will be invoked only when needed."
fi

OS="$(uname -s)"
if [[ "$OS" != "Darwin" ]]; then
  cat >&2 <<EOF

This installer is for macOS only.

For Linux / Windows setup see:
  https://sweir1.github.io/obsidian-brain/install-clients/

Detected OS: $OS
EOF
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) BREW_PREFIX="/opt/homebrew" ;;
  x86_64) BREW_PREFIX="/usr/local" ;;
  *) die "Unsupported CPU architecture: $ARCH" ;;
esac

ok "macOS detected ($ARCH), Homebrew prefix will be $BREW_PREFIX"

# ---------------------------- Step 1: Homebrew ---------------------------- #

CURRENT_STEP="homebrew"
info "Checking for Homebrew"

brew_shellenv_line='eval "$('"$BREW_PREFIX"'/bin/brew shellenv)"'

if command -v brew >/dev/null 2>&1; then
  ok "Homebrew already installed ($(brew --version | head -n1))"
else
  note "Homebrew not found — installing from brew.sh (you'll be asked for your macOS password once)."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  ok "Homebrew installed"
fi

# Make brew available in this shell regardless of whether ~/.zprofile is sourced.
if [[ -x "$BREW_PREFIX/bin/brew" ]]; then
  eval "$("$BREW_PREFIX/bin/brew" shellenv)"
fi

# Persist brew on PATH for future GUI Terminal sessions by adding shellenv to
# the login shell profile — idempotent via grep.
persist_brew_path() {
  local rc=$1
  [[ -e "$rc" ]] || touch "$rc"
  if ! grep -Fq "brew shellenv" "$rc" 2>/dev/null; then
    printf '\n# Added by obsidian-brain installer\n%s\n' "$brew_shellenv_line" >> "$rc"
    note "Added brew shellenv to $rc"
  fi
}
persist_brew_path "$HOME/.zprofile"
# Bash login-shell users on macOS use ~/.bash_profile; only touch it if it already exists or bash is the login shell.
if [[ -e "$HOME/.bash_profile" ]] || [[ "${SHELL:-}" == */bash ]]; then
  persist_brew_path "$HOME/.bash_profile"
fi

command -v brew >/dev/null 2>&1 || die "brew still not on PATH after install — open a new Terminal and rerun."

# ---------------------------- Step 2: Node 20+ ---------------------------- #

CURRENT_STEP="node"
info "Checking for Node 20+"

required_major=20
required_minor=19

node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local raw major minor
  raw="$(node -v 2>/dev/null | sed 's/^v//')"
  major="${raw%%.*}"
  minor="${raw#*.}"; minor="${minor%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  if (( major > required_major )); then return 0; fi
  if (( major == required_major )) && (( minor >= required_minor )); then return 0; fi
  return 1
}

if node_version_ok; then
  ok "Node $(node -v) already meets the >=20.19.0 requirement"
else
  if command -v node >/dev/null 2>&1; then
    warn "Node $(node -v) is too old — installing a newer version via Homebrew."
  else
    note "Node not found — installing via Homebrew."
  fi
  brew install node
  node_version_ok || die "Node install completed but 'node -v' still reports an unsupported version. See https://sweir1.github.io/obsidian-brain/install-mac-nontechnical/#step-3-install-node-20."
  ok "Node $(node -v) installed"
fi

# ---------------------------- Step 3: /usr/local/bin symlinks ------------ #

CURRENT_STEP="symlinks"
info "Linking node and npx into /usr/local/bin so GUI apps can find them"
note "Claude Desktop launches with a minimal PATH that sees /usr/local/bin but not /opt/homebrew/bin."
note "You'll be asked for your macOS password (for sudo)."

node_src="$(command -v node)"
npx_src="$(command -v npx)"

sudo mkdir -p /usr/local/bin
sudo ln -sf "$node_src" /usr/local/bin/node
sudo ln -sf "$npx_src"  /usr/local/bin/npx

if /usr/local/bin/node -v >/dev/null 2>&1; then
  ok "/usr/local/bin/node -> $node_src ($(/usr/local/bin/node -v))"
else
  die "Symlink created but /usr/local/bin/node is not executable."
fi

# ---------------------------- Step 4: vault path ------------------------- #

CURRENT_STEP="vault-path"
info "Choosing your Obsidian vault"

validate_vault() {
  local p=$1
  [[ "$p" = /* ]] || { warn "Path must be absolute (start with /). Got: $p"; return 1; }
  [[ -e "$p" ]]   || { warn "Path does not exist: $p"; return 1; }
  [[ -d "$p" ]]   || { warn "Not a directory: $p"; return 1; }
  return 0
}

VAULT=""

# 1) positional arg
if [[ $# -ge 1 && -n "${1:-}" ]]; then
  if validate_vault "$1"; then VAULT="$1"; fi
fi

# 2) env var
if [[ -z "$VAULT" && -n "${VAULT_PATH:-}" ]]; then
  if validate_vault "$VAULT_PATH"; then VAULT="$VAULT_PATH"; fi
fi

# 3) interactive prompt, with suggested candidates
if [[ -z "$VAULT" ]]; then
  candidates=()
  for c in "$HOME/Documents/Obsidian Vault" "$HOME/Documents/Obsidian"; do
    [[ -d "$c" ]] && candidates+=("$c")
  done
  # iCloud Obsidian vaults
  icloud_root="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents"
  if [[ -d "$icloud_root" ]]; then
    while IFS= read -r -d '' d; do
      candidates+=("$d")
    done < <(find "$icloud_root" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
  fi

  if have_tty; then
    printf '\n%sPick your vault:%s\n' "$C_BOLD" "$C_RESET" > /dev/tty
    idx=1
    for c in "${candidates[@]}"; do
      printf '  %d) %s\n' "$idx" "$c" > /dev/tty
      idx=$((idx + 1))
    done
    printf '  %d) Enter a custom path\n' "$idx" > /dev/tty

    while [[ -z "$VAULT" ]]; do
      prompt "Choice [1-$idx]:" choice
      if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 )) && (( choice < idx )); then
        candidate="${candidates[$((choice - 1))]}"
        if validate_vault "$candidate"; then VAULT="$candidate"; fi
      elif [[ "$choice" == "$idx" ]]; then
        prompt "Absolute path to vault:" custom
        if [[ -n "$custom" ]] && validate_vault "$custom"; then VAULT="$custom"; fi
      else
        warn "Invalid choice: $choice"
      fi
    done
  else
    die "No vault path provided and no terminal for prompting. Pass VAULT_PATH env or positional arg."
  fi
fi

# Warn on empty vault, but allow.
if ! find "$VAULT" -maxdepth 3 -type f -name '*.md' -print -quit 2>/dev/null | grep -q .; then
  warn "No .md files found in $VAULT — obsidian-brain will run but search will be empty until you add notes."
fi

ok "Vault: $VAULT"

# ---------------------------- Step 5: pre-warm npx cache ---------------- #

CURRENT_STEP="prewarm-npx"
info "Pre-warming obsidian-brain via npx (downloads ~tarball and rebuilds better-sqlite3 against this Node)"

if /usr/local/bin/npx -y obsidian-brain@latest --version >/tmp/obsidian-brain-install.out 2>&1; then
  ok "obsidian-brain $(cat /tmp/obsidian-brain-install.out | tail -n1) ready"
  rm -f /tmp/obsidian-brain-install.out
else
  cat /tmp/obsidian-brain-install.out >&2 || true
  rm -f /tmp/obsidian-brain-install.out
  cat >&2 <<EOF

Pre-warm of obsidian-brain failed. Most likely cause: a stale npx cache from a
previous Node version. Clean it and re-run this installer:

  rm -rf ~/.npm/_npx

See: https://sweir1.github.io/obsidian-brain/troubleshooting/#err_dlopen_failed-node_module_version-mismatch
EOF
  exit 1
fi

# ---------------------------- Step 6: merge config ----------------------- #

CURRENT_STEP="config-merge"
info "Merging into Claude Desktop config"

CLAUDE_CFG_DIR="$HOME/Library/Application Support/Claude"
CLAUDE_CFG="$CLAUDE_CFG_DIR/claude_desktop_config.json"

mkdir -p "$CLAUDE_CFG_DIR"

if [[ -f "$CLAUDE_CFG" ]]; then
  backup="$CLAUDE_CFG.bak.$(date +%s)"
  cp "$CLAUDE_CFG" "$backup"
  note "Existing config backed up to $backup"
fi

CFG_PATH="$CLAUDE_CFG" VAULT_PATH_VAL="$VAULT" /usr/local/bin/node -e '
  const fs = require("fs");
  const p = process.env.CFG_PATH;
  let cfg = {};
  if (fs.existsSync(p)) {
    try { cfg = JSON.parse(fs.readFileSync(p, "utf8")) || {}; }
    catch (e) {
      console.error("Existing config is not valid JSON — starting fresh (old file preserved in .bak):", e.message);
      cfg = {};
    }
  }
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) cfg = {};
  cfg.mcpServers = cfg.mcpServers || {};
  const prev = cfg.mcpServers["obsidian-brain"];
  cfg.mcpServers["obsidian-brain"] = {
    command: "npx",
    args: ["-y", "obsidian-brain@latest", "server"],
    env: { VAULT_PATH: process.env.VAULT_PATH_VAL }
  };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  console.log(prev ? "replaced" : "added");
' > /tmp/obsidian-brain-cfg.out

cfg_action="$(cat /tmp/obsidian-brain-cfg.out)"
rm -f /tmp/obsidian-brain-cfg.out
ok "Claude Desktop config: $cfg_action obsidian-brain entry ($CLAUDE_CFG)"

# ---------------------------- Step 7: Full Disk Access ------------------ #

CURRENT_STEP="full-disk-access"
info "Granting Claude Desktop Full Disk Access"

cat <<EOF

${C_BOLD}macOS requires you to toggle this by hand — it's a kernel-enforced permission
(TCC) that no script can grant, not even with sudo.${C_RESET}

Opening System Settings → Privacy & Security → Full Disk Access now.

EOF

FDA_URL_MODERN="x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"
FDA_URL_LEGACY="x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
open "$FDA_URL_MODERN" 2>/dev/null || open "$FDA_URL_LEGACY" 2>/dev/null || open -a "System Settings" || warn "Couldn't open System Settings automatically — open it manually."

cat <<EOF
In the Full Disk Access list:

  1. If ${C_BOLD}Claude${C_RESET} is listed   → flip its toggle ${C_BOLD}ON${C_RESET}.
  2. If Claude is ${C_BOLD}not${C_RESET} listed → click the ${C_BOLD}+${C_RESET} button, choose
                            Applications → Claude.app, then toggle ON.
  3. If you also use Cursor / Jan / other MCP clients — toggle those ON too.

Without Full Disk Access the embedding-model download will hang silently and
search will return zero results (see
https://sweir1.github.io/obsidian-brain/troubleshooting/#macos-vault-reads-fail-or-the-embedding-model-download-hangs-silently).

EOF

pause_enter "Press Enter once Claude is toggled ON in the Full Disk Access list..."

ok "Continuing — will relaunch Claude Desktop so the new permission takes effect"

# ---------------------------- Step 8: relaunch Claude ------------------- #

CURRENT_STEP="relaunch"
info "Restarting Claude Desktop"

if [[ -d "/Applications/Claude.app" ]]; then
  osascript -e 'tell application "Claude" to quit' >/dev/null 2>&1 || true
  # Give it a moment to shut down; a polite quit should land in under a second.
  sleep 2
  open -a "Claude"
  ok "Claude Desktop launched"
else
  warn "Claude Desktop is not installed at /Applications/Claude.app"
  note "Download it from https://claude.ai/download — your config is already in place and will work when you install it."
fi

# ---------------------------- Step 9: summary --------------------------- #

CURRENT_STEP="summary"
trap - ERR

cat <<EOF

${C_GREEN}${C_BOLD}✓ obsidian-brain is now wired into Claude Desktop.${C_RESET}

   Vault: ${C_BOLD}$VAULT${C_RESET}
   Config: ${C_DIM}$CLAUDE_CFG${C_RESET}

${C_BOLD}First launch:${C_RESET} Claude Desktop downloads a ~34 MB embedding model and
indexes your vault. Tools may take 30–60 seconds to appear in the palette.
This is normal — see https://sweir1.github.io/obsidian-brain/#first-boot.

${C_BOLD}Try it out:${C_RESET}
   Open Claude Desktop, then say:
   "Use search to find notes about the most recent thing I wrote."

${C_BOLD}Installing for other MCP clients${C_RESET} (Cursor, Claude Code, VS Code, Jan, …)?
   https://sweir1.github.io/obsidian-brain/install-clients/

${C_BOLD}Troubleshooting:${C_RESET}
   https://sweir1.github.io/obsidian-brain/troubleshooting/

EOF
