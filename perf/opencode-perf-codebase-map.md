# OpenCode Perf Codebase Map

Purpose: stop re-finding the same perf/debug paths.

## Fast Local Workflow

- Host-only binary build: `cd packages/opencode && bun run build:host`
- Fast host-only perf build: `cd packages/opencode && bun run build:perf`
- Perf harness entrypoint: `packages/opencode/script/perf-run.ts`
- Canonical perf log: `perf/opencode-runtime-performance-results.md`
- Perf artifacts root: `packages/opencode/.artifacts/perf/`

## Common Questions

### Where does the perf harness live?

- File: `packages/opencode/script/perf-run.ts`
- Main orchestration:
  - `runOnce()` spawns clients, samples processes, writes artifacts
  - `spawnOpencode()` builds CLI args for `run --interactive`
  - `isolatedEnv()` sets test config and perf env vars
  - `stopInteractiveWhenSettled()` decides when to kill TUI clients after model completion
  - `summarize()` computes CPU/RSS and timing summary fields

### Where does binary build behavior live?

- File: `packages/opencode/script/build.ts`
- Current-platform build selection:
  - `--single`
  - alias: `--host-only`
- Package scripts:
  - `build` builds all targets
  - `build:host` builds current platform only
  - `build:perf` builds current platform only and skips install/embed work for faster local perf iteration

### What path does `run --interactive` use?

- CLI entry: `packages/opencode/src/cli/cmd/run.ts`
- Runtime orchestrator: `packages/opencode/src/cli/cmd/run/runtime.ts`
- Renderer lifecycle boot/shutdown: `packages/opencode/src/cli/cmd/run/runtime.lifecycle.ts`
- Prompt queue / turn lifecycle: `packages/opencode/src/cli/cmd/run/runtime.queue.ts`
- Stream transport from SDK events into footer commits: `packages/opencode/src/cli/cmd/run/stream.transport.ts`

### Where does visible transcript rendering happen?

- Footer queue + completion handoff: `packages/opencode/src/cli/cmd/run/footer.ts`
- Retained streaming surface hotspot: `packages/opencode/src/cli/cmd/run/scrollback.surface.ts`
- Static scrollback writer for non-retained entries: `packages/opencode/src/cli/cmd/run/scrollback.writer.tsx`
- Body selection (`text` vs `markdown` vs `code`): `packages/opencode/src/cli/cmd/run/entry.body.ts`
- Shared entry styling/syntax helpers: `packages/opencode/src/cli/cmd/run/scrollback.shared.ts`

### What function has been the main owned hotspot?

- File: `packages/opencode/src/cli/cmd/run/scrollback.surface.ts`
- Function/class area:
  - `RunScrollbackStream.writeStreaming()`
  - `RunScrollbackStream.flushActive()`

### Where do timing and memory perf markers live now?

- Heap/memory checkpoints: `packages/opencode/src/cli/cmd/run/perf.heap.ts`
- Timing markers: `packages/opencode/src/cli/cmd/run/perf.timing.ts`
- Current timing markers:
  - `boot_complete`
  - `first_visible`
  - `last_visible`
  - `final_rich_start`
  - `final_rich_done`

### Where does markdown finalization scheduling live?

- File: `packages/opencode/src/cli/cmd/run/footer.ts`
- Final scrollback completion path:
  - `completeScrollback()`
  - `scheduleCompleteScrollback()`
- Perf harness flag:
  - `--md-finalize-mode immediate|never|defer:N`

### Where do source-vs-binary differences come from?

- Source runner command is assembled in `packages/opencode/script/perf-run.ts` via `opencodeCommand()`.
- Binary runner path points at:
  - `packages/opencode/dist/opencode-darwin-arm64/bin/opencode` on this machine
- Important: after code changes, rebuild before trusting binary perf results.

### Where is the repeated TUI boot work?

- `runtime.lifecycle.ts`
  - renderer creation
  - theme resolution
  - splash
  - footer creation
- `runtime.ts`
  - session/model/bootstrap
  - stream transport lazy init

### Where do attach-mode costs live?

- Harness attach startup: `packages/opencode/script/perf-run.ts`
  - `startOpencodeServer()`
  - `waitForServer()`
- Shared-server result interpretation is logged in `perf/opencode-runtime-performance-results.md`

### Where are OpenTUI internals if the bug is outside OpenCode?

- Package dependency, not repo source:
  - `packages/opencode/node_modules/@opentui/core`
- Relevant owned calls into it:
  - `MarkdownRenderable`
  - `CodeRenderable`
  - `TextRenderable`
  - `ScrollbackSurface.commitRows()`
  - `ScrollbackSurface.settle()`

## Repeated Findings To Reuse

- Do not default back to FPS/thread/static-render knobs.
- Do not default back to global `plain|final` stream mode switches.
- Do not default back to surface-reset markdown experiments.
- For binary perf, rebuild first, then run harness.
- For user-visible speed, check `first_visible` and `last_visible`, not only total `duration_ms`.

## Good Starting Commands

- Fast local binary rebuild:
  - `cd packages/opencode && bun run build:perf`
- Binary text timing check:
  - `cd packages/opencode && bun run script/perf-run.ts --mode tui --scenario text --runner binary --instances 10 --timeout-ms 80000 --settle-ms 10000 --sample-ms 500 --md-finalize-mode immediate`
- Binary task timing check:
  - `cd packages/opencode && bun run script/perf-run.ts --mode tui --scenario task-ts --runner binary --instances 10 --timeout-ms 120000 --settle-ms 10000 --sample-ms 500 --md-finalize-mode immediate`
- Binary lsp timing check:
  - `cd packages/opencode && bun run script/perf-run.ts --mode tui --scenario lsp-ts --runner binary --instances 10 --enable-lsp true --disable-lsp-download true --timeout-ms 120000 --settle-ms 1000 --sample-ms 500 --md-finalize-mode immediate`
