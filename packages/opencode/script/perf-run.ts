import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { testProviderConfig } from "../test/lib/test-provider"

type Mode = "run-json" | "tui"
type Scenario = "text" | "markdown" | "code"

type Args = {
  mode: Mode
  scenario: Scenario
  workspace?: string
  runs: number
  chunks: number
  chunkSize: number
  delayMs: number
  timeoutMs: number
  sampleMs: number
  settleMs: number
}

type ProcessKind = "wrapper" | "opencode" | "shell" | "git" | "watcher" | "other"

type ProcessSample = {
  time: string
  elapsed_ms: number
  pid: number
  cpu: number
  rss_mb: number
  role: "parent" | "child"
  kind: ProcessKind
  command: string
}

type Summary = {
  scenario: Scenario
  mode: Mode
  target: string
  duration_ms: number
  peak_cpu: number
  avg_cpu: number
  peak_rss_mb: number
  avg_rss_mb: number
  tree_peak_cpu: number
  tree_avg_cpu: number
  tree_peak_rss_mb: number
  tree_avg_rss_mb: number
  llm_requests: number
  sample_count: number
  exit_code: number | number[]
}

const opencodeRoot = path.resolve(import.meta.dir, "..")
const cliEntry = path.join(opencodeRoot, "src/index.ts")
const artifactRoot = path.join(opencodeRoot, ".artifacts/perf")
const rootPrompt = "perf blackbox cpu ram probe"

const args = parseArgs(Bun.argv.slice(2))
const started = stamp()

await mkdir(artifactRoot, { recursive: true })

const runs = await Promise.all(
  Array.from({ length: args.runs }, (_, index) => runOnce(args, `${started}-${args.mode}-${args.scenario}-run-${index + 1}`)),
)

for (const [index, run] of runs.entries()) {
  printRun(index + 1, run.summary, run.artifact_dir)
}

printAggregate(runs.map((run) => run.summary))

async function runOnce(args: Args, artifactName: string) {
  const artifactDir = path.join(artifactRoot, artifactName)
  const home = await mkdtemp(path.join(tmpdir(), "opencode-perf-"))
  const server = createPerfServer(args)
  const workspace = args.workspace ? path.resolve(args.workspace) : home
  await mkdir(artifactDir, { recursive: true })

  try {
    const proc = spawnOpencode(args, isolatedEnv(home, `http://127.0.0.1:${server.port}`), workspace)
    const start = performance.now()
    const stdout = readStream(proc.stdout)
    const stderr = readStream(proc.stderr)
    const samples: ProcessSample[] = []
    const sampler = sampleProcesses([proc.pid], samples, start, args.sampleMs)
    const stopWhenSettled = stopInteractiveWhenSettled(args, [proc], server)
    const timeout = setTimeout(() => terminateProc(proc), args.timeoutMs)
    const exitCode = await proc.exited
    clearTimeout(timeout)
    stopWhenSettled?.()
    clearInterval(sampler)

    const stdoutText = await stdout
    const stderrText = await stderr
    const summary = summarize({
      args,
      durationMs: Math.round(performance.now() - start),
      exitCode,
      llmRequests: server.requestCount,
      samples,
    })

    await writeFile(path.join(artifactDir, "run.json"), JSON.stringify({ args, workspace }, null, 2))
    await writeFile(path.join(artifactDir, "stdout.log"), stdoutText)
    await writeFile(path.join(artifactDir, "stderr.log"), stderrText)
    await writeFile(path.join(artifactDir, "processes.jsonl"), samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n")
    await writeFile(path.join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2))

    return {
      artifact_dir: artifactDir,
      summary,
    }
  } finally {
    await server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}

function spawnOpencode(args: Args, env: Record<string, string>, workspace: string) {
  const runArgs = [
    "run",
    "--model",
    "test/test-model",
    "--dir",
    workspace,
    "--dangerously-skip-permissions",
  ]
  if (args.mode === "run-json") runArgs.push("--format", "json")
  if (args.mode === "tui") runArgs.push("--interactive")
  runArgs.push(rootPrompt)

  const command = ["bun", "run", "--conditions=browser", cliEntry, ...runArgs]
  return Bun.spawn(wrapTtyIfNeeded(args.mode, command), {
    cwd: opencodeRoot,
    env: { ...Bun.env, ...env },
    stdin: args.mode === "run-json" ? "inherit" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
}

function wrapTtyIfNeeded(mode: Mode, command: string[]) {
  if (mode === "run-json") return command
  const wrapped = `stty rows 40 cols 120; export COLUMNS=120 LINES=40; exec ${command.map(shellQuote).join(" ")}`
  if (process.platform === "darwin") return ["script", "-q", "/dev/null", "/bin/zsh", "-lc", wrapped]
  return ["script", "-q", "/dev/null", "-c", wrapped]
}

function stopInteractiveWhenSettled(args: Args, procs: Array<ReturnType<typeof Bun.spawn>>, server: PerfServer) {
  if (args.mode === "run-json") return
  const expectedCompletions = procs.length * 2
  let settled: ReturnType<typeof setTimeout> | undefined
  const timer = setInterval(() => {
    if (server.completeCount < expectedCompletions || settled) return
    settled = setTimeout(() => {
      for (const proc of procs) terminateProc(proc)
    }, args.settleMs)
  }, 100)
  return () => {
    clearInterval(timer)
    if (settled) clearTimeout(settled)
  }
}

function terminateProc(proc: ReturnType<typeof Bun.spawn>) {
  proc.kill()
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

type PerfServer = ReturnType<typeof Bun.serve> & {
  requestCount: number
  completeCount: number
}

function createPerfServer(args: Args) {
  let requestCount = 0
  let completeCount = 0

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      if (!url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: "not found" }, { status: 404 })
      }

      const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined
      requestCount++

      return new Response(streamResponse(args, isTitleRequest(body), () => completeCount++), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      })
    },
  })

  Object.defineProperty(server, "requestCount", { get: () => requestCount, enumerable: true })
  Object.defineProperty(server, "completeCount", { get: () => completeCount, enumerable: true })
  return server as PerfServer
}

function isTitleRequest(body: Record<string, unknown> | undefined) {
  return JSON.stringify(body?.messages ?? "").includes("title generator")
}

function streamResponse(args: Args, titleRequest: boolean, onComplete: () => void) {
  const encoder = new TextEncoder()
  const chunks = titleRequest ? [{ content: "Perf title" }] : scenarioDeltas(args)

  return new ReadableStream({
    async start(controller) {
      const write = async (line: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`))
        if (args.delayMs > 0) await Bun.sleep(args.delayMs)
      }

      await write(chunk({ role: "assistant" }))
      for (const delta of chunks) {
        await write(chunk(delta))
      }
      await write(finishChunk("stop"))
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      onComplete()
      controller.close()
    },
  })
}

function scenarioDeltas(args: Args) {
  const text = scenarioText(args.scenario)
  return Array.from({ length: args.chunks }, (_, index) => ({
    content: text.slice(index % text.length).padEnd(args.chunkSize, text).slice(0, args.chunkSize),
  }))
}

function scenarioText(scenario: Scenario) {
  if (scenario === "markdown") {
    return "**bold** [link](https://example.com) `code`\n\n- item\n"
  }

  if (scenario === "code") {
    return "```ts\nconst value = await run();\nconsole.log(value)\n```\n"
  }

  return "plain text "
}

function chunk(delta: Record<string, unknown>) {
  return {
    id: "chatcmpl-perf",
    object: "chat.completion.chunk",
    choices: [{ delta }],
  }
}

function finishChunk(reason: string) {
  return {
    id: "chatcmpl-perf",
    object: "chat.completion.chunk",
    choices: [{ delta: {}, finish_reason: reason }],
  }
}

function isolatedEnv(home: string, llmUrl: string) {
  const config = testProviderConfig(llmUrl)
  config.lsp = false

  return {
    OPENCODE_TEST_HOME: home,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      snapshot: false,
    }),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}",
  }
}

function sampleProcesses(parentPids: number[], samples: ProcessSample[], start: number, sampleMs: number) {
  const collect = async () => {
    const table = await processTable()
    const descendants = new Set(parentPids.flatMap((pid) => findDescendants(pid, table)))

    for (const pid of parentPids) {
      const row = table.get(pid)
      if (row) samples.push(toSample(row, "parent", start))
    }

    for (const pid of descendants) {
      const row = table.get(pid)
      if (row) samples.push(toSample(row, "child", start))
    }
  }

  void collect()
  return setInterval(() => void collect(), sampleMs)
}

async function processTable() {
  const proc = Bun.spawn(["ps", "-axo", "pid=,ppid=,pcpu=,rss=,comm="], { stdout: "pipe", stderr: "ignore" })
  const output = await new Response(proc.stdout).text()
  await proc.exited

  return new Map(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const [pid, ppid, cpu, rss, ...command] = line.trim().split(/\s+/)
        return {
          pid: Number(pid),
          ppid: Number(ppid),
          cpu: Number(cpu),
          rss: Number(rss),
          command: command.join(" "),
        }
      })
      .filter((row) => [row.pid, row.ppid, row.cpu, row.rss].every(Number.isFinite))
      .map((row) => [row.pid, row]),
  )
}

function findDescendants(pid: number, table: Map<number, { pid: number; ppid: number }>): number[] {
  const children = [...table.values()].filter((row) => row.ppid === pid).map((row) => row.pid)
  return [...children, ...children.flatMap((child) => findDescendants(child, table))]
}

function toSample(row: { pid: number; cpu: number; rss: number; command: string }, role: "parent" | "child", start: number): ProcessSample {
  return {
    time: new Date().toISOString(),
    elapsed_ms: Math.round(performance.now() - start),
    pid: row.pid,
    cpu: row.cpu,
    rss_mb: Number((row.rss / 1024).toFixed(2)),
    role,
    kind: classifyProcess(row.command, role),
    command: row.command,
  }
}

function classifyProcess(command: string, role: "parent" | "child"): ProcessKind {
  const name = command.toLowerCase()
  if (role === "parent") return "wrapper"
  if (name.includes("opencode") || name.endsWith("/bun") || name === "bun") return "opencode"
  if (name.endsWith("/git") || name === "git") return "git"
  if (name.includes("fsevent") || name.includes("watchman")) return "watcher"
  if (name.endsWith("/sh") || name.endsWith("/zsh") || name.endsWith("/bash") || name === "sh" || name === "zsh" || name === "bash") {
    return "shell"
  }
  return "other"
}

async function readStream(stream: ReadableStream<Uint8Array>) {
  return await new Response(stream).text()
}

function summarize(input: {
  args: Args
  durationMs: number
  exitCode: number
  llmRequests: number
  samples: ProcessSample[]
}): Summary {
  const targetSamples = primarySamples(input.args.mode, input.samples)
  const treeCpu = totalsByElapsed(input.samples, (sample) => sample.cpu)
  const treeRss = totalsByElapsed(input.samples, (sample) => sample.rss_mb)

  return {
    scenario: input.args.scenario,
    mode: input.args.mode,
    target: input.args.mode === "tui" ? "opencode child" : "run process",
    duration_ms: input.durationMs,
    peak_cpu: max(targetSamples.map((sample) => sample.cpu)),
    avg_cpu: avg(targetSamples.map((sample) => sample.cpu)),
    peak_rss_mb: max(targetSamples.map((sample) => sample.rss_mb)),
    avg_rss_mb: avg(targetSamples.map((sample) => sample.rss_mb)),
    tree_peak_cpu: max(treeCpu),
    tree_avg_cpu: avg(treeCpu),
    tree_peak_rss_mb: max(treeRss),
    tree_avg_rss_mb: avg(treeRss),
    llm_requests: input.llmRequests,
    sample_count: targetSamples.length,
    exit_code: input.exitCode,
  }
}

function primarySamples(mode: Mode, samples: ProcessSample[]) {
  const opencode = samples.filter((sample) => sample.kind === "opencode")
  if (mode === "tui" && opencode.length > 0) {
    return opencode
  }

  const parent = samples.filter((sample) => sample.role === "parent")
  if (parent.length > 0) {
    return parent
  }

  return opencode.length > 0 ? opencode : samples
}

function totalsByElapsed(samples: ProcessSample[], value: (sample: ProcessSample) => number) {
  return Object.values(
    samples.reduce<Record<string, number>>(
      (result, sample) => ({
        ...result,
        [sample.elapsed_ms]: Number(((result[sample.elapsed_ms] ?? 0) + value(sample)).toFixed(2)),
      }),
      {},
    ),
  )
}

function printRun(index: number, summary: Summary, artifactDir: string) {
  const duration = (summary.duration_ms / 1000).toFixed(2)
  console.log(
    [
      `run ${index}`,
      `${summary.mode}/${summary.scenario}`,
      `target=${summary.target}`,
      `duration=${duration}s`,
      `peak_cpu=${summary.peak_cpu}%`,
      `avg_cpu=${summary.avg_cpu}%`,
      `peak_rss=${summary.peak_rss_mb}MB`,
      `avg_rss=${summary.avg_rss_mb}MB`,
      `tree_peak_cpu=${summary.tree_peak_cpu}%`,
      `tree_peak_rss=${summary.tree_peak_rss_mb}MB`,
      `exit=${summary.exit_code}`,
      `artifact=${artifactDir}`,
    ].join(" | "),
  )
}

function printAggregate(summaries: Summary[]) {
  const first = summaries[0]
  if (!first) return

  console.log("")
  console.log("aggregate")
  console.log(
    [
      `${first.mode}/${first.scenario}`,
      `runs=${summaries.length}`,
      `median_peak_cpu=${median(summaries.map((summary) => summary.peak_cpu))}%`,
      `median_peak_rss=${median(summaries.map((summary) => summary.peak_rss_mb))}MB`,
      `median_tree_peak_cpu=${median(summaries.map((summary) => summary.tree_peak_cpu))}%`,
      `median_tree_peak_rss=${median(summaries.map((summary) => summary.tree_peak_rss_mb))}MB`,
      `median_duration=${median(summaries.map((summary) => summary.duration_ms))}ms`,
    ].join(" | "),
  )
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>()
  for (const index of Array.from({ length: argv.length }, (_, index) => index)) {
    if (!argv[index]?.startsWith("--")) continue
    values.set(argv[index].slice(2), argv[index + 1]?.startsWith("--") ? "" : (argv[index + 1] ?? ""))
  }

  const mode = enumValue(values.get("mode") ?? "tui", ["run-json", "tui"])
  return {
    mode,
    scenario: enumValue(values.get("scenario") ?? "markdown", ["text", "markdown", "code"]),
    workspace: values.get("workspace"),
    runs: positiveInt(values.get("runs") ?? "1", "runs"),
    chunks: positiveInt(values.get("chunks") ?? "250", "chunks"),
    chunkSize: positiveInt(values.get("chunk-size") ?? "12", "chunk-size"),
    delayMs: nonNegativeInt(values.get("delay-ms") ?? (mode === "tui" ? "1" : "0"), "delay-ms"),
    timeoutMs: positiveInt(values.get("timeout-ms") ?? "20000", "timeout-ms"),
    sampleMs: positiveInt(values.get("sample-ms") ?? "100", "sample-ms"),
    settleMs: positiveInt(values.get("settle-ms") ?? "500", "settle-ms"),
  }
}

function enumValue<T extends string>(value: string, choices: readonly T[]): T {
  const match = choices.find((choice) => choice === value)
  if (match) return match
  throw new Error(`Invalid value ${value}; expected one of ${choices.join(", ")}`)
}

function positiveInt(value: string, name: string) {
  const number = Number(value)
  if (Number.isInteger(number) && number > 0) return number
  throw new Error(`--${name} must be a positive integer`)
}

function nonNegativeInt(value: string, name: string) {
  const number = Number(value)
  if (Number.isInteger(number) && number >= 0) return number
  throw new Error(`--${name} must be a non-negative integer`)
}

function avg(values: number[]) {
  if (values.length === 0) return 0
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
}

function max(values: number[]) {
  if (values.length === 0) return 0
  return Number(Math.max(...values).toFixed(2))
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return Number(sorted[middle]!.toFixed(2))
  return Number((((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2).toFixed(2))
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
}
