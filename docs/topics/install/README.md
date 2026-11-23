# Installing and releasing

agent-hub runs from an installed **runtime** at `~/.agent-hub/` (override with `--prefix`), linked
as `~/.local/bin/sync-agents` (override with `--bin-dir`). The runtime has one of two layouts, and
`./install.sh` from a checkout installs either. This page is the reference for both and for how
releases are built. Contracts are tracked in [test-plan.md](test-plan.md).

## Layouts

| Layout | Installed with | What the runtime holds | Needs Bun at run time |
| --- | --- | --- | --- |
| `source` | `./install.sh` | `bin/sync-agents` (a Bash wrapper) and the TypeScript sources | Yes, except `--help` and `--print-dir` |
| `binary` | `./install.sh --binary <file>` | One standalone `sync-agents` executable built with `bun build --compile` | No |

The runtime's `.agent-hub-runtime` marker records the layout. Each run of `install.sh` installs
the layout you ask for: a later plain `./install.sh` switches a binary install back to the source
layout, and `--binary` switches a source install to the binary. The previous runtime is replaced
as a whole, including any `src/mcp-sync.ts` that only the source layout has.

`install.sh` itself is a Bash script and runs offline. What it needs besides Bash:

- **Swap.** It replaces an existing runtime with one atomic directory exchange (`renamex_np` on
  macOS, `renameat2` on Linux), run by Bun or, with `--binary` and no Bun, by the verified binary
  itself (`BUN_BE_BUN=1`). Only a source-layout install without Bun falls back to two renames,
  leaving an instant with no runtime; if it is killed in between, the previous runtime is in
  `<parent of prefix>/.agent-hub-old.XXXXXX/prev` (on a normal exit or `SIGTERM` that
  backup is cleaned up).
- **Source layout.** Installing or syncing the bundled skill runs the Bun sources, so a source
  install without Bun needs `--no-skill`; the binary layout needs no Bun at all.
- **`--agents-dir`** writes `config.json` with Bun or `python3`. When `config.json` exists but
  neither is available, `bin/sync-agents --print-dir` (which `install.sh` uses for its hub-overlap
  check) refuses rather than guessing; with `--binary`, `install.sh` also checks the binary's own
  view of the hub.
- **Paths.** A relative path is resolved against the physical current directory, and a path
  containing a newline is refused, so `install.sh`, the wrapper and the engine always name the
  same directory.

## Installing a release binary

Releases on GitHub carry one binary per platform (`sync-agents-darwin-arm64`,
`sync-agents-darwin-x64`, `sync-agents-linux-x64`, `sync-agents-linux-arm64`), the bundled skill
as `agent-hub-skill.tar.gz`, and `SHA256SUMS`.

1. **Check the bytes.** Compare the download with its line in `SHA256SUMS`:

   ```bash
   grep ' sync-agents-darwin-arm64$' SHA256SUMS | shasum -a 256 -c -    # macOS
   grep ' sync-agents-linux-x64$' SHA256SUMS | sha256sum -c -           # Linux
   ```

   A checksum proves the file matches what the release workflow uploaded. It does not, by
   itself, prove who built it.
2. **Check where it was built.** Each asset has a GitHub build-provenance attestation:

   ```bash
   gh attestation verify sync-agents-darwin-arm64 --repo flyingrobots/agent-hub
   ```

3. **Make it runnable.** Downloads lose the executable bit: `chmod +x sync-agents-darwin-arm64`.
   On macOS a downloaded file also carries `com.apple.quarantine`; after checking it, clear that
   with `xattr -d com.apple.quarantine sync-agents-darwin-arm64`.
4. **Install it**, from a checkout of the same tag (the checkout supplies the bundled skill):

   ```bash
   ./install.sh --binary ./sync-agents-darwin-arm64
   ```

**The binaries are unsigned.** They carry no developer identity and are not notarized; the macOS
builds have only an ad-hoc signature, which macOS requires to run them.

What each asset was tested on before release: `linux-x64`, `linux-arm64` and `darwin-arm64` ran
the compiled-binary suite and the end-to-end suites on native runners. `darwin-x64` is
cross-compiled on Apple silicon and was at most smoke-tested with `--help`. `linux-x64` may need a
CPU with AVX2.

### What `--binary` checks

Before installing, `install.sh --binary <file>` refuses:

- a file that is missing or not executable;
- a file that is not a native executable (it checks for an ELF or Mach-O header, so scripts are
  refused);
- on macOS, a file still carrying `com.apple.quarantine`, with the `xattr` command to run;
- a program whose `--help` does not print the `sync-agents` usage line.

These checks catch mistakes. They do not authenticate the binary; the checksum and attestation
do that. The prefix, shim and marker guards described in the [README](../../../README.md#install)
apply to both layouts.

## Building a binary locally

```bash
bun run build:bin          # writes dist/sync-agents for this machine
./install.sh --binary dist/sync-agents
```

`build:bin` compiles inside `dist/` and removes the temporary file Bun 1.4.5 leaves behind.

## How releases are cut

Pushing a tag `v<version>` runs `.github/workflows/release.yml`:

1. **Verify.** The tag must equal `v` + the `version` in `package.json`, its commit must be on
   `main`, and no release (or draft) may already exist for it. Published assets are never
   replaced; a mistake is fixed with a new version.
2. **Build.** Each platform is compiled with Bun 1.4.5, the macOS builds are ad-hoc signed, and
   native builds run the compiled-binary and end-to-end suites against the exact artifact.
3. **Publish.** `SHA256SUMS` and provenance attestations are generated, and everything is
   uploaded to a draft release that is published only once all uploads succeed.

Before tagging, bump `version` in `package.json` and move the `[Unreleased]` entries in
[CHANGELOG.md](../../../CHANGELOG.md) under the new version.
