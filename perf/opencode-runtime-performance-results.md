# OpenCode Runtime Performance Results

## Current Harness Note

The active harness has been simplified into a quick black-box CPU/RAM runner in `packages/opencode/script/perf-run.ts`.

Current default use:

- `cd packages/opencode`
- `bun run perf:run`

The detailed experiments below are historical results from the earlier, larger harness.

HTML report: `perf/opencode-runtime-performance-report.html`

## Latest Multi-Instance/LSP Result

- Harness gap fixed: `perf-run.ts` can now run multiple CLI instances, `read-ts` / `lsp-ts` tool scenarios, LSP on/off, source vs compiled binary, and attach mode.
- 10 local TUI instances with LSP scenario:
  - artifact: `20260603T083916Z-tui-lsp-ts-run-1`
  - tree peak CPU: `735.1%`
  - tree peak RSS: `3017.85MB`
  - process-kind RSS: `opencode` `2986.18MB`, LSP `208.78MB`
- 10 attach-mode TUI clients against one shared server:
  - artifact: `20260603T085711Z-tui-lsp-ts-run-1`
  - tree peak CPU: `750.1%`
  - tree peak RSS: `3162.83MB`
  - conclusion: sharing a server does not solve the 10-client memory curve because client/TUI processes still dominate.
- Compiled binary 10-instance run:
  - artifact: `20260603T085847Z-tui-lsp-ts-run-1`
  - tree peak CPU: `699%`
  - tree peak RSS: `3119.73MB`
  - conclusion: source-mode overhead is not the main explanation.
- Root cause update:
  - dominant cost is duplicated interactive `opencode`/TUI runtime per CLI process.
  - LSPs are an amplifier, not the main measured CPU/RSS source in this harness.
- Kept fix:
  - TypeScript LSP now honors `OPENCODE_DISABLE_LSP_DOWNLOAD`; this prevents unwanted package lookup/download work but is not expected to solve the main 10-instance TUI memory curve.
- Rejected fixes:
  - queue throttling, fixed title, incremental GC, and full GC were measured and not kept because results were noisy, worse, or not reproducible.

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

## Experiment Log

### H1: Shared-home DB contention is the main lag source

- Test: 6-instance isolated vs shared-home real-workspace runs
- Artifacts:
  - isolated: `20260602T160141Z-multi-instance-slow-stream-run-1`
  - shared: `20260602T160421Z-multi-instance-slow-stream-run-1`
- Result:
  - shared-home failed early with duplicate-index / lock issues
  - isolated run still showed high CPU/process fan-out
- Conclusion: failed as the main explanation

### H2: Interactive TUI is more expensive than non-TUI for the same stream

- Test: mocked 2000-chunk stream, `run-json` vs `tui`
- Artifacts:
  - `20260603T005621Z-run-json-delta-burst-markdown-run-1`
  - `20260603T005623Z-tui-delta-burst-text-run-1`
  - `20260603T005627Z-tui-delta-burst-markdown-run-1`
  - `20260603T005631Z-tui-delta-burst-code-run-1`
- Result:
  - `run-json`: `2.035s`, `124.6%`, `460.3MB`
  - `tui text`: `4.027s`, `222.8%`, `890.13MB`
  - `tui markdown`: `4.025s`, `242.8%`, `903.25MB`
  - `tui code`: `3.928s`, `224.1%`, `903.31MB`
- Conclusion: interactive renderer path is a dominant cost center

### H3: Snapshotting is a major real-workspace amplifier

- Test: same 3-instance workspace run, snapshot on vs off
- Artifacts:
  - on: `20260603T010348Z-multi-instance-slow-stream-run-1`
  - off: `20260603T010710Z-multi-instance-slow-stream-run-1`
- Result:
  - on: `24` child processes, `9` git children, `91.3%` peak git CPU
  - off: `6` child processes, `0` git children
- Conclusion: real amplifier, not the main CPU problem

### H4: Lower FPS / event-driven mode will fix the problem

- Test: reduced loop, event mode, harsher low-FPS loop
- Key artifacts:
  - reduced loop: `20260603T011413Z-tui-delta-burst-markdown-run-1`
  - event: `20260603T012656Z-tui-delta-burst-markdown-run-1`
  - low-FPS: `20260603T012831Z-tui-delta-burst-markdown-run-1`
- Result:
  - helps somewhat
  - not transformative
- Conclusion: failed as a real fix

### H5: Chunk frequency, not total text volume, is the main cause

- Test: keep total volume ~8000 chars, vary chunk count/size
- Artifacts:
  - text: `20260603T012018Z`, `20260603T012023Z`, `20260603T012027Z`
  - markdown: `20260603T012031Z`, `20260603T012036Z`, `20260603T012040Z`
- Result:
  - text: coarser chunks did not lower peak CPU
  - markdown: coarser chunks lowered CPU/RSS somewhat
- Conclusion: partly true, still wrong as the full explanation

### H6: Bun-native profiles can identify the hottest internal function

- Decision:
  - removed custom perf counters
  - switched to Bun-native CPU profiles only
- Harness support:
  - `--bun-cpu-prof true`
  - clean exit via `OPENCODE_PERF_AUTO_CLOSE=1`
- Conclusion: function-level attribution is reliable enough to guide fixes

### H7: Markdown path is the hottest internal stack

- Test: long Bun-profiled markdown run
- Artifact:
  - `20260603T015837Z-tui-delta-burst-markdown-run-1/cpu-profile-1/CPU.45974791271.58161.md`
- Result:
  - `async writeStreaming`: `21.3%` / `5.36s`
  - `updateBlocks`: `13.2%` / `3.34s`
  - `parseMarkdownIncremental`: `12.1%` / `3.07s`
  - `updateLayout`: `10.1%` / `2.54s`
  - `toLLMEvents`: `4.9%` / `1.24s`
- Conclusion: confirmed hot path, not a fix

### H8: Plain text should be cheap once markdown is removed

- Test: long Bun-profiled text run
- Artifact:
  - `20260603T020003Z-tui-delta-burst-text-run-1/cpu-profile-1/CPU.46061978127.60276.md`
- Result:
  - `async writeStreaming`: `25.9%` / `6.84s`
  - `updateBlocks`: `24.2%` / `6.40s`
  - `parseMarkdownIncremental`: `24.1%` / `6.36s`
- Conclusion: assumption was wrong; plain text is still expensive here

### H9: Stream-path switches should materially lower CPU

- Added switches:
  - `--run-stream-render-mode rich|plain|final`
  - `--run-stream-settle-mode eager|throttled|final`
- Artifacts:
  - rich: `20260603T021518Z-tui-delta-burst-markdown-run-1`
  - plain: `20260603T021543Z-tui-delta-burst-markdown-run-1`
  - final: `20260603T021609Z-tui-delta-burst-markdown-run-1`

#### H9a: `plain` mode materially lowers CPU

- Result:
  - peak CPU: `206.1%` rich vs `217.0%` plain
  - hotspot changed from markdown chain to text-buffer chain
- Conclusion: failed; cost moved into low-level text drawing instead of disappearing

#### H9b: `final` mode materially lowers CPU

- Result:
  - peak CPU: `206.1%` rich vs `205.4%` final
  - `writeStreaming` dropped from `22.2% / 5.61s` to `16.5% / 4.30s`
  - markdown/update/layout still stayed heavy
- Conclusion: failed at the top-line CPU level; one function improved, total CPU did not

### H10: Code bypass of assistant/reasoning per-chunk flush will materially lower CPU

- Change tested:
  - skip `flushActive(false, false)` in `RunScrollbackStream.writeStreaming` for non-tool commits unless `shouldSettle(..., false)` says to render
- Artifacts:
  - perf run: `20260603T023358Z-tui-delta-burst-markdown-run-1`
  - CPU profile: `20260603T023436Z-tui-delta-burst-markdown-run-1/cpu-profile-1/CPU.48132789159.98732.md`
- Result:
  - targeted hotspot improved: `async writeStreaming` dropped to noise level in the patched CPU profile
  - top-line CPU did not materially improve: patched run still hit `189.8%` child peak CPU
- Conclusion: failed as a meaningful fix; per-chunk `writeStreaming` was real cost, but not enough of total cost to solve the problem

### H11: Coarser retained streaming settle cadence will materially lower CPU

- Hypothesis:
  - fewer retained-stream settle/layout/render passes will reduce real runtime CPU
- Change:
  - `STREAM_SETTLE_INTERVAL_MS`: `75 -> 150`
  - `STREAM_SETTLE_MIN_CHARS`: `256 -> 1024`
- Result:
  - markdown artifacts: `20260603T025553Z-tui-delta-burst-markdown-run-{1,2,3}`
  - text artifacts: `20260603T025721Z-tui-delta-burst-text-run-{1,2,3}`
  - markdown `child_max_cpu` runs: `170.8`, `184.7`, `201.0`; median `184.7` vs current representative `189.8` = `5.1` points better
  - text `child_max_cpu` runs: `177.2`, `199.8`, `190.8`; median `190.8`
  - profile rerun skipped because markdown result missed the keep threshold and triggered rollback rules
- Conclusion:
  - revert; markdown improvement was below the 10-point rollback floor and far below the 20-point keep threshold

### H12: Pre-gate markdown/code updates and text render deferral will materially lower CPU

- Change:
  - moved markdown/code `renderable.content` and `renderable.streaming` updates behind `shouldSettle(...)`
  - moved text `active.surface.render()` behind the row-commit precheck
- Artifacts:
  - markdown: `20260603T030456Z-tui-delta-burst-markdown-run-{1,2,3}`
  - text: `20260603T030626Z-tui-delta-burst-text-run-{1,2,3}`
- Result:
  - markdown `child_max_cpu` runs: `195.7`, `199.7`, `193.3`; median `195.7` vs baseline `189.8` = `5.9` points worse
  - text `child_max_cpu` runs: `199.0`, `199.6`, `202.1`; median `199.6` vs latest logged text median `190.8` = `8.8` points worse (`4.6%`)
  - profile rerun skipped because markdown regressed and failed the rollback floor immediately
- Conclusion:
  - revert; markdown regressed versus baseline, so this packet did not materially lower CPU

### H13: Batch adjacent text-delta publishes in the session processor

- Change:
  - batched adjacent `text-delta` publishes in `packages/opencode/src/session/processor.ts` with a `256`-character cap
  - flushed before non-`text-delta` boundaries and terminal cleanup to preserve ordered output and final delivery
- Artifacts:
  - markdown: `20260603T032137Z-tui-delta-burst-markdown-run-{1,2,3}`
  - text: `20260603T032302Z-tui-delta-burst-text-run-{1,2,3}`
- Result:
  - markdown `child_max_cpu` runs: `200.3`, `187.2`, `170.8`; median `187.2` vs baseline `189.8` = `2.6` points better
  - text `child_max_cpu` runs: `193.3`, `196.3`, `187.8`; median `193.3` vs latest logged text median `190.8` = `2.5` points worse (`1.3%`)
  - profile rerun skipped because markdown improvement missed both the `10`-point rollback floor and the final `15`-point keep bar
  - quick smoke review found no ordered-stream or final-flush bug in code, but the raw TUI artifact still looked chunkier under the `256`-character cap
- Conclusion:
  - revert and stop; markdown improvement was not material, so this final bounded packet does not justify keeping the change

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
