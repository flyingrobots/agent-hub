#!/usr/bin/env bash
set -euo pipefail

# Install agent-hub into an isolated runtime directory (default ~/.agent-hub)
# so WIP edits in the source checkout never affect your live sync-agents binary.

REPO_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${AGENT_HUB_HOME:-$HOME/.agent-hub}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
INSTALL_SKILL=1
CONFIG_AGENTS_DIR=""

usage() {
  cat <<'EOF'
Usage: ./install.sh [OPTIONS]

Install agent-hub into ~/.agent-hub and symlink ~/.local/bin/sync-agents.

Options:
  --prefix <dir>        Install directory (default: ~/.agent-hub)
  --bin-dir <dir>       Directory for sync-agents symlink (default: ~/.local/bin)
  --agents-dir <dir>    Write ~/.config/agent-hub/config.json pointing to <dir>
  --no-skill            Skip installing skills/agent-hub into your agents hub
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)     INSTALL_DIR="$2"; shift ;;
    --bin-dir)    BIN_DIR="$2"; shift ;;
    --agents-dir) CONFIG_AGENTS_DIR="$2"; shift ;;
    --no-skill)   INSTALL_SKILL=0 ;;
    -h|--help)    usage; exit 0 ;;
    *)            echo "install.sh: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

PARENT_DIR="$(dirname "$INSTALL_DIR")"
mkdir -p "$PARENT_DIR" "$BIN_DIR"

STAGE_DIR="$(mktemp -d "$PARENT_DIR/.agent-hub-stage.XXXXXX")"
cleanup() {
  if [[ -n "${STAGE_DIR:-}" && -d "$STAGE_DIR" ]]; then
    rm -rf "$STAGE_DIR"
  fi
}
trap cleanup EXIT

mkdir -p "$STAGE_DIR/bin" "$STAGE_DIR/src" "$STAGE_DIR/skills"
cp "$REPO_DIR/bin/sync-agents" "$STAGE_DIR/bin/sync-agents"
cp "$REPO_DIR/src/mcp-sync.ts" "$STAGE_DIR/src/mcp-sync.ts"
cp -R "$REPO_DIR/skills/agent-hub" "$STAGE_DIR/skills/agent-hub"
chmod 755 "$STAGE_DIR" "$STAGE_DIR/bin/sync-agents" "$STAGE_DIR/src/mcp-sync.ts"

rm -rf "$INSTALL_DIR"
mv "$STAGE_DIR" "$INSTALL_DIR"
STAGE_DIR=""

ln -sfn "$INSTALL_DIR/bin/sync-agents" "$BIN_DIR/sync-agents"
echo "[install] agent-hub -> $INSTALL_DIR"
echo "[install] symlink   -> $BIN_DIR/sync-agents"

if [[ -n "$CONFIG_AGENTS_DIR" ]]; then
  CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agent-hub"
  mkdir -p "$CFG_DIR"
  printf '{\n  "agentsDir": "%s"\n}\n' "$CONFIG_AGENTS_DIR" > "$CFG_DIR/config.json"
  echo "[install] config    -> $CFG_DIR/config.json ($CONFIG_AGENTS_DIR)"
fi

HUB_DIR="$("$BIN_DIR/sync-agents" --print-dir)"
if [[ "$INSTALL_SKILL" -eq 1 && -d "$HUB_DIR" ]]; then
  "$BIN_DIR/sync-agents" --force --skill "$INSTALL_DIR/skills/agent-hub"
fi
