import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { testProviderConfig } from "../test/lib/test-provider"

type Mode = "run-json" | "tui" | "multi-instance"
type Scenario = "delta-burst-text" | "delta-burst-markdown" | "delta-burst-code" | "reasoning-burst" | "tool-loop" | "slow-stream" | "multi-instance"

type Args = {
  mode: Mode
  scenario: Scenario
  workspace?: string
  chunks: number
  chunkSize: number
  reasoningChunks: number
  delayMs: number
  runs: number
  instances: number
  timeoutMs: number
  sampleMs: number
  settleMs: number
  enableLsp: boolean
  enableProjectConfig: boolean
  enablePlugins: boolean
  enableAutocompact: boolean
  enableModelsFetch: boolean
  sharedHome: boolean
}

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

type ProcessKind = "wrapper" | "opencode" | "lsp" | "shell" | "git" | "watcher" | "other"

const opencodeRoot = path.resolve(import.meta.dir, "..")
const cliEntry = path.join(opencodeRoot, "src/index.ts")
const artifactRoot = path.join(opencodeRoot, ".artifacts/perf")

const args = parseArgs(Bun.argv.slice(2))
const started = stamp()
const summaries: Array<Awaited<ReturnType<typeof runOnce>>> = []

await mkdir(artifactRoot, { recursive: true })

for (const index of Array.from({ length: args.runs }, (_, index) => index)) {
  summaries.push(await runOnce(args, `${started}-${args.mode}-${args.scenario}-run-${index + 1}`))
}

console.log(JSON.stringify({ artifact_root: artifactRoot, runs: summaries }, null, 2))

async function runOnce(args: Args, artifactName: string) {
  const artifactDir = path.join(artifactRoot, artifactName)
  const home = await mkdtemp(path.join(tmpdir(), "opencode-perf-"))
  const server = createPerfServer(args)
  const workspace = args.workspace ? path.resolve(args.workspace) : home
  await mkdir(artifactDir, { recursive: true })

  try {
    const port = server.port
    const homes = args.mode === "multi-instance" && !args.sharedHome
      ? Array.from({ length: args.instances }, (_, index) => path.join(home, `instance-${index + 1}`))
      : [home]
    await Promise.all(homes.map((item) => mkdir(item, { recursive: true })))
    const procs = spawnScenario(args, homes, `http://127.0.0.1:${port}`, workspace)
    const start = performance.now()
    const stdout = procs.map((proc) => readStream(proc.stdout))
    const stderr = procs.map((proc) => readStream(proc.stderr))
    const samples: ProcessSample[] = []
    const sampler = sampleProcesses(
      procs.map((proc) => proc.pid),
      samples,
      start,
      args.sampleMs,
    )
    const stopWhenSettled = stopInteractiveWhenSettled(args, procs, server)
    const timeout = setTimeout(() => {
      for (const proc of procs) proc.kill()
    }, args.timeoutMs)
    const exitCodes = await Promise.all(procs.map((proc) => proc.exited))
    clearTimeout(timeout)
    stopWhenSettled?.()
    clearInterval(sampler)

    const stdoutText = (await Promise.all(stdout)).join("\n")
    const stderrText = (await Promise.all(stderr)).join("\n")
    await writeFile(path.join(artifactDir, "stdout.log"), stdoutText)
    await writeFile(path.join(artifactDir, "stderr.log"), stderrText)
    await writeFile(path.join(artifactDir, "processes.jsonl"), samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n")
    await writeFile(
      path.join(artifactDir, "metrics.jsonl"),
      [{ type: "run", time: new Date().toISOString(), exit_codes: exitCodes }, ...server.metrics].map((item) => JSON.stringify(item)).join("\n") + "\n",
    )
    await copyDirectTraces(homes, artifactDir)

    const summary = summarize({
      args,
      durationMs: Math.round(performance.now() - start),
      exitCodes,
      llmRequests: server.requestCount,
      stdoutText,
      stderrText,
      samples,
    })
    await writeFile(path.join(artifactDir, "run.json"), JSON.stringify({ args, env: { home, homes, workspace, llm_url: `http://127.0.0.1:${port}` } }, null, 2))
    await writeFile(path.join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2))
    return { artifact_dir: artifactDir, ...summary }
  } finally {
    await server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}

function spawnScenario(args: Args, homes: string[], llmUrl: string, workspace: string) {
  const count = args.mode === "multi-instance" ? args.instances : 1
  return Array.from({ length: count }, (_, index) => spawnOpencode(args, isolatedEnv(args, homes[index] ?? homes[0]!, llmUrl), workspace))
}

function spawnOpencode(args: Args, env: Record<string, string>, home: string) {
  const runArgs = ["run", "--model", "test/test-model", "--dir", home, "--dangerously-skip-permissions"]
  if (args.mode === "run-json") runArgs.push("--format", "json")
  if (args.mode === "tui" || args.mode === "multi-instance") runArgs.push("--interactive")
  runArgs.push("perf stream pressure probe")

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
      for (const proc of procs) proc.kill()
    }, args.settleMs)
  }, 100)
  return () => {
    clearInterval(timer)
    if (settled) clearTimeout(settled)
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

type PerfServer = ReturnType<typeof Bun.serve> & {
  requestCount: number
  completeCount: number
  metrics: Array<Record<string, unknown>>
}

function createPerfServer(args: Args) {
  const metrics: Array<Record<string, unknown>> = []
  let requestCount = 0
  let completeCount = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      if (!url.pathname.endsWith("/chat/completions")) return Response.json({ error: "not found" }, { status: 404 })
      const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined
      requestCount++
      metrics.push({ type: "llm.request", time: new Date().toISOString(), pathname: url.pathname, kind: requestKind(args, body) })
      return new Response(streamResponse(args, metrics, () => completeCount++, requestKind(args, body)), {
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
  Object.defineProperty(server, "metrics", { get: () => metrics, enumerable: true })
  return server as PerfServer
}

function requestKind(args: Args, body: Record<string, unknown> | undefined) {
  if (isTitleRequest(body)) return "title"
  if (args.scenario === "tool-loop" && !hasToolResult(body)) return "tool-call"
  return "text"
}

function isTitleRequest(body: Record<string, unknown> | undefined) {
  return JSON.stringify(body?.messages ?? "").includes("title generator")
}

function hasToolResult(body: Record<string, unknown> | undefined) {
  return JSON.stringify(body?.messages ?? "").includes('"role":"tool"')
}

function streamResponse(args: Args, metrics: Array<Record<string, unknown>>, onComplete: () => void, kind: string) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      const write = async (line: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`))
        if (args.delayMs > 0) await Bun.sleep(args.delayMs)
      }
      await write(chunk({ role: "assistant" }))
      if (kind === "tool-call") {
        await write(chunk({ tool_calls: [{ index: 0, id: "call_perf", type: "function", function: { name: "bash", arguments: "" } }] }))
        await write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: "true" }) } }] }))
        await write(finishChunk("tool_calls"))
      } else {
        for (const delta of scenarioDeltas(args)) await write(chunk(delta))
        await write(finishChunk("stop"))
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      onComplete()
      metrics.push({ type: "llm.complete", time: new Date().toISOString(), delta_chunks: deltaChunks(args) })
      controller.close()
    },
  })
}

function scenarioDeltas(args: Args): Array<Record<string, unknown>> {
  const text = scenarioText(args.scenario)
  const chunks = Array.from({ length: args.chunks }, (_, index) => ({
    content: text.slice(index % text.length).padEnd(args.chunkSize, text).slice(0, args.chunkSize),
  }))
  if (args.scenario !== "reasoning-burst") return chunks
  return [
    ...Array.from({ length: args.reasoningChunks }, (_, index) => ({ reasoning_content: `think-${index} `.slice(0, args.chunkSize) })),
    ...chunks,
  ]
}

function scenarioText(scenario: Scenario) {
  if (scenario === "delta-burst-markdown") return "**bold** [link](https://example.com) `code`\n\n- item\n"
  if (scenario === "delta-burst-code") return "```ts\nconst value = await run();\nconsole.log(value)\n```\n"
  if (scenario === "slow-stream") return "steady stream "
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

function isolatedEnv(args: Args, home: string, llmUrl: string) {
  const config = testProviderConfig(llmUrl)
  config.lsp = args.enableLsp
  return {
    OPENCODE_TEST_HOME: home,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    ...(args.enableProjectConfig ? {} : { OPENCODE_DISABLE_PROJECT_CONFIG: "1" }),
    ...(args.enablePlugins ? {} : { OPENCODE_PURE: "1" }),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    ...(args.enableAutocompact ? {} : { OPENCODE_DISABLE_AUTOCOMPACT: "1" }),
    ...(args.enableModelsFetch ? {} : { OPENCODE_DISABLE_MODELS_FETCH: "1" }),
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_DIRECT_TRACE: "1",
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
  if (name.includes("language-server") || name.includes("tsserver") || name.includes("typescript")) return "lsp"
  if (name.endsWith("/git") || name === "git") return "git"
  if (name.includes("fsevent") || name.includes("watchman")) return "watcher"
  if (name.endsWith("/sh") || name.endsWith("/zsh") || name.endsWith("/bash") || name === "sh" || name === "zsh" || name === "bash") return "shell"
  return "other"
}

async function readStream(stream: ReadableStream<Uint8Array>) {
  return await new Response(stream).text()
}

async function copyDirectTrace(home: string, artifactDir: string) {
  const dir = path.join(home, ".local/share/opencode/log/direct")
  try {
    const latest = JSON.parse(await readFile(path.join(dir, "latest.json"), "utf8")) as { path?: string }
    if (latest.path) {
      await mkdir(artifactDir, { recursive: true })
      await writeFile(path.join(artifactDir, "trace.jsonl"), await readFile(latest.path, "utf8"))
    }
  } catch {
    return
  }
}

async function copyDirectTraces(homes: string[], artifactDir: string) {
  await Promise.all(homes.map((home, index) => copyDirectTrace(home, path.join(artifactDir, `trace-${index + 1}`))))
}

function summarize(input: {
  args: Args
  durationMs: number
  exitCodes: number[]
  llmRequests: number
  stdoutText: string
  stderrText: string
  samples: ProcessSample[]
}) {
  const parent = input.samples.filter((sample) => sample.role === "parent")
  const child = input.samples.filter((sample) => sample.role === "child")
  return {
    scenario: input.args.scenario,
    mode: input.args.mode,
    duration_ms: input.durationMs,
    max_cpu: max(parent.map((sample) => sample.cpu)),
    avg_cpu: avg(parent.map((sample) => sample.cpu)),
    max_rss_mb: max(parent.map((sample) => sample.rss_mb)),
    avg_rss_mb: avg(parent.map((sample) => sample.rss_mb)),
    child_max_cpu: max(child.map((sample) => sample.cpu)),
    child_max_rss_mb: max(child.map((sample) => sample.rss_mb)),
    child_process_count: new Set(child.map((sample) => sample.pid)).size,
    child_process_kind_samples: countByKind(child),
    child_process_kind_counts: countUniqueByKind(child),
    child_kind_max_rss_mb: maxByKind(child, (sample) => sample.rss_mb),
    child_kind_max_cpu: maxByKind(child, (sample) => sample.cpu),
    llm_requests: input.llmRequests,
    delta_chunks: deltaChunks(input.args),
    chunks_per_second: Number((deltaChunks(input.args) / (input.durationMs / 1000)).toFixed(2)),
    stdout_events: input.stdoutText.split("\n").filter((line) => line.trim().startsWith("{")).length,
    stderr_bytes: new TextEncoder().encode(input.stderrText).byteLength,
    exit_code: input.exitCodes.length === 1 ? input.exitCodes[0] : input.exitCodes,
  }
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>()
  for (const index of Array.from({ length: argv.length }, (_, index) => index)) {
    if (!argv[index]?.startsWith("--")) continue
    values.set(argv[index].slice(2), argv[index + 1]?.startsWith("--") ? "" : (argv[index + 1] ?? ""))
  }
  return {
    mode: enumValue(values.get("mode") ?? "run-json", ["run-json", "tui", "multi-instance"]),
    scenario: enumValue(values.get("scenario") ?? "delta-burst-text", [
      "delta-burst-text",
      "delta-burst-markdown",
      "delta-burst-code",
      "reasoning-burst",
      "tool-loop",
      "slow-stream",
      "multi-instance",
    ]),
    workspace: values.get("workspace"),
    chunks: positiveInt(values.get("chunks") ?? "1000", "chunks"),
    chunkSize: positiveInt(values.get("chunk-size") ?? "8", "chunk-size"),
    reasoningChunks: positiveInt(values.get("reasoning-chunks") ?? "1000", "reasoning-chunks"),
    delayMs: nonNegativeInt(values.get("delay-ms") ?? (values.get("scenario") === "slow-stream" ? "50" : "0"), "delay-ms"),
    runs: positiveInt(values.get("runs") ?? "1", "runs"),
    instances: positiveInt(values.get("instances") ?? "5", "instances"),
    timeoutMs: positiveInt(values.get("timeout-ms") ?? "120000", "timeout-ms"),
    sampleMs: positiveInt(values.get("sample-ms") ?? "250", "sample-ms"),
    settleMs: positiveInt(values.get("settle-ms") ?? "2000", "settle-ms"),
    enableLsp: booleanFlag(values, "enable-lsp"),
    enableProjectConfig: booleanFlag(values, "enable-project-config"),
    enablePlugins: booleanFlag(values, "enable-plugins"),
    enableAutocompact: booleanFlag(values, "enable-autocompact"),
    enableModelsFetch: booleanFlag(values, "enable-models-fetch"),
    sharedHome: booleanFlag(values, "shared-home"),
  }
}

function countByKind(samples: ProcessSample[]) {
  return samples.reduce<Record<ProcessKind, number>>(
    (result, sample) => ({ ...result, [sample.kind]: result[sample.kind] + 1 }),
    { wrapper: 0, opencode: 0, lsp: 0, shell: 0, git: 0, watcher: 0, other: 0 },
  )
}

function countUniqueByKind(samples: ProcessSample[]) {
  return Object.fromEntries(
    (["wrapper", "opencode", "lsp", "shell", "git", "watcher", "other"] as const).map((kind) => [
      kind,
      new Set(samples.filter((sample) => sample.kind === kind).map((sample) => sample.pid)).size,
    ]),
  ) as Record<ProcessKind, number>
}

function maxByKind(samples: ProcessSample[], value: (sample: ProcessSample) => number) {
  return samples.reduce<Record<ProcessKind, number>>(
    (result, sample) => ({ ...result, [sample.kind]: Math.max(result[sample.kind], value(sample)) }),
    { wrapper: 0, opencode: 0, lsp: 0, shell: 0, git: 0, watcher: 0, other: 0 },
  )
}

function booleanFlag(values: Map<string, string>, name: string) {
  const value = values.get(name)
  if (value === undefined) return false
  if (value === "" || value === "true" || value === "1") return true
  if (value === "false" || value === "0") return false
  throw new Error(`--${name} must be true or false`)
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

function deltaChunks(args: Args) {
  return args.chunks + (args.scenario === "reasoning-burst" ? args.reasoningChunks : 0)
}

function avg(values: number[]) {
  if (values.length === 0) return 0
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
}

function max(values: number[]) {
  if (values.length === 0) return 0
  return Number(Math.max(...values).toFixed(2))
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
}
