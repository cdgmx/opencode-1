# OpenCode Runtime Performance Plan

## Current Harness

The active harness is now the reduced black-box runner in `packages/opencode/script/perf-run.ts`.

Current goal:

- finish in seconds, not minutes
- print CPU/RAM results immediately
- avoid runtime-specific tuning flags
- keep the measurement stable enough for before/after code-change checks

The rest of this document is historical design context from the earlier deeper investigation.

## Goal

Confirm whether streamed `message.part.delta` volume causes OpenCode CPU/RAM pressure, isolate whether the hot path is session/event churn or TUI render churn, and create repeatable local benchmarks for side-by-side fix testing without calling real LLM endpoints.

## Expectations

- Use a mocked OpenAI-compatible LLM stream; no real provider calls.
- Log measurements automatically; no manual `top`, `sample`, or log counting required.
- Produce timestamped artifacts for every run.
- Compare baseline vs fix branches with the same scenarios and metrics.
- Keep normal test suite assertions separate from noisy CPU/RAM perf measurements.

## Existing Assets

- `packages/opencode/test/lib/llm-server.ts` already mocks chat/responses SSE, text, reasoning, tools, hangs, and errors.
- `packages/opencode/test/lib/test-provider.ts` already configures `test/test-model` against a fake LLM URL.
- `packages/opencode/test/lib/cli-process.ts` already spawns real OpenCode with isolated env and background work disabled.
- `packages/opencode/src/cli/cmd/run/trace.ts` already supports direct JSONL tracing via `OPENCODE_DIRECT_TRACE=1`.

## Suspected Hot Paths

- `packages/opencode/src/session/processor.ts`: one `message.part.delta` per streamed text chunk.
- `packages/opencode/src/cli/cmd/run/session-data.ts`: per-delta reducer/map/string work.
- `packages/opencode/src/cli/cmd/run/footer.ts`: progress commits are partly coalesced.
- `packages/opencode/src/cli/cmd/run/scrollback.surface.ts`: markdown/code content calls `surface.settle()` on growing content.

## Build Plan

1. Done: Add a process sampler that records parent/child PID CPU and RSS at fixed intervals.
2. Done: Add artifact writer under `packages/opencode/.artifacts/perf/<timestamp>-<scenario>/`.
3. Done: Add a mock LLM perf server that emits configurable chunk counts, chunk sizes, reasoning chunks, tool calls, delays, and failures.
4. Done: Add `perf:run` script for `opencode run --format json` to measure session/event overhead without TUI render pressure.
5. Done: Add TUI/direct-mode stress runner to measure actual OpenTUI render pressure.
6. Available, not yet interpreted: Add multi-instance runner to mirror 5-10 OpenCode processes across one or more repos.
7. Done: Add comparison helper that summarizes metrics across baseline and fix worktrees.

## Harness Status

- `run-json` mode is verified against the mock LLM stream and emits JSON stdout events.
- `tui` mode is verified against the mock LLM stream through a PTY wrapper with fixed terminal dimensions.
- TUI runs intentionally end with exit code `143` because the harness terminates interactive mode after the stream completes and a settle window elapses.
- `llm_requests: 2` is expected for these scenarios because the main prompt and title generation both hit the mock provider.
- The parent process in TUI mode is the `script` wrapper; use `child_max_cpu` and `child_max_rss_mb` for OpenCode TUI process pressure.

## Initial Scenarios

| Scenario | Purpose |
| --- | --- |
| `delta-burst-text` | Many tiny plain-text chunks; baseline stream overhead. |
| `delta-burst-markdown` | Many tiny markdown chunks; likely `surface.settle()` stress. |
| `delta-burst-code` | Many tiny code chunks; code render stress. |
| `reasoning-burst` | Thinking stream pressure before final answer. |
| `tool-loop` | Tool-call round-trip pressure. |
| `parallel-tool-loop` | One assistant turn emits several bash tool calls to stress parallel tool orchestration. |
| `subagent-chain` | Parent session calls `task`, subagent calls `bash`, then both sessions resume. |
| `slow-stream` | Long steady stream at fixed tokens/sec. |
| `multi-instance` | Several OpenCode processes plus child processes. |

## Metrics

- `duration_ms`
- `max_cpu`, `avg_cpu`
- `max_rss_mb`, `avg_rss_mb`
- `child_max_cpu`, `child_max_rss_mb`
- `child_kind_max_cpu`, `child_kind_max_rss_mb`
- `tracked_child_kind_max_total_cpu`, `tracked_child_kind_max_total_rss_mb`
- `llm_requests`
- `delta_chunks`
- `chunks_per_second`
- `stdout_events`
- `stderr_bytes`
- `exit_code`
- `host_max_memory_used_mb_delta`, `host_max_memory_used_percent_delta`
- `host_max_swap_used_mb_delta`, `host_max_load_avg_1m_delta`

## Artifact Shape

```text
packages/opencode/.artifacts/perf/<timestamp>-<mode>-<scenario>-run-<n>/
  run.json
  metrics.jsonl
  processes.jsonl
  summary.json
  stdout.log
  stderr.log
  sample-<pid>.txt
```

## Test Matrix

1. Done: Run `run-json` markdown burst to measure non-TUI session/event overhead.
2. Done: Run `tui` markdown burst to measure render overhead.
3. Done: Run `tui` text burst to check whether markdown/code are uniquely expensive.
4. Done: Run `tui` code burst because markdown was hotter than text.
5. Run multi-instance only after single-instance cause is clear.
6. Run grepai on/off as a separate external-pressure comparison.

## Baseline Results

Command shape:

```sh
cd packages/opencode
bun run perf:run --mode <mode> --scenario <scenario> --chunks 5000 --chunk-size 4 --runs 3
```

| Mode | Scenario | Artifact prefix | Median duration_ms | Median max_cpu | Median max_rss_mb | Median child_max_cpu | Median child_max_rss_mb | Median chunks_per_second | Exit code |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `run-json` | `delta-burst-markdown` | `20260602T152825Z` | 1654 | 185.4 | 642.84 | 0 | 0 | 3022.97 | `0` |
| `tui` | `delta-burst-markdown` | `20260602T153519Z` | 3924 | 0.2 | 1.19 | 237.8 | 890.33 | 1274.21 | `143` expected |
| `tui` | `delta-burst-text` | `20260602T153542Z` | 4022 | 0.2 | 1.19 | 219.6 | 787.00 | 1243.16 | `143` expected |
| `tui` | `delta-burst-code` | `20260602T153608Z` | 4023 | 0.2 | 1.19 | 237.4 | 837.50 | 1242.85 | `143` expected |

Future artifact names include mode in the directory name, for example `20260602T153806Z-tui-delta-burst-text-run-1`.

Interpretation from first baseline:

- TUI child RSS is materially higher than `run-json` RSS under the same 5k markdown stream.
- Markdown and code TUI bursts are heavier than plain text, especially on `child_max_rss_mb` and `child_max_cpu`.
- This points at TUI render/settle or renderable parsing pressure more than pure session/event overhead.

## Next Target

Investigate and instrument the render path before changing behavior:

- `packages/opencode/src/cli/cmd/run/scrollback.surface.ts`: count `surface.settle()` calls and measure settle duration under 5k markdown/code chunks.
- `packages/opencode/src/cli/cmd/run/session-data.ts`: count `message.part.updated` reductions and text length growth to separate event churn from render churn.
- Re-run the same artifact prefixes after any fix and compare medians with `bun run perf:compare`.

## Real-World Lag Gap

The first baseline explains single-stream TUI render pressure, but it does not yet reproduce the reported system-wide lag from running 5-10 downloaded/compiled OpenCode instances with long-running orchestration and multiple subagents.

Likely missing pressure sources:

- Process fan-out: each instance can add shell processes, git subprocesses, native file watcher threads, and LSP servers.
- Subagent fan-out: each `task` tool call creates nested session work with full prompt orchestration, tool resolution, DB writes, and event publishing.
- Tool churn: real orchestration repeatedly resolves tools, checks permissions, executes shell/read/grep/edit/write flows, and serializes tool results.
- Workspace services: the current perf harness disables project config, LSP, model fetch, autocompact, and external plugins; real usage may enable some or all of those.
- Long-lived pressure: the current mock streams complete in milliseconds, while real orchestration keeps several process trees alive for minutes.

Next real-repro benchmark additions:

1. Done: Add `--enable-lsp` / `--enable-project-config` switches so the harness can compare isolated mode against real workspace services.
2. Done: `tool-loop` performs a real bash tool-call round trip, `parallel-tool-loop` emits several bash calls in one turn, and `subagent-chain` adds one real nested `task` -> subagent -> bash flow.
3. Done: Extend `multi-instance` to run slow streams across multiple process trees and report aggregate child CPU/RSS.
4. Done: Track process counts by role in `summary.json` so lag can be tied to OpenCode children, LSP servers, shells, git, or watcher helpers.
5. Done: Run slow-stream variants with `--delay-ms` to hold multiple instances open long enough to match the real failure mode.

New harness switches:

- `--workspace <path>`: run OpenCode against an existing workspace instead of the temporary home directory.
- `--enable-project-config`: allow workspace `opencode.json` / instructions discovery.
- `--enable-lsp`: set config `lsp: true` instead of disabling LSP.
- `--enable-plugins`: allow plugin discovery instead of `OPENCODE_PURE=1`.
- `--enable-snapshot <true|false>`: keep snapshot git staging on or disable it to isolate repo-git pressure.
- `--enable-autocompact`: allow autocompact background behavior.
- `--enable-models-fetch`: allow model fetch background behavior.
- `--shared-home`: make all multi-instance processes share one test home; useful for reproducing DB lock contention, but not for clean aggregate CPU/RSS runs.

Real-world smoke commands:

```sh
cd packages/opencode

# Isolated homes: cleaner aggregate CPU/RSS across process trees.
bun run perf:run --mode multi-instance --scenario slow-stream --chunks 20 --chunk-size 8 --delay-ms 5 --instances 2 --runs 1 --timeout-ms 30000 --settle-ms 500 --workspace /Users/christian/Documents/Github/opencode-dev --enable-project-config --enable-lsp

# Shared home: intentionally reproduces global DB contention between concurrent instances.
bun run perf:run --mode multi-instance --scenario slow-stream --chunks 20 --chunk-size 8 --delay-ms 5 --instances 2 --runs 1 --timeout-ms 30000 --settle-ms 500 --workspace /Users/christian/Documents/Github/opencode-dev --enable-project-config --enable-lsp --shared-home

# Tool-call round trip without real provider calls.
bun run perf:run --mode run-json --scenario tool-loop --chunks 20 --chunk-size 4 --runs 1 --timeout-ms 30000

# Parallel tool-call burst inside one assistant turn.
bun run perf:run --mode run-json --scenario parallel-tool-loop --tool-calls 4 --runs 1 --timeout-ms 30000

# Nested task -> subagent -> bash chain without real provider calls.
bun run perf:run --mode run-json --scenario subagent-chain --runs 1 --timeout-ms 30000
```

Observed real-world smoke results:

- Detailed result log: `perf/opencode-runtime-performance-results.md`.
- Isolated 2-instance real-workspace smoke `20260602T155140Z-multi-instance-slow-stream-run-1`: 12.130s, 9 unique child processes, 2 OpenCode children, 4 git children, max OpenCode RSS 682MB, max git CPU 95%.
- Shared-home 2-instance real-workspace smoke `20260602T155202Z-multi-instance-slow-stream-run-1`: one process exited `1`, one exited `143`, stdout contained `database is locked`; this matches a likely downloaded-app contention source when many instances share one global data directory.
- `tool-loop` smoke `20260602T154952Z-run-json-tool-loop-run-1`: 3 mock LLM requests and 6 stdout events, proving the tool-call round trip works without real LLM calls.
- Isolated 6-instance real-workspace run `20260602T160141Z-multi-instance-slow-stream-run-1`: 147.604s, 94 unique child processes, 6 OpenCode children, 41 git children, max OpenCode RSS 486MB, max OpenCode CPU 137%, max git CPU 130.6%, all instances ended with expected harness termination code `143`.
- Shared-home 6-instance real-workspace run `20260602T160421Z-multi-instance-slow-stream-run-1`: 180.018s, 15 unique child processes, max OpenCode RSS 1007MB, max OpenCode CPU 187.2%, exit codes `[1, 1, 1, 1, 1, 143]`; stdout showed `index message_session_time_created_id_idx already exists`, so concurrent startup can race database migrations before the long-running workload even stabilizes.

Next real-world repro step:

- Investigate shared-home startup migration concurrency first, because it can crash 5 of 6 simultaneous instances before measuring steady-state lag.
- Strengthen LSP triggering in the harness; current `--enable-lsp` runs still report `lsp: 0`.
- Use Bun-native CPU profiling for per-function attribution instead of the removed custom perf-counter path.

## Interpretation

| Result | Likely Cause |
| --- | --- |
| `run-json` low, `tui` high | TUI/render churn. |
| text low, markdown/code high | `surface.settle()` or renderable parsing cost. |
| all modes high | session/event/reducer churn. |
| only multi-instance high | LSP/filewatch/process-count pressure. |
| grepai-on much worse | external CPU pressure amplifies OpenCode cost. |

## First Commands After Harness Exists

```sh
cd packages/opencode
bun run perf:run --mode run-json --scenario delta-burst-markdown --chunks 5000 --chunk-size 4 --runs 3
bun run perf:run --mode tui --scenario delta-burst-markdown --chunks 5000 --chunk-size 4 --runs 3
bun run perf:run --mode tui --scenario delta-burst-text --chunks 5000 --chunk-size 4 --runs 3
```

## Success Criteria

- We can reproduce the CPU/RAM issue without real LLM calls.
- Every run writes metrics and artifacts automatically.
- We can tell whether the problem is event churn, render churn, external pressure, or a combination.
- Fix branches can prove improvement with lower CPU/RSS or fewer render/settle operations under identical scenarios.
