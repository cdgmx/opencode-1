# OpenCode Runtime Performance Plan

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

1. Add a process sampler that records parent/child PID CPU and RSS at fixed intervals.
2. Add artifact writer under `packages/opencode/.artifacts/perf/<timestamp>-<scenario>/`.
3. Add a mock LLM perf server that emits configurable chunk counts, chunk sizes, reasoning chunks, tool calls, delays, and failures.
4. Add `perf:run` script for `opencode run --format json` to measure session/event overhead without TUI render pressure.
5. Add TUI/direct-mode stress runner to measure actual OpenTUI render pressure.
6. Add multi-instance runner to mirror 5-10 OpenCode processes across one or more repos.
7. Add comparison helper that summarizes metrics across baseline and fix worktrees.

## Initial Scenarios

| Scenario | Purpose |
| --- | --- |
| `delta-burst-text` | Many tiny plain-text chunks; baseline stream overhead. |
| `delta-burst-markdown` | Many tiny markdown chunks; likely `surface.settle()` stress. |
| `delta-burst-code` | Many tiny code chunks; code render stress. |
| `reasoning-burst` | Thinking stream pressure before final answer. |
| `tool-loop` | Tool-call round-trip pressure. |
| `slow-stream` | Long steady stream at fixed tokens/sec. |
| `multi-instance` | Several OpenCode processes plus child processes. |

## Metrics

- `duration_ms`
- `max_cpu`, `avg_cpu`
- `max_rss_mb`, `avg_rss_mb`
- `child_max_cpu`, `child_max_rss_mb`
- `llm_requests`
- `delta_chunks`
- `chunks_per_second`
- `stdout_events`
- `stderr_bytes`
- `exit_code`

## Artifact Shape

```text
packages/opencode/.artifacts/perf/<timestamp>-<scenario>/
  run.json
  metrics.jsonl
  processes.jsonl
  summary.json
  stdout.log
  stderr.log
  sample-<pid>.txt
```

## Test Matrix

1. Run `run-json` markdown burst to measure non-TUI session/event overhead.
2. Run `tui` markdown burst to measure render overhead.
3. Run `tui` text burst to check whether markdown/code are uniquely expensive.
4. Run `tui` code burst if markdown is hot.
5. Run multi-instance only after single-instance cause is clear.
6. Run grepai on/off as a separate external-pressure comparison.

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
