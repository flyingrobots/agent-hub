#!/usr/bin/env bash
set -euo pipefail

# Install agent-hub into an isolated runtime directory (default ~/.agent-hub)
# so WIP edits in the source checkout never affect your live sync-agents binary.

REPO_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${AGENT_HUB_HOME:-$HOME/.agent-hub}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
INSTALL_SKILL=1
NO_SYNC=0
FORCE_SKILL=0
REPLACE_RUNTIME=0
REPLACE_BIN=0
CONFIG_AGENTS_DIR=""

# Exact verified SHA-256 checksums of the unmarked baseline (3cbd0a8) runtime layout.
BASELINE_SYNC_AGENTS_SHA="51809dbb339dd536b44b9a45f934ae053bfc52e978f263a8e1b473496c36cb74"
BASELINE_MCP_SYNC_SHA="fc05afd6ae6d9a694d4dd92d5f4309d3855a05b4411a2fb7b31cf30ebd778266"
BASELINE_SKILL_MD_SHA="189867c8181c94aec0c3586983e7491f20e6cf29e75568427ffdea299e70701c"

usage() {
  cat <<'EOF'
Usage: ./install.sh [OPTIONS]

Install agent-hub into ~/.agent-hub and symlink ~/.local/bin/sync-agents.

Options:
  --prefix <dir>        Install directory (default: ~/.agent-hub)
  --bin-dir <dir>       Directory for sync-agents symlink (default: ~/.local/bin)
  --agents-dir <dir>    Write ~/.config/agent-hub/config.json pointing to <dir>
  --no-skill            Skip installing skills/agent-hub into your agents hub
  --no-sync             Install bundled skill (--skill-only) without syncing agent targets
  --force-skill         Allow replacing a customized bundled agent-hub skill ONLY
                        (never forwards global --force to MCP or symlink sync)
  --replace-runtime     Move aside an unrecognized existing --prefix directory as a backup
                        before installing
  --replace-bin         Replace an unrecognized existing file/symlink at <bin-dir>/sync-agents
  -h, --help            Show this help
EOF
}

require_arg() {
  local opt="$1"
  local remaining="$2"
  if [[ "$remaining" -lt 2 ]]; then
    echo "install.sh: $opt requires an argument" >&2
    usage >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      require_arg "--prefix" "$#"
      INSTALL_DIR="$2"
      shift
      ;;
    --prefix=*)
      INSTALL_DIR="${1#--prefix=}"
      if [[ -z "$INSTALL_DIR" ]]; then
        echo "install.sh: --prefix requires a non-empty argument" >&2
        exit 2
      fi
      ;;
    --bin-dir)
      require_arg "--bin-dir" "$#"
      BIN_DIR="$2"
      shift
      ;;
    --bin-dir=*)
      BIN_DIR="${1#--bin-dir=}"
      if [[ -z "$BIN_DIR" ]]; then
        echo "install.sh: --bin-dir requires a non-empty argument" >&2
        exit 2
      fi
      ;;
    --agents-dir)
      require_arg "--agents-dir" "$#"
      CONFIG_AGENTS_DIR="$2"
      shift
      ;;
    --agents-dir=*)
      CONFIG_AGENTS_DIR="${1#--agents-dir=}"
      if [[ -z "$CONFIG_AGENTS_DIR" ]]; then
        echo "install.sh: --agents-dir requires a non-empty argument" >&2
        exit 2
      fi
      ;;
    --no-skill)        INSTALL_SKILL=0 ;;
    --no-sync)         NO_SYNC=1 ;;
    --force-skill)     FORCE_SKILL=1 ;;
    --replace-runtime) REPLACE_RUNTIME=1 ;;
    --replace-bin)     REPLACE_BIN=1 ;;
    -h|--help)         usage; exit 0 ;;
    *)                 echo "install.sh: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

expand_tilde() {
  local p="$1"
  case "$p" in
    "~")   printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${p:2}" ;;
    *)     printf '%s\n' "$p" ;;
  esac
}

canonicalize_path() {
  local raw="$1"
  local p
  p="$(expand_tilde "$raw")"
  case "$p" in
    /*) ;;
    *)  p="$PWD/$p" ;;
  esac

  local tail=()
  local cursor="$p"
  while true; do
    if [[ -e "$cursor" ]]; then
      local real_base
      if [[ -d "$cursor" ]]; then
        real_base="$(cd -P "$cursor" && pwd)"
      else
        real_base="$(cd -P "$(dirname "$cursor")" && pwd)/$(basename "$cursor")"
      fi
      local out="$real_base"
      local idx=$(( ${#tail[@]} - 1 ))
      while [[ "$idx" -ge 0 ]]; do
        if [[ "$out" == "/" ]]; then
          out="/${tail[$idx]}"
        else
          out="$out/${tail[$idx]}"
        fi
        idx=$((idx - 1))
      done
      if [[ "$out" != "/" ]]; then
        out="${out%/}"
      fi
      printf '%s\n' "$out"
      return 0
    fi
    local parent
    parent="$(dirname "$cursor")"
    if [[ "$parent" == "$cursor" ]]; then
      printf '%s\n' "$p"
      return 0
    fi
    local base
    base="$(basename "$cursor")"
    if [[ "$base" != "." && -n "$base" ]]; then
      tail+=("$base")
    fi
    cursor="$parent"
  done
}

sha256_file() {
  local f="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  else
    return 1
  fi
}

is_verified_runtime_marker() {
  local dir="$1"
  local marker="$dir/.agent-hub-runtime"
  [[ -f "$marker" ]] || return 1
  grep -q '"product"[[:space:]]*:[[:space:]]*"agent-hub"' "$marker" &&
    grep -q '"kind"[[:space:]]*:[[:space:]]*"runtime"' "$marker"
}

is_verified_baseline_v0_runtime() {
  local dir="$1"
  [[ -f "$dir/bin/sync-agents" && -f "$dir/src/mcp-sync.ts" && -f "$dir/skills/agent-hub/SKILL.md" ]] || return 1

  local file_count
  file_count="$(find "$dir" \( -type f -o -type l \) | wc -l | tr -d '[:space:]')"
  [[ "$file_count" == "3" ]] || return 1

  local s1 s2 s3
  s1="$(sha256_file "$dir/bin/sync-agents")" || return 1
  s2="$(sha256_file "$dir/src/mcp-sync.ts")" || return 1
  s3="$(sha256_file "$dir/skills/agent-hub/SKILL.md")" || return 1

  [[ "$s1" == "$BASELINE_SYNC_AGENTS_SHA" && "$s2" == "$BASELINE_MCP_SYNC_SHA" && "$s3" == "$BASELINE_SKILL_MD_SHA" ]]
}

paths_overlap() {
  local a="$1"
  local b="$2"
  [[ "$a" == "$b" || "$a" == "$b/"* || "$b" == "$a/"* ]]
}

# Single-syscall atomic directory swap (macOS renamex_np RENAME_SWAP / Linux renameat2 RENAME_EXCHANGE)
# so $INSTALL_DIR is never absent during upgrade. Returns non-zero if unsupported so caller can fall back.
try_atomic_dir_exchange() {
  local a="$1"
  local b="$2"
  command -v bun >/dev/null 2>&1 || return 1
  bun -e '
    import { dlopen, FFIType, ptr } from "bun:ffi";
    const [a, b] = process.argv.slice(1);
    const ab = Buffer.from(`${a}\0`);
    const bb = Buffer.from(`${b}\0`);
    if (process.platform === "darwin") {
      const lib = dlopen("libSystem.B.dylib", {
        renamex_np: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
      });
      const rc = lib.symbols.renamex_np(ptr(ab), ptr(bb), 0x00000002);
      process.exit(rc === 0 ? 0 : 1);
    } else if (process.platform === "linux") {
      const AT_FDCWD = -100;
      const RENAME_EXCHANGE = 2;
      const lib = dlopen("libc.so.6", {
        renameat2: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
          returns: FFIType.i32,
        },
      });
      const rc = lib.symbols.renameat2(AT_FDCWD, ptr(ab), AT_FDCWD, ptr(bb), RENAME_EXCHANGE);
      process.exit(rc === 0 ? 0 : 1);
    }
    process.exit(1);
  ' "$a" "$b" >/dev/null 2>&1
}

INSTALL_DIR="$(canonicalize_path "$INSTALL_DIR")"
BIN_DIR="$(canonicalize_path "$BIN_DIR")"
CANON_HOME="$(canonicalize_path "$HOME")"

if [[ -n "$CONFIG_AGENTS_DIR" ]]; then
  HUB_DIR="$(canonicalize_path "$CONFIG_AGENTS_DIR")"
else
  HUB_DIR="$("$REPO_DIR/bin/sync-agents" --print-dir)"
fi

if [[ "$INSTALL_DIR" == "/" || "$INSTALL_DIR" == "$CANON_HOME" ]]; then
  echo "install.sh: refusing unsafe --prefix: $INSTALL_DIR" >&2
  exit 1
fi

if paths_overlap "$INSTALL_DIR" "$HUB_DIR"; then
  echo "install.sh: refusing --prefix ($INSTALL_DIR) that overlaps hub directory ($HUB_DIR)" >&2
  exit 1
fi

PREFIX_STATUS="absent"
if [[ -L "$INSTALL_DIR" || -f "$INSTALL_DIR" ]]; then
  echo "install.sh: refusing to replace non-directory at --prefix: $INSTALL_DIR" >&2
  exit 1
elif [[ -d "$INSTALL_DIR" ]]; then
  if [[ -z "$(ls -A "$INSTALL_DIR")" ]]; then
    PREFIX_STATUS="empty"
  elif is_verified_runtime_marker "$INSTALL_DIR"; then
    PREFIX_STATUS="verified-marker"
  elif is_verified_baseline_v0_runtime "$INSTALL_DIR"; then
    PREFIX_STATUS="verified-baseline-v0"
  elif [[ "$REPLACE_RUNTIME" -eq 1 ]]; then
    PREFIX_STATUS="backup-replace"
  else
    echo "install.sh: refusing to replace unrecognized directory $INSTALL_DIR (missing .agent-hub-runtime marker; pass --replace-runtime to move it aside as a backup)" >&2
    exit 1
  fi
fi

# Check existing <bin-dir>/sync-agents shim authority, resolving relative symlinks
# against dirname "$SHIM_PATH" (NEVER $PWD).
SHIM_PATH="$BIN_DIR/sync-agents"
if [[ -e "$SHIM_PATH" || -L "$SHIM_PATH" ]]; then
  SHIM_ALLOWED=0
  if [[ -L "$SHIM_PATH" ]]; then
    SHIM_TARGET="$(readlink "$SHIM_PATH")"
    case "$SHIM_TARGET" in
      /*) SHIM_RESOLVED="$(canonicalize_path "$SHIM_TARGET")" ;;
      *)  SHIM_RESOLVED="$(canonicalize_path "$(dirname "$SHIM_PATH")/$SHIM_TARGET")" ;;
    esac
    if [[ "$SHIM_RESOLVED" == "$INSTALL_DIR/bin/sync-agents" ]]; then
      SHIM_ALLOWED=1
    else
      SHIM_TARGET_DIR="$(dirname "$(dirname "$SHIM_RESOLVED")")"
      if [[ -d "$SHIM_TARGET_DIR" ]] && { is_verified_runtime_marker "$SHIM_TARGET_DIR" || is_verified_baseline_v0_runtime "$SHIM_TARGET_DIR"; }; then
        SHIM_ALLOWED=1
      fi
    fi
  fi
  if [[ "$SHIM_ALLOWED" -ne 1 && "$REPLACE_BIN" -ne 1 ]]; then
    echo "install.sh: refusing to overwrite unrecognized file/symlink at $SHIM_PATH (pass --replace-bin to replace)" >&2
    exit 1
  fi
fi

PARENT_DIR="$(dirname "$INSTALL_DIR")"
mkdir -p "$PARENT_DIR" "$BIN_DIR"

STAGE_DIR="$(mktemp -d "$PARENT_DIR/.agent-hub-stage.XXXXXX")"
QUARANTINE_DIR=""
TMP_SHIM=""
cleanup() {
  if [[ -n "${TMP_SHIM:-}" && -L "$TMP_SHIM" ]]; then
    rm -f "$TMP_SHIM"
  fi
  if [[ -n "${STAGE_DIR:-}" && -d "$STAGE_DIR" ]]; then
    rm -rf "$STAGE_DIR"
  fi
  if [[ -n "${QUARANTINE_DIR:-}" && -d "$QUARANTINE_DIR" ]]; then
    rm -rf "$QUARANTINE_DIR"
  fi
}
trap cleanup EXIT

mkdir -p "$STAGE_DIR/bin" "$STAGE_DIR/src" "$STAGE_DIR/skills"
cp "$REPO_DIR/bin/sync-agents" "$STAGE_DIR/bin/sync-agents"
cp "$REPO_DIR"/src/*.ts "$STAGE_DIR/src/"
cp -R "$REPO_DIR/skills/agent-hub" "$STAGE_DIR/skills/agent-hub"

INSTALLED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
cat > "$STAGE_DIR/.agent-hub-runtime" <<EOF
{
  "schemaVersion": 1,
  "product": "agent-hub",
  "kind": "runtime",
  "installedAt": "$INSTALLED_AT"
}
EOF

chmod 755 "$STAGE_DIR" "$STAGE_DIR/bin/sync-agents" "$STAGE_DIR/src/cli.ts" "$STAGE_DIR/src/mcp-sync.ts"

if [[ "$PREFIX_STATUS" == "backup-replace" ]]; then
  PRESERVED_BACKUP="${INSTALL_DIR}.backup-$(date -u +"%Y%m%dT%H%M%SZ")"
  if try_atomic_dir_exchange "$STAGE_DIR" "$INSTALL_DIR"; then
    mv "$STAGE_DIR" "$PRESERVED_BACKUP"
    STAGE_DIR=""
  else
    mv "$INSTALL_DIR" "$PRESERVED_BACKUP"
    if ! mv "$STAGE_DIR" "$INSTALL_DIR"; then
      mv "$PRESERVED_BACKUP" "$INSTALL_DIR" || true
      exit 1
    fi
    STAGE_DIR=""
  fi
  echo "[install] moved previous prefix -> $PRESERVED_BACKUP"
elif [[ "$PREFIX_STATUS" != "absent" ]]; then
  if [[ "$PREFIX_STATUS" == "verified-baseline-v0" ]]; then
    echo "[install] upgrading verified baseline runtime at $INSTALL_DIR"
  fi
  if try_atomic_dir_exchange "$STAGE_DIR" "$INSTALL_DIR"; then
    # STAGE_DIR now holds the previous runtime; cleanup removes it cleanly.
    rm -rf "$STAGE_DIR"
    STAGE_DIR=""
  else
    # Safe quarantine swap without mktemp/rmdir TOCTOU: move old dir INSIDE 0700 mktemp dir.
    QUARANTINE_DIR="$(mktemp -d "$PARENT_DIR/.agent-hub-old.XXXXXX")"
    mv "$INSTALL_DIR" "$QUARANTINE_DIR/prev"
    if ! mv "$STAGE_DIR" "$INSTALL_DIR"; then
      mv "$QUARANTINE_DIR/prev" "$INSTALL_DIR" || true
      exit 1
    fi
    STAGE_DIR=""
    rm -rf "$QUARANTINE_DIR"
    QUARANTINE_DIR=""
  fi
else
  mv "$STAGE_DIR" "$INSTALL_DIR"
  STAGE_DIR=""
fi

# Atomic symlink replacement for <bin-dir>/sync-agents.
TMP_SHIM="$BIN_DIR/.sync-agents-shim.$$.$RANDOM"
ln -s "$INSTALL_DIR/bin/sync-agents" "$TMP_SHIM"
mv -f "$TMP_SHIM" "$SHIM_PATH"
TMP_SHIM=""

echo "[install] agent-hub -> $INSTALL_DIR"
echo "[install] symlink   -> $SHIM_PATH"

if [[ -n "$CONFIG_AGENTS_DIR" ]]; then
  CFG_DIR="$HOME/.config/agent-hub"
  if [[ "${XDG_CONFIG_HOME:-}" == /* ]]; then CFG_DIR="$XDG_CONFIG_HOME/agent-hub"; fi
  CFG_FILE="$CFG_DIR/config.json"
  mkdir -p "$CFG_DIR"
  if command -v bun >/dev/null 2>&1; then
    bun -e '
      import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
      const [cfgPath, agentsDir] = process.argv.slice(1);
      let obj: Record<string, unknown> = {};
      if (existsSync(cfgPath)) {
        const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          obj = parsed as Record<string, unknown>;
        }
      }
      obj.agentsDir = agentsDir;
      const tmp = `${cfgPath}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o644 });
      renameSync(tmp, cfgPath);
    ' "$CFG_FILE" "$CONFIG_AGENTS_DIR"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c '
import json, os, sys
cfg_path, agents_dir = sys.argv[1], sys.argv[2]
obj = {}
if os.path.exists(cfg_path):
    with open(cfg_path, "r", encoding="utf-8") as f:
        parsed = json.load(f)
        if isinstance(parsed, dict):
            obj = parsed
obj["agentsDir"] = agents_dir
tmp = f"{cfg_path}.{os.getpid()}.tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(obj, f, indent=2)
    f.write("\n")
os.replace(tmp, cfg_path)
' "$CFG_FILE" "$CONFIG_AGENTS_DIR"
  else
    echo "install.sh: bun or python3 is required to write $CFG_FILE safely" >&2
    exit 1
  fi
  echo "[install] config    -> $CFG_FILE ($CONFIG_AGENTS_DIR)"
fi

HUB_DIR="$("$SHIM_PATH" --print-dir)"
if [[ "$INSTALL_SKILL" -eq 1 && -d "$HUB_DIR" ]]; then
  SYNC_ARGS=(--skill "$INSTALL_DIR/skills/agent-hub")
  if [[ "$FORCE_SKILL" -eq 1 ]]; then
    SYNC_ARGS+=(--force-skill)
  fi
  if [[ "$NO_SYNC" -eq 1 ]]; then
    SYNC_ARGS+=(--skill-only)
  fi
  "$SHIM_PATH" "${SYNC_ARGS[@]}"
fi
