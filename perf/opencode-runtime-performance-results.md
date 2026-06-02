# OpenCode Runtime Performance Results

HTML comparison report: `perf/opencode-runtime-performance-report.html`.

Regenerate after new runs:

```sh
cd packages/opencode
bun run perf:report .artifacts/perf/20260602T160141Z-multi-instance-slow-stream-run-1 .artifacts/perf/20260602T160421Z-multi-instance-slow-stream-run-1
```

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
- Memory pressure: supported at host level during retest, but not fully attributable to OpenCode because baseline host pressure was already high before the workload warmed up.
- Database contention: strongly supported; shared-home runs have reproduced both `database is locked` and duplicate-index migration failures.
- LSP pressure: not proven; `--enable-lsp` currently still reports `lsp: 0`, so the harness needs stronger LSP triggering.

## Next Verification Step

Capture a quiet-machine baseline, then rerun 6-10 instance isolated homes to separate pre-existing macOS memory pressure from OpenCode-induced pressure.

## 2026-06-02: Host Memory Sampling Retest

Change: perf harness now writes `host.jsonl` with macOS `vm_stat`, `vm.swapusage`, and load average samples, and `summary.json` includes tracked total RSS plus host memory/swap/load peaks.

### Isolated Homes With Host Samples

Artifact: `packages/opencode/.artifacts/perf/20260602T161634Z-multi-instance-slow-stream-run-1`

Result:

| Metric | Value |
| --- | ---: |
| Duration | `153.337s` |
| Exit codes | `[143, 143, 143, 143, 143, 143]` |
| Unique child processes | `84` |
| OpenCode child count | `6` |
| Git child count | `43` |
| Peak tracked total RSS | `2331.8MB` |
| Peak OpenCode RSS | `468.06MB` |
| Peak OpenCode CPU | `130.3%` |
| Host peak memory used | `99.86%` / `16361.84MB` |
| Host peak swap used | `9918.19MB` |
| Host peak 1m load avg | `26.98` |
| LSP count | `0` |

Host baseline note: first host sample was already `97.9%` memory used with `7617MB` swap, so this proves the run occurred under memory pressure but does not by itself prove OpenCode caused all of it.

### Shared Home With Host Samples

Artifact: `packages/opencode/.artifacts/perf/20260602T161916Z-multi-instance-slow-stream-run-1`

Result:

| Metric | Value |
| --- | ---: |
| Duration | `180.036s` |
| Exit codes | `[1, 143, 1, 1, 1, 1]` |
| Unique child processes | `13` |
| OpenCode child count | `6` |
| Git child count | `5` |
| Peak tracked total RSS | `1842.47MB` |
| Peak OpenCode RSS | `877.75MB` |
| Peak OpenCode CPU | `189.3%` |
| Host peak memory used | `99.71%` / `16336.81MB` |
| Host peak swap used | `8542.19MB` |
| Host peak 1m load avg | `11.78` |
| LSP count | `0` |

Observed stdout error:

```text
database is locked
```

Interpretation: shared-home still fails before a clean steady-state workload. This keeps database contention as the strongest shared-home finding. Memory pressure is real on the host, but the shared-home run remains invalid for isolating memory as the primary lag cause.
