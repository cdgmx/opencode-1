# OpenCode Runtime Performance Results

## Current Harness Note

The active harness in `packages/opencode/script/perf-run.ts` now covers the multi-agent shape we were missing:

- multiple `opencode` CLI instances
- `run-json` and interactive TUI modes
- local server-per-process and attach-to-one-server modes
- source and compiled binary runners
- `text`, `markdown`, `code`, `read-ts`, and `lsp-ts` scenarios
- LSP enable/disable and `OPENCODE_DISABLE_LSP_DOWNLOAD`
- process-kind CPU/RSS breakdown
- memory checkpoints and heap snapshots
- per-home warmup before sampling so first-run DB migration is not counted as steady-state runtime cost

Current representative command:

- `cd packages/opencode`
- `bun run script/perf-run.ts --mode tui --scenario lsp-ts --instances 10 --enable-lsp true --disable-lsp-download true --memory-checkpoints true --timeout-ms 80000 --settle-ms 1000 --sample-ms 500`

HTML report: `perf/opencode-runtime-performance-report.html`

## Latest Finding

The strongest current evidence does **not** point to one OpenTUI leak or one runaway LSP as the primary root cause. The main cost is duplicated `opencode` runtime footprint per CLI process. OpenTUI and LSP increase the curve, but the measured 10-instance memory is mostly the ten `opencode` processes themselves.

Attach-mode now makes the next conclusion explicit: the dominant remaining memory problem is the client, not the shared server.

Evidence:

- 10 local TUI instances, no LSP, warmed homes:
  - before lazy/deferred import fix: `20260603T094222Z-tui-text-run-1`
  - tree peak CPU: `804.6%`
  - tree peak RSS: `3024.41MB`
- same scenario after lazy CLI command loading and deferred interactive runtime import:
  - artifact: `20260603T094632Z-tui-text-run-1`
  - tree peak CPU: `684.2%`
  - tree peak RSS: `2581.81MB`
  - improvement: about `442.6MB` lower peak RSS and `120.4` CPU percentage-points lower
- memory checkpoints after the fix still show the per-process baseline is high:
  - boot sum RSS: `2387.5MB`
  - boot heap used: `1480.1MB`
  - boot external memory: `745.5MB`
  - idle sum RSS: `2294.4MB`
  - idle heap used: `1616.6MB`
  - idle external memory: `836.6MB`

This means the fix helped, but it did not erase the core issue: every interactive CLI still loads a large runtime.

## Latest Multi-Instance/LSP Result

- 10 local TUI instances with LSP scenario, before the lazy/deferred import fix:
  - artifact: `20260603T083916Z-tui-lsp-ts-run-1`
  - tree peak CPU: `735.1%`
  - tree peak RSS: `3017.85MB`
  - process-kind RSS: `opencode` `2986.18MB`, LSP `208.78MB`
- 10 local TUI instances with LSP scenario, after the lazy/deferred import fix:
  - artifact: `20260603T094721Z-tui-lsp-ts-run-1`
  - tree peak CPU: `776.7%`
  - tree peak RSS: `3058.39MB`
  - process-kind RSS: `opencode` `3052.59MB`, LSP `160.92MB`, git `64.28MB`, other `139.01MB`
  - checkpoint idle heap used: `1755.5MB`
  - checkpoint idle external memory: `972.3MB`
- 10 attach-mode TUI clients against one shared server:
  - artifact: `20260603T094301Z-tui-text-run-1`
  - tree peak CPU: `679.4%`
  - tree peak RSS: `2766.12MB`
  - process-kind RSS: shared server/wrapper `422.58MB`, clients `2660.96MB`
  - conclusion: sharing one server helps only modestly because the client/TUI processes still dominate.
  - stronger conclusion: about `85%` of attach-mode RSS is still in clients, so server-side-only work is not the next fix path.
- 10 subagent-heavy `task`-tool clients, attach mode:
  - artifact: `20260603T115333Z-tui-task-ts-run-1`
  - tree peak CPU: `647.2%`
  - tree peak RSS: `2607.88MB`
  - conclusion: a `task()`/subagent proxy is measurably heavy, but still far below the 10-12GB field report, so the synthetic harness is closer now but still not reproducing the full real-world spike path.
- 10 subagent-heavy `task`-tool clients, local mode:
  - artifact: `20260603T115636Z-tui-task-ts-run-1`
  - tree peak CPU: `555.2%`
  - tree peak RSS: `2331.29MB`
  - conclusion: in the current synthetic subagent scenario, local mode is actually lighter than attach mode, which reinforces that the remaining issue is not just server duplication.
- Compiled binary 10-instance run before current source fixes:
  - artifact: `20260603T085847Z-tui-lsp-ts-run-1`
  - tree peak CPU: `699%`
  - tree peak RSS: `3119.73MB`
  - conclusion: source-mode overhead is not the main explanation.

## Heap Snapshot Finding

Heap snapshots did not show a single unbounded JavaScript leak. The snapshot evidence points to a large loaded runtime/module graph:

- artifact: `20260603T091900Z-tui-lsp-ts-run-1`
- retained heap parsed from snapshot: about `176.9MB`
- largest groups:
  - compiled code: `63MB`
  - module records: `20.49MB`
  - array buffers: `16.78MB`
  - strings: `13.19MB`
  - lexical environments: `11.95MB`

Important caveat: heap snapshot collection itself inflates RSS, so this evidence is useful for retained heap composition, not for steady-state RSS.

## Fixes Kept

- Lazy command registration in `src/index.ts`:
  - `opencode run` now imports only the run command instead of loading the full CLI command graph before yargs dispatch.
- Deferred interactive runtime import in `src/cli/cmd/run.ts`:
  - non-interactive `run-json` no longer loads the interactive runtime.
  - measured `run-json` local RSS improved from `2907.74MB` to `2496.17MB`.
- TypeScript LSP now honors `OPENCODE_DISABLE_LSP_DOWNLOAD`:
  - prevents unwanted package lookup/download work.
- Semantic LSP operations now skip lint-only servers:
  - `biome`, `eslint`, and `oxlint` are excluded for hover/definition/reference/document-symbol/call-hierarchy style operations.
  - diagnostics still use all configured diagnostic servers.

## Stop Doing These

These lines of investigation are low-yield and should not be the default next step.
They either moved work around, shaved off noise-level amounts, or failed to reproduce.

- OpenTUI thread/FPS/static-spinner knobs: not a real CPU/RSS fix.
- `OTUI_NO_NATIVE_RENDER=1`: not a real fix.
- `--smol` source runner: did not explain or fix memory.
- Queue throttling, fixed title, incremental GC, full GC: noisy, worse, or not reproducible.
- Stream-path switches like `rich|plain|final`: changed where CPU burned, not how much.
- Settle-cadence micro-tuning: below keep threshold or regressed.
- Small text-delta batching tweaks: below keep threshold and not worth the behavior risk.
- Cold-start investigation as a steady-state explanation: warm-home removed that harness artifact, but the high memory curve remained.

## Current Answer

- Hottest project-owned function: `RunScrollbackStream.writeStreaming`
  - `packages/opencode/src/cli/cmd/run/scrollback.surface.ts`
- Rich-mode downstream hotspot chain:
  - `updateBlocks`
  - `parseMarkdownIncremental`
  - `updateLayout`
- Plain-mode downstream hotspot chain:
  - `textBufferSetStyledText`
  - `renderSurface`
- Real-workspace amplifier:
  - snapshot-driven `git add --all` churn

## Brutal Summary

- We did **not** solve the CPU problem.
- Lowering FPS reduced CPU a bit. Not enough.
- Event-driven mode was not a real fix.
- Plain-stream mode was not a real fix.
- Final-render mode was not a real fix.
- Snapshot deferral removed git noise. Main OpenCode CPU stayed high.
- Wrong assumption: markdown parsing alone is the problem.
- Better answer: the whole retained streaming write/render path is the problem.
- Attempted code bypass for assistant/reasoning per-chunk flush was not a real fix.

## Final Conclusions

1. The root problem is the retained streaming scrollback write/render path.
2. Turning markdown off is not enough; cost shifts into plain text rendering.
3. Snapshot deferral removes git churn, but core OpenCode CPU remains high.
4. Most tested knobs only moved work around or shaved off an insignificant amount.
5. Bypassing assistant/reasoning per-chunk flush reduced `writeStreaming`, but still did not materially lower peak CPU.
6. Next step is still open; the remaining cost looks more like final rich render / surrounding runtime work than the per-chunk `writeStreaming` path.

## Attach-Mode Conclusion

- Attach mode already tested the strongest server-sharing hypothesis.
- Result: server/wrapper RSS `422.58MB`, clients `2660.96MB`, total `2766.12MB`.
- Interpretation: the shared server is not the first-order memory problem.
- About `85%` of measured attach-mode RSS is still in clients.
- Therefore server-side-only optimization is not the next path to pursue.
- Next useful work should focus on thinning the attach/local interactive client.
- Practical rule for future investigation: do not spend cycles on server-only hypotheses unless they also reduce client-side load or client-owned module/runtime duplication.

## Subagent-Heavy Benchmark Note

- Issue `#20695` suggests the worst field spikes come from subagent spawning with large accumulated context, plugin/skill load, and MCP schema fan-out.
- To get closer to that path, the perf harness now has a `task-ts` scenario that emits a real `task` tool call with `subagent_type: "explore"`.
- This is a better proxy than plain `text`, `read-ts`, or `lsp-ts` for subagent-heavy memory work.
- It still does not reproduce the full field conditions from the issue: huge `opencode.db`, large installed skill/plugin sets, or many MCP schemas.

## Key Artifacts

- Markdown Bun profile:
  - `packages/opencode/.artifacts/perf/20260603T015837Z-tui-delta-burst-markdown-run-1/cpu-profile-1/CPU.45974791271.58161.md`
- Text Bun profile:
  - `packages/opencode/.artifacts/perf/20260603T020003Z-tui-delta-burst-text-run-1/cpu-profile-1/CPU.46061978127.60276.md`
- Stream switch matrix:
  - rich: `20260603T021518Z-tui-delta-burst-markdown-run-1`
  - plain: `20260603T021543Z-tui-delta-burst-markdown-run-1`
  - final: `20260603T021609Z-tui-delta-burst-markdown-run-1`
- Failed code-change check:
  - perf run: `20260603T023358Z-tui-delta-burst-markdown-run-1`
  - CPU profile: `20260603T023436Z-tui-delta-burst-markdown-run-1/cpu-profile-1/CPU.48132789159.98732.md`

## Compact Experiment Log

### Confirmed

- TUI is materially more expensive than `run-json` for the same mocked stream.
- Snapshotting is a real amplifier in real workspaces, but not the core CPU root cause.
- Bun-native CPU profiles are good enough for function-level attribution.
- The hot path is the retained streaming write/render chain, not one isolated markdown-only function.
- Plain text is still expensive; turning markdown off mostly shifts work into text rendering.

### Rejected

- Shared-home DB contention is not the main steady-state lag explanation.
  It is a startup/concurrency failure mode, not the core runtime CPU answer.
- Lower FPS / event-driven mode is not a real fix.
  It helped somewhat, but not enough to matter.
- Chunk frequency is not the full explanation.
  Coarser chunks helped markdown somewhat, but did not solve text or top-line CPU.
- `plain` render mode is not a real fix.
  It moved cost from markdown/layout into low-level text drawing.
- `final` render mode is not a real fix.
  It reduced one hotspot, but not top-line CPU.
- Skipping per-chunk assistant/reasoning flush is not a real fix.
  It cooled `writeStreaming`, but the run stayed CPU-hot.
- Coarser settle cadence is not a keepable fix.
  Improvement was below the keep threshold.
- Pre-gating markdown/code updates and deferring text render is not a fix.
  It regressed.
- Batching adjacent text-delta publishes is not a keepable fix.
  Improvement was too small and not worth the behavior risk.

### Stop Here

Do not spend more time by default on:

- FPS-style loop tuning
- `plain|final` stream render switches
- settle-cadence micro-tuning
- tiny batching tweaks in the current stream path

These ideas were tested already. They did not materially lower top-line CPU, or they regressed, or they only moved the work.

## Best Current Summary

- Confirmed hottest function:
  - `RunScrollbackStream.writeStreaming`
  - `packages/opencode/src/cli/cmd/run/scrollback.surface.ts`
- Confirmed hottest downstream work:
  - rich mode: `updateBlocks`, `parseMarkdownIncremental`, `updateLayout`
  - plain mode: `textBufferSetStyledText`, `renderSurface`
- Meaning:
  - the root cause is broader than markdown parsing
  - the retained streaming write/render path itself is too expensive
  - turning markdown off only shifts the cost into plain text rendering
  - most tested switches changed where CPU burns, not how much burns
  - even a direct code bypass that cools `writeStreaming` did not solve top-line CPU

## 2026-06-04 TUI-Only Recheck

- Reverted temporary stream/render changes before this pass.
- Browser concepts like CSS/DOM/FlashList do not apply here. The equivalent client-side surfaces are Solid signals/stores, OpenTUI renderables, Yoga layout, native text buffers, split-footer scrollback surfaces, and keymap/input layers.
- New minimal binary baseline:
  - artifact: `20260603T171416Z-tui-text-run-1`
  - command shape: 10 attached TUI clients, binary runner, `text`, `chunks=1`, `chunk_size=1`
  - result: `tree_peak_cpu=567.5%`, `tree_peak_rss=2543.48MB`
  - interpretation: a near-empty interactive client already has a large fixed CPU/RSS floor. This is not primarily caused by markdown volume, subagent output volume, or LSP output volume in the current harness.
- Minimal binary `run-json` comparison:
  - artifact: `20260603T171457Z-run-json-text-run-1`
  - result: `tree_peak_cpu=561.1%`, `tree_peak_rss=2196.91MB`
  - interpretation: source/runtime and startup are still major confounders, but TUI adds about `346.57MB` tree RSS across 10 clients in this minimal comparison.
- Rejected fast boot:
  - artifact: `20260603T171152Z-tui-task-ts-run-1`
  - result: `tree_peak_cpu=730.9%`, `tree_peak_rss=2625.01MB`
  - baseline was `701.1%` CPU / `2325.66MB` RSS, so `OPENCODE_FAST_BOOT=1` did not help.
- Rejected low FPS on the minimal binary case:
  - artifact: `20260603T171556Z-tui-text-run-1`
  - result: `tree_peak_cpu=554.5%`, `tree_peak_rss=2521.91MB`
  - only a small CPU change and no memory fix.
- Rejected keymap-skip probe:
  - artifact: `20260603T171856Z-tui-text-run-1`
  - result: `tree_peak_cpu=587.5%`, `tree_peak_rss=2478.28MB`
  - about `6.5MB/client` RSS improvement, but CPU worsened. Not a keepable fix.
- Source-runner CPU profile for the minimal TUI case:
  - artifact: `20260603T171721Z-tui-text-run-1/cpu-profile/CPU.101102111541.42674.md`
  - profile is source-biased: hot samples are mostly Bun/source transpilation, native frames, and OpenTUI shutdown cleanup. Do not use it as binary runtime proof.

### Revised Hypothesis

- The current 10-client lag/RSS issue has a large fixed per-client TUI/runtime component before heavy streaming is involved.
- Streaming retained surfaces are still a confirmed hot path under real output, but they are not sufficient to explain the minimal benchmark floor.
- Next useful tests should measure and thin direct-run interactive client initialization and resident module/native memory, especially OpenTUI renderer/native buffers, Solid/footer runtime, and server/API client duplication per attached TUI.

## Repro Commands

```sh
cd packages/opencode

# Function-level markdown profile
bun run perf:run --mode tui --scenario delta-burst-markdown --chunks 2000 --chunk-size 4 --delay-ms 10 --runs 1 --bun-cpu-prof true

# Function-level text profile
bun run perf:run --mode tui --scenario delta-burst-text --chunks 2000 --chunk-size 4 --delay-ms 10 --runs 1 --bun-cpu-prof true

# Stream switch proof matrix
bun run perf:run --mode tui --scenario delta-burst-markdown --chunks 2000 --chunk-size 4 --delay-ms 10 --runs 1 --bun-cpu-prof true --run-stream-render-mode rich --run-stream-settle-mode throttled
bun run perf:run --mode tui --scenario delta-burst-markdown --chunks 2000 --chunk-size 4 --delay-ms 10 --runs 1 --bun-cpu-prof true --run-stream-render-mode plain --run-stream-settle-mode eager
bun run perf:run --mode tui --scenario delta-burst-markdown --chunks 2000 --chunk-size 4 --delay-ms 10 --runs 1 --bun-cpu-prof true --run-stream-render-mode final --run-stream-settle-mode final

# Snapshot amplifier check
bun run perf:run --mode multi-instance --scenario slow-stream --chunks 500 --chunk-size 8 --delay-ms 40 --instances 3 --runs 1 --timeout-ms 90000 --settle-ms 500 --workspace /Users/christian/Documents/Github/opencode-dev --enable-project-config
bun run perf:run --mode multi-instance --scenario slow-stream --chunks 500 --chunk-size 8 --delay-ms 40 --instances 3 --runs 1 --timeout-ms 90000 --settle-ms 500 --workspace /Users/christian/Documents/Github/opencode-dev --enable-project-config --enable-snapshot false
```
