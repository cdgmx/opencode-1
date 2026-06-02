# OpenCode Runtime Performance Results

## 2026-06-02: 6-Instance Real-Workspace Repro

Goal: determine whether 5-10 concurrent OpenCode instances show CPU pressure, memory pressure, or shared-home database contention when using mocked LLM streams.

Commands were run from `packages/opencode` against workspace `/Users/christian/Documents/Github/opencode-dev` with project config and LSP enabled.

### Isolated Homes

Artifact: `packages/opencode/.artifacts/perf/20260602T160141Z-multi-instance-slow-stream-run-1`

Command:

```sh
bun run perf:run --mode multi-instance --scenario slow-stream --chunks 1200 --chunk-size 8 --delay-ms 100 --instances 6 --runs 1 --timeout-ms 180000 --settle-ms 1000 --workspace /Users/christian/Documents/Github/opencode-dev --enable-project-config --enable-lsp
```

Result:

| Metric | Value |
| --- | ---: |
| Duration | `147.604s` |
| Exit codes | `[143, 143, 143, 143, 143, 143]` |
| Unique child processes | `94` |
| OpenCode child count | `6` |
| Git child count | `41` |
| Peak OpenCode RSS | `486.08MB` |
| Peak OpenCode CPU | `137%` |
| Peak git CPU | `130.6%` |
| LSP count | `0` |

Interpretation: isolated concurrent instances completed until harness termination and showed real CPU/process fan-out, especially from OpenCode and git children. This supports CPU/process pressure as one contributor, but does not prove memory is the primary lag cause.

### Shared Home

Artifact: `packages/opencode/.artifacts/perf/20260602T160421Z-multi-instance-slow-stream-run-1`

Command:

```sh
bun run perf:run --mode multi-instance --scenario slow-stream --chunks 1200 --chunk-size 8 --delay-ms 100 --instances 6 --runs 1 --timeout-ms 180000 --settle-ms 1000 --workspace /Users/christian/Documents/Github/opencode-dev --enable-project-config --enable-lsp --shared-home
```

Result:

| Metric | Value |
| --- | ---: |
| Duration | `180.018s` |
| Exit codes | `[1, 1, 1, 1, 1, 143]` |
| Unique child processes | `15` |
| OpenCode child count | `6` |
| Git child count | `6` |
| Peak OpenCode RSS | `1007.19MB` |
| Peak OpenCode CPU | `187.2%` |
| Peak git CPU | `156.7%` |
| LSP count | `0` |

Observed stdout error:

```text
index message_session_time_created_id_idx already exists
```

Interpretation: shared-home concurrent startup can race database migration/index creation. This is stronger evidence for shared SQLite/global home contention than for memory as the primary lag cause, because 5 of 6 instances failed before a clean steady-state workload could be measured.

## Current Conclusion

- CPU/process pressure: supported by 6-instance isolated run.
- Memory pressure: inconclusive; shared-home peak RSS reached about 1GB, but that run was corrupted by migration failures.
- Database contention: strongly supported; shared-home runs have reproduced both `database is locked` and duplicate-index migration failures.
- LSP pressure: not proven; `--enable-lsp` currently still reports `lsp: 0`, so the harness needs stronger LSP triggering.

## Next Verification Step

Add host-level macOS pressure sampling during 6-10 instance runs: total CPU, load average, memory pressure, swap usage, and per-process RSS/CPU over time.
