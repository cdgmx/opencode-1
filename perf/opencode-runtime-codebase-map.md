# OpenCode Runtime Codebase Map

Purpose: fast lookup for the files and functions we keep re-finding during runtime and perf work.

## Fast Commands

- Run perf harness: `bun run perf:run`
- Build local binary only: `bun run build:local`
- Build local binary with dependency refresh: `bun run build:local:fresh`
- Typecheck package: `bun typecheck`

## Common Questions

### Where does the perf harness live?

- Harness entry: `packages/opencode/script/perf-run.ts`
- Main functions:
  - `runOnce()`: spawn processes, collect logs, sample CPU/RSS, write artifacts
  - `isolatedEnv()`: per-run env wiring for test config, perf flags, timing files, memory files
  - `stopInteractiveWhenSettled()`: process-stop heuristic for TUI mode
  - `summarize()`: top-line metrics in `summary.json`
- Artifacts root: `packages/opencode/.artifacts/perf/`

### Where do binary builds come from?

- Build script: `packages/opencode/script/build.ts`
- Package scripts: `packages/opencode/package.json`
- Useful flags:
  - `--local` or `--single`: current host platform only
  - `--skip-install`: skip cross-platform dependency reinstall
  - `--skip-embed-web-ui`: diagnostic only, not default for perf fidelity
- Current fast loop on this Mac:
  - `bun run build:local`

### Where does interactive `run --interactive` start?

- Main runtime orchestrator: `packages/opencode/src/cli/cmd/run/runtime.ts`
- Key areas:
  - creates shell/footer lifecycle
  - boots stream transport lazily
  - passes `onVisibleOutput`
  - owns high-level turn flow and close path

### Where is renderer boot / TUI lifecycle?

- Renderer lifecycle: `packages/opencode/src/cli/cmd/run/runtime.lifecycle.ts`
- Main function: `createRuntimeLifecycle()`
- Responsibilities:
  - create `CliRenderer`
  - splash screen
  - create `RunFooter`
  - set FPS/thread config from env

### Where is prompt queue / turn timing?

- Queue runner: `packages/opencode/src/cli/cmd/run/runtime.queue.ts`
- Main function: `runPromptQueue()`
- Responsibilities:
  - prompt send / active turn state
  - `turn.send`, `turn.wait`, `turn.idle`, `turn.duration`
  - heap checkpoints like `before-turn`, `after-turn`, `idle`

### Where do SDK events become scrollback commits?

- Stream transport: `packages/opencode/src/cli/cmd/run/stream.transport.ts`
- Main function: `createSessionTransport()`
- Important internal function: `applyEvent()`
- Reducer entry: `reduceSessionData()` in `packages/opencode/src/cli/cmd/run/session-data.ts`
- Mental model:
  - SDK/global events
  - `applyEvent()`
  - `reduceSessionData()`
  - `syncFooter()` / `writeSessionOutput()`
  - `footer.append()`

### Where does the footer queue and flush scrollback?

- Footer surface owner: `packages/opencode/src/cli/cmd/run/footer.ts`
- Main methods:
  - `append()`: microtask coalescing for progress chunks
  - `flush()`: drains queued commits into scrollback
  - `completeScrollback()`: final markdown/code completion path
  - `scheduleCompleteScrollback()`: finalize-mode scheduling hook

### Where is the hot retained streaming render path?

- Hot file: `packages/opencode/src/cli/cmd/run/scrollback.surface.ts`
- Main class: `RunScrollbackStream`
- Main methods:
  - `writeStreaming()`: top project-owned hotspot from prior profiling
  - `flushActive()`: text/code/markdown streaming update logic
  - `finishActive()`: final commit + teardown
- What lives here:
  - incremental text-buffer append for plain text
  - markdown block commit path via `commitMarkdownBlocks()`
  - sticky assistant text-to-markdown upgrade behavior
  - perf timing markers for visible output

### Where is static scrollback rendering?

- Static writer: `packages/opencode/src/cli/cmd/run/scrollback.writer.tsx`
- Main exports:
  - `entryWriter()`
  - `sameEntryGroup()`
  - `separatorRows()`
  - `entryLayout()`
- Use this file when checking:
  - where separators come from
  - why entries merge or split
  - how non-streaming markdown/text/code render

### Where is text vs markdown decided?

- Entry-body router: `packages/opencode/src/cli/cmd/run/entry.body.ts`
- Important functions:
  - `entryBody()`
  - `shouldStreamAsMarkdown()`
  - `entryCanStream()`
  - `entryDone()`
- This is where assistant progress chooses `text` vs `markdown`

### Where are perf memory and timing helpers?

- Heap/memory checkpoints: `packages/opencode/src/cli/cmd/run/perf.heap.ts`
- Timing markers: `packages/opencode/src/cli/cmd/run/perf.timing.ts`
- Current timing markers:
  - `boot_complete`
  - `first_visible`
  - `last_visible`
  - `final_rich_start`
  - `final_rich_done`

### Where are the current perf conclusions logged?

- Canonical experiment log: `perf/opencode-runtime-performance-results.md`
- This map: `perf/opencode-runtime-codebase-map.md`

## Useful Environment And Harness Knobs

### Perf harness

- `--runner binary|source`
- `--md-finalize-mode immediate|never|defer:N`
- `--settle-ms`
- `--sample-ms`
- `--enable-lsp`
- `--disable-lsp-download`

### Runtime env used by perf work

- `OPENCODE_PERF_TIMING=1`
- `OPENCODE_PERF_TIMING_FILE=...`
- `OPENCODE_PERF_INSTANCE=...`
- `OPENCODE_RUN_TUI_MD_FINALIZE_MODE=...`
- `OPENCODE_PERF_MEMORY_DIR=...`
- `OPENCODE_PERF_HEAP_DIR=...`

## Known Perf Lessons

- Do not assume total `duration` equals user-visible slowness.
- Check `first_visible`, `last_visible`, and `final_rich_done` separately.
- Do not rebuild all target platforms for local Mac perf loops.
- Do not retry external markdown split/reset variants by default.
- The retained streaming path in `scrollback.surface.ts` is still the main OpenCode-owned hotspot to watch.
