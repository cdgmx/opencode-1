# OpenCode Perf Playbook

## Fast Local Loop

- Fastest local binary rebuild on this Mac:
  - `cd packages/opencode`
  - `bun run build:perf`
- Safer host-only rebuild when deps may have changed:
  - `cd packages/opencode`
  - `bun run build:host`
- Full cross-platform release-style build:
  - `cd packages/opencode`
  - `bun run build`
- For quick logic checks before rebuilding:
  - use `--runner source`
- For real perf claims:
  - use `--runner binary`
  - rebuild first if code changed

## Harness Notes

- Perf harness entrypoint:
  - `packages/opencode/script/perf-run.ts`
- Perf artifacts land in:
  - `packages/opencode/.artifacts/perf/`
- Binary path used by the harness:
  - `packages/opencode/dist/opencode-darwin-arm64/bin/opencode`
- Attach-mode startup now polls server readiness instead of sleeping a fixed `20s`.
- TUI timing markers now record:
  - `boot_complete`
  - `first_visible`
  - `last_visible`
  - `final_rich_done`
  - `finalize_tail`
- Finalize-mode switch for harness experiments:
  - `--md-finalize-mode immediate`
  - `--md-finalize-mode never`
  - `--md-finalize-mode defer:N`

## Common Commands

- Binary text timing check:
  - `bun run script/perf-run.ts --mode tui --scenario text --runner binary --instances 10 --timeout-ms 80000 --settle-ms 10000 --sample-ms 500 --md-finalize-mode immediate`
- Binary task timing check:
  - `bun run script/perf-run.ts --mode tui --scenario task-ts --runner binary --instances 10 --timeout-ms 120000 --settle-ms 10000 --sample-ms 500 --md-finalize-mode immediate`
- Binary LSP timing check:
  - `bun run script/perf-run.ts --mode tui --scenario lsp-ts --runner binary --instances 10 --enable-lsp true --disable-lsp-download true --timeout-ms 120000 --settle-ms 1000 --sample-ms 500 --md-finalize-mode immediate`

## Codebase Map

### Where interactive run starts

- CLI entry for `run`:
  - `packages/opencode/src/cli/cmd/run.ts`
- Main interactive orchestrator:
  - `packages/opencode/src/cli/cmd/run/runtime.ts`
- Renderer boot and footer construction:
  - `packages/opencode/src/cli/cmd/run/runtime.lifecycle.ts`
- Prompt queue and turn lifecycle:
  - `packages/opencode/src/cli/cmd/run/runtime.queue.ts`

### Where streamed model output becomes UI commits

- Stream transport and reducer bridge:
  - `packages/opencode/src/cli/cmd/run/stream.transport.ts`
- Footer-side commit queue:
  - `packages/opencode/src/cli/cmd/run/footer.ts`
  - main drain function: `RunFooter.flush`
- Scrollback retained streaming surface:
  - `packages/opencode/src/cli/cmd/run/scrollback.surface.ts`
  - main hotspot: `RunScrollbackStream.writeStreaming`
  - main render function: `RunScrollbackStream.flushActive`

### Where text vs markdown is decided

- Body selection for streamed entries:
  - `packages/opencode/src/cli/cmd/run/entry.body.ts`
- Assistant text-first heuristic:
  - `entryBody`
  - `shouldStreamAsMarkdown`
- Sticky assistant one-way markdown upgrade:
  - `packages/opencode/src/cli/cmd/run/scrollback.surface.ts`
  - `RunScrollbackStream.writeStreaming`

### Where static transcript rendering lives

- Static entry writer and separators:
  - `packages/opencode/src/cli/cmd/run/scrollback.writer.tsx`
- Useful functions:
  - `sameEntryGroup`
  - `separatorRows`
  - `entryWriter`

### Where markdown/code finalization happens

- Final scrollback completion trigger:
  - `packages/opencode/src/cli/cmd/run/footer.ts`
  - `RunFooter.completeScrollback`
- Retained-surface final flush:
  - `packages/opencode/src/cli/cmd/run/scrollback.surface.ts`
  - `RunScrollbackStream.complete`
  - `RunScrollbackStream.finishActive`

### Where perf instrumentation lives

- Heap and memory checkpoints:
  - `packages/opencode/src/cli/cmd/run/perf.heap.ts`
- Timing markers:
  - `packages/opencode/src/cli/cmd/run/perf.timing.ts`
- Harness summary parsing and reporting:
  - `packages/opencode/script/perf-run.ts`

### Where binary builds come from

- Build script:
  - `packages/opencode/script/build.ts`
- Fast host-only flags already supported there:
  - `--single`
  - `--skip-install`
  - `--skip-embed-web-ui`
- Convenience scripts:
  - `packages/opencode/package.json`
  - `build:host`
  - `build:perf`

### Where OpenTUI markdown internals live

- Package type surface:
  - `packages/opencode/node_modules/@opentui/core/renderables/Markdown.d.ts`
- Installed bundled implementation we inspected:
  - `node_modules/.bun/@opentui+core@*/node_modules/@opentui/core/index-hzcw4q21.js`
- Internal symbols repeatedly relevant to perf work:
  - `MarkdownRenderable`
  - `parseMarkdownIncremental`
  - `_parseState`
  - `_blockStates`
  - `_stableBlockCount`
  - `updateBlocks`

### Where repeated perf conclusions live

- Canonical experiment log:
  - `perf/opencode-runtime-performance-results.md`
- This lookup doc:
  - `perf/opencode-perf-playbook.md`

## Repeated Conclusions To Remember

- Do not spend more cycles by default on:
  - FPS tuning
  - global `plain|final` switches
  - tiny batching tweaks
  - OpenCode-side markdown trim/reset/recreate variants
- Current project-owned hotspot remains:
  - `RunScrollbackStream.writeStreaming`
- Total `duration` alone is not enough anymore.
- For user-visible speed, check:
  - `first_visible`
  - `last_visible`
  - `final_rich_done`
  - `finalize_tail`
