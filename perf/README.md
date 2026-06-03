# Perf Testing

This harness is now intentionally small.

Use it as a quick black-box CPU/RAM check after a code change.
It does not depend on runtime tuning flags or internal perf hooks.

## What It Measures

- peak CPU for the main OpenCode process under test
- average CPU for the main OpenCode process under test
- peak RSS for the main OpenCode process under test
- average RSS for the main OpenCode process under test
- peak CPU across the whole sampled process tree
- peak RSS across the whole sampled process tree

## What It Does Not Try To Do

- no real LLM calls
- no runtime FPS knobs
- no stream-settle knobs
- no plugin/LSP/project-config toggles
- no long multi-minute stress matrix by default

## Where To Run It

Run commands from `packages/opencode`.

```sh
cd packages/opencode
```

## Main Command

```sh
bun run perf:run
```

Default behavior:

- mode: `tui`
- scenario: `markdown`
- runs: `1`
- chunks: `250`
- chunk size: `12`
- delay: `1ms`

This is meant to finish quickly and print results immediately.

## Supported Flags

- `--mode run-json|tui`
- `--scenario text|markdown|code`
- `--runs <n>`
- `--chunks <n>`
- `--chunk-size <n>`
- `--delay-ms <n>`
- `--timeout-ms <n>`
- `--sample-ms <n>`
- `--settle-ms <n>`
- `--workspace <path>`

## Good Commands

Quick default check:

```sh
bun run perf:run
```

Compare non-TUI vs TUI quickly:

```sh
bun run perf:run --mode run-json --scenario markdown
bun run perf:run --mode tui --scenario markdown
```

Check simpler text rendering:

```sh
bun run perf:run --mode tui --scenario text
```

## Output

Each run prints one summary line immediately.

Example shape:

```text
run 1 | tui/markdown | target=opencode child | duration=2.41s | peak_cpu=201.4% | avg_cpu=132.8% | peak_rss=892.5MB | avg_rss=744.3MB | tree_peak_cpu=214.6% | tree_peak_rss=905.8MB | exit=143 | artifact=...

aggregate
tui/markdown | runs=1 | median_peak_cpu=201.4% | median_peak_rss=892.5MB | median_tree_peak_cpu=214.6% | median_tree_peak_rss=905.8MB | median_duration=2410ms
```

Artifacts are still written to:

```text
packages/opencode/.artifacts/perf/<timestamp>-<mode>-<scenario>-run-<n>/
```

Each artifact includes:

- `run.json`
- `summary.json`
- `processes.jsonl`
- `stdout.log`
- `stderr.log`

## Reading Results

For `tui` mode:

- trust `peak_cpu` and `peak_rss_mb` first
- they target the OpenCode child process, not the PTY wrapper

For `run-json` mode:

- `peak_cpu` and `peak_rss_mb` are the main run process

Use tree metrics when you want the bigger picture:

- `tree_peak_cpu`
- `tree_peak_rss_mb`

## Historical Notes

`perf:compare`, `perf:report`, and the longer notes in this directory still exist for older investigation work.
They are no longer the main path for quick regressions.
