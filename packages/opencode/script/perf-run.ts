import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { testProviderConfig } from "../test/lib/test-provider"

type Mode = "run-json" | "tui"
type Scenario = "text" | "markdown" | "code" | "read-ts" | "lsp-ts" | "task-ts"
type Runner = "source" | "binary"

type Args = {
  mode: Mode
  scenario: Scenario
  runner: Runner
  mdFinalizeMode: string
  perfTiming: boolean
  smol: boolean
  cpuProfile: boolean
  workspace?: string
  title?: string
  attach: boolean
  warmHome: boolean
  runs: number
  chunks: number
  chunkSize: number
  delayMs: number
  timeoutMs: number
  sampleMs: number
  settleMs: number
  instances: number
  enableLsp: boolean
  disableLspDownload: boolean
  memoryCheckpoints: boolean
  memoryInstances: number
  memoryCheckpointNames: string
  heapSnapshots: boolean
  heapInstances: number
  heapCheckpoints: string
}

type ProcessKind = "wrapper" | "opencode" | "shell" | "git" | "lsp" | "watcher" | "npm" | "other"

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
  runner: Runner
  md_finalize_mode: string
  smol: boolean
  attach: boolean
  warm_home: boolean
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
  process_kind_counts: Record<ProcessKind, number>
  process_kind_peak_cpu: Record<ProcessKind, number>
  process_kind_peak_rss_mb: Record<ProcessKind, number>
  process_kind_tree_peak_cpu: Record<ProcessKind, number>
  process_kind_tree_peak_rss_mb: Record<ProcessKind, number>
  llm_requests: number
  sample_count: number
  exit_code: number | number[]
  timing_instances: number
  boot_complete_ms?: number
  first_visible_ms?: number
  last_visible_ms?: number
  final_rich_done_ms?: number
  finalization_tail_ms?: number
}

type PerfTimingName = "boot_complete" | "first_visible" | "last_visible" | "final_rich_start" | "final_rich_done"

type PerfTimingEvent = {
  instance: string
  name: PerfTimingName
  ms: number
}

const opencodeRoot = path.resolve(import.meta.dir, "..")
const cliEntry = path.join(opencodeRoot, "src/index.ts")
const binaryEntry = path.join(opencodeRoot, "dist", `opencode-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`, "bin", process.platform === "win32" ? "opencode.exe" : "opencode")
const artifactRoot = path.join(opencodeRoot, ".artifacts/perf")
const rootPrompt = "perf blackbox cpu ram probe"
const processKinds: ProcessKind[] = ["wrapper", "opencode", "shell", "git", "lsp", "watcher", "npm", "other"]

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
  const homes = await Promise.all(Array.from({ length: args.instances }, () => mkdtemp(path.join(tmpdir(), "opencode-perf-"))))
  const serverHome = args.attach ? await mkdtemp(path.join(tmpdir(), "opencode-perf-server-")) : undefined
  const workspace =
    args.workspace ? path.resolve(args.workspace) : needsRepoWorkspace(args.scenario) ? opencodeRoot : homes[0]!
  const llm = createPerfServer(args, workspace)
  if (args.warmHome) {
    await warmHomes(args, [...homes, ...(serverHome ? [serverHome] : [])], `http://127.0.0.1:${llm.port}`)
  }
  const opencodeServer = serverHome ? await startOpencodeServer(args, serverHome, `http://127.0.0.1:${llm.port}`) : undefined
  await mkdir(artifactDir, { recursive: true })

  try {
    const procs = homes.map((home, index) =>
      spawnOpencode(
        args,
        isolatedEnv(args, home, `http://127.0.0.1:${llm.port}`, {
          artifactDir,
          index,
        }),
        workspace,
        opencodeServer?.url,
      ),
    )
    const start = performance.now()
    const stdout = procs.map((proc) => readStream(proc.stdout))
    const stderr = procs.map((proc) => readStream(proc.stderr))
    const serverStdout = opencodeServer ? readStream(opencodeServer.stdout) : undefined
    const serverStderr = opencodeServer ? readStream(opencodeServer.stderr) : undefined
    const samples: ProcessSample[] = []
    const sampler = sampleProcesses(
      [...procs.map((proc) => proc.pid), ...(opencodeServer ? [opencodeServer.proc.pid] : [])],
      samples,
      start,
      args.sampleMs,
    )
    const stopWhenSettled = stopInteractiveWhenSettled(args, procs, llm)
    const timeout = setTimeout(() => {
      for (const proc of procs) terminateProc(proc)
    }, args.timeoutMs)
    const exitCode = await Promise.all(procs.map((proc) => proc.exited))
    clearTimeout(timeout)
    stopWhenSettled?.()
    clearInterval(sampler)
    if (opencodeServer) terminateProc(opencodeServer.proc)

    const stdoutText = (await Promise.all(stdout)).join("\n")
    const stderrText = (await Promise.all(stderr)).join("\n")
    const timingText = await readFile(path.join(artifactDir, "timings.jsonl"), "utf8").catch(() => "")
    const summary = summarize({
      args,
      durationMs: Math.round(performance.now() - start),
      exitCode: args.instances === 1 ? exitCode[0]! : exitCode,
      llmRequests: llm.requestCount,
      samples,
      timings: parsePerfTimings(timingText || stderrText),
    })

    await writeFile(
      path.join(artifactDir, "run.json"),
      JSON.stringify({ args, workspace, tool_file: toolFile(workspace), opencode_server: opencodeServer?.url }, null, 2),
    )
    await writeFile(path.join(artifactDir, "stdout.log"), stdoutText)
    await writeFile(path.join(artifactDir, "stderr.log"), stderrText)
    if (serverStdout) await writeFile(path.join(artifactDir, "opencode-server.stdout.log"), await serverStdout)
    if (serverStderr) await writeFile(path.join(artifactDir, "opencode-server.stderr.log"), await serverStderr)
    await writeFile(path.join(artifactDir, "processes.jsonl"), samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n")
    await writeFile(path.join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2))

    return {
      artifact_dir: artifactDir,
      summary,
    }
  } finally {
    if (opencodeServer) terminateProc(opencodeServer.proc)
    await llm.stop(true)
    await Promise.all([...homes, ...(serverHome ? [serverHome] : [])].map((home) => rm(home, { recursive: true, force: true })))
  }
}

async function warmHomes(args: Args, homes: string[], llmUrl: string) {
  await Promise.all(
    homes.map(async (home) => {
      const proc = Bun.spawn(opencodeCommand({ ...args, cpuProfile: false }, ["db", "path"]), {
        cwd: opencodeRoot,
        env: { ...Bun.env, ...isolatedEnv(args, home, llmUrl) },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        throw new Error(`home warmup failed with exit code ${exitCode}`)
      }
    }),
  )
}

type OpencodeServer = {
  proc: ReturnType<typeof Bun.spawn>
  url: string
  port: number
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
}

async function startOpencodeServer(args: Args, home: string, llmUrl: string): Promise<OpencodeServer> {
  const port = await availablePort()
  const proc = Bun.spawn(opencodeCommand(args, ["serve", "--hostname", "127.0.0.1", "--port", String(port)]), {
    cwd: opencodeRoot,
    env: { ...Bun.env, ...isolatedEnv(args, home, llmUrl) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const server = { proc, url: `http://127.0.0.1:${port}`, port, stdout: proc.stdout, stderr: proc.stderr }
  try {
    await waitForServer(server)
  } catch (error) {
    terminateProc(proc)
    throw error
  }
  return server
}

async function availablePort() {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") })
  const port = server.port
  await server.stop(true)
  if (port === undefined) throw new Error("failed to allocate a port")
  return port
}

async function waitForServer(server: OpencodeServer) {
  const timeoutAt = performance.now() + 20_000
  const healthUrl = `${server.url}/global/health`
  while (performance.now() < timeoutAt) {
    if (server.proc.exitCode !== null) {
      throw new Error(`opencode server exited before clients could attach at ${server.url}`)
    }

    const ready = await fetch(healthUrl)
      .then((response) => response.ok)
      .catch(() => false)
    if (ready) {
      return
    }

    await Bun.sleep(100)
  }

  throw new Error(`opencode server did not become ready at ${server.url}`)
}

function spawnOpencode(args: Args, env: Record<string, string>, workspace: string, attachUrl: string | undefined) {
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
  if (attachUrl) runArgs.push("--attach", attachUrl)
  if (args.title !== undefined) runArgs.push("--title", args.title)
  runArgs.push(rootPrompt)

  const command = opencodeCommand(args, runArgs)
  return Bun.spawn(wrapTtyIfNeeded(args.mode, command), {
    cwd: opencodeRoot,
    env: { ...Bun.env, ...env },
    stdin: args.mode === "run-json" ? "inherit" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
}

function opencodeCommand(args: Args, commandArgs: string[]) {
  if (args.runner === "binary") return [binaryEntry, ...commandArgs]
  return [
    "bun",
    ...(args.smol ? ["--smol"] : []),
    ...(args.cpuProfile ? ["--cpu-prof", "--cpu-prof-md"] : []),
    "run",
    "--conditions=browser",
    cliEntry,
    ...commandArgs,
  ]
}

function wrapTtyIfNeeded(mode: Mode, command: string[]) {
  if (mode === "run-json") return command
  const wrapped = `stty rows 40 cols 120; export COLUMNS=120 LINES=40; exec ${command.map(shellQuote).join(" ")}`
  if (process.platform === "darwin") return ["script", "-q", "/dev/null", "/bin/zsh", "-lc", wrapped]
  return ["script", "-q", "/dev/null", "-c", wrapped]
}

function stopInteractiveWhenSettled(args: Args, procs: Array<ReturnType<typeof Bun.spawn>>, server: PerfServer) {
  if (args.mode === "run-json") return
  const expectedCompletions =
    procs.length * ((needsToolTurn(args.scenario) ? 2 : 1) + (args.title === undefined ? 1 : 0))
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

function createPerfServer(args: Args, workspace: string) {
  let requestCount = 0
  let completeCount = 0

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      const mode = requestMode(url.pathname)
      if (!mode) {
        return Response.json({ error: "not found" }, { status: 404 })
      }

      const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined
      requestCount++

      return new Response(streamResponse(args, workspace, body, mode, () => completeCount++), {
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

function hasToolResult(body: Record<string, unknown> | undefined) {
  return JSON.stringify(body?.messages ?? body ?? "").includes('"role":"tool"')
}

function streamResponse(
  args: Args,
  workspace: string,
  body: Record<string, unknown> | undefined,
  mode: "chat" | "responses",
  onComplete: () => void,
) {
  const encoder = new TextEncoder()
  const chunks = isTitleRequest(body)
    ? [{ content: "Perf title" }]
    : needsToolTurn(args.scenario) && !hasToolResult(body)
      ? toolScenarioDeltas(args.scenario, workspace)
      : scenarioDeltas(args)
  const finishReason =
    needsToolTurn(args.scenario) && !isTitleRequest(body) && !hasToolResult(body)
      ? "tool_calls"
      : "stop"

  return new ReadableStream({
    async start(controller) {
      const write = async (line: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`))
        if (args.delayMs > 0) await Bun.sleep(args.delayMs)
      }

      const lines = mode === "responses" ? responseLines(chunks, finishReason, responseModel(body)) : chatLines(chunks, finishReason)
      for (const line of lines) {
        await write(line)
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      onComplete()
      controller.close()
    },
  })
}

function requestMode(pathname: string) {
  if (pathname.endsWith("/chat/completions")) return "chat" as const
  if (pathname.endsWith("/responses")) return "responses" as const
  return undefined
}

function responseModel(body: Record<string, unknown> | undefined) {
  return typeof body?.model === "string" ? body.model : "test-model"
}

function chatLines(chunks: Array<Record<string, unknown>>, finishReason: string) {
  return [chunk({ role: "assistant" }), ...chunks.map((delta) => chunk(delta)), finishChunk(finishReason)]
}

function responseLines(chunks: Array<Record<string, unknown>>, finishReason: string, model: string) {
  const lines: unknown[] = [
    {
      type: "response.created",
      sequence_number: 1,
      response: {
        id: "resp_perf",
        created_at: Math.floor(Date.now() / 1000),
        model,
        service_tier: null,
      },
    },
  ]
  let sequence = 1
  let messageStarted = false
  let messageID = "msg_perf"
  let call:
    | {
        id: string
        item: string
        name: string
        arguments: string
      }
    | undefined

  for (const delta of chunks) {
    if (typeof delta.content === "string") {
      if (!messageStarted) {
        messageStarted = true
        sequence += 1
        lines.push({
          type: "response.output_item.added",
          sequence_number: sequence,
          output_index: 0,
          item: { type: "message", id: messageID },
        })
      }
      sequence += 1
      lines.push({
        type: "response.output_text.delta",
        sequence_number: sequence,
        item_id: messageID,
        delta: delta.content,
        logprobs: null,
      })
    }

    if (!Array.isArray(delta.tool_calls)) {
      continue
    }

    for (const tool of delta.tool_calls) {
      if (!tool || typeof tool !== "object") {
        continue
      }

      const toolCall = tool as {
        id?: string
        function?: {
          name?: string
          arguments?: string
        }
      }

      if (toolCall.id && toolCall.function?.name) {
        call = {
          id: toolCall.id,
          item: "fc_perf",
          name: toolCall.function.name,
          arguments: "",
        }
        sequence += 1
        lines.push({
          type: "response.output_item.added",
          sequence_number: sequence,
          output_index: 0,
          item: {
            type: "function_call",
            id: call.item,
            call_id: call.id,
            name: call.name,
            arguments: "",
            status: "in_progress",
          },
        })
      }

      if (!call || !toolCall.function?.arguments) {
        continue
      }

      call.arguments += toolCall.function.arguments
      sequence += 1
      lines.push({
        type: "response.function_call_arguments.delta",
        sequence_number: sequence,
        output_index: 0,
        item_id: call.item,
        delta: toolCall.function.arguments,
      })
    }
  }

  if (messageStarted) {
    sequence += 1
    lines.push({
      type: "response.output_item.done",
      sequence_number: sequence,
      output_index: 0,
      item: { type: "message", id: messageID },
    })
  }

  if (call && finishReason === "tool_calls") {
    sequence += 1
    lines.push({
      type: "response.function_call_arguments.done",
      sequence_number: sequence,
      output_index: 0,
      item_id: call.item,
      arguments: call.arguments,
    })
    sequence += 1
    lines.push({
      type: "response.output_item.done",
      sequence_number: sequence,
      output_index: 0,
      item: {
        type: "function_call",
        id: call.item,
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
        status: "completed",
      },
    })
  }

  sequence += 1
  lines.push({
    type: "response.completed",
    sequence_number: sequence,
    response: {
      incomplete_details: null,
      service_tier: null,
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: null },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: null },
      },
    },
  })

  return lines
}

function toolFile(workspace: string) {
  return path.join(workspace, "src/index.ts")
}

function toolScenarioDeltas(scenario: Scenario, workspace: string) {
  if (scenario === "task-ts") {
    return toolCallDeltas("task", {
      description: "Perf subagent task",
      prompt: `Read and summarize ${toolFile(workspace)} in 3 bullets.`,
      subagent_type: "explore",
      command: "perf task scenario",
    })
  }

  if (scenario === "lsp-ts") {
    return toolCallDeltas("lsp", {
      operation: "documentSymbol",
      filePath: toolFile(workspace),
      line: 1,
      character: 1,
    })
  }

  return toolCallDeltas("read", { filePath: toolFile(workspace), limit: 80 })
}

function toolCallDeltas(name: string, input: unknown) {
  const args = JSON.stringify(input)
  return [
    {
      tool_calls: [
        {
          index: 0,
          id: "call_perf_read",
          type: "function",
          function: {
            name,
            arguments: "",
          },
        },
      ],
    },
    {
      tool_calls: [
        {
          index: 0,
          function: {
            arguments: args,
          },
        },
      ],
    },
  ]
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

  if (needsToolTurn(scenario)) {
    return "tool complete "
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

function isolatedEnv(args: Args, home: string, llmUrl: string, perf?: { artifactDir: string; index: number }) {
  const config = testProviderConfig(llmUrl)
  config.lsp = args.enableLsp

  const env = {
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
    OPENCODE_DISABLE_LSP_DOWNLOAD: args.disableLspDownload ? "1" : "0",
    OPENCODE_EXPERIMENTAL_LSP_TOOL: args.scenario === "lsp-ts" ? "1" : "0",
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_RUN_TUI_MD_FINALIZE_MODE: args.mdFinalizeMode,
  }

  if (!perf) {
    return env
  }

  return {
    ...env,
    OPENCODE_PERF_INSTANCE: String(perf.index + 1),
    ...(args.mode === "tui"
      ? args.perfTiming
        ? {
          OPENCODE_PERF_TIMING: "1",
          OPENCODE_PERF_TIMING_FILE: path.join(perf.artifactDir, "timings.jsonl"),
        }
        : {}
      : {}),
    ...(args.memoryCheckpoints && perf.index < args.memoryInstances
        ? {
            OPENCODE_PERF_MEMORY_DIR: path.join(perf.artifactDir, "memory"),
            OPENCODE_PERF_MEMORY_CHECKPOINTS: args.memoryCheckpointNames,
          }
      : {}),
    ...(args.heapSnapshots && perf.index < args.heapInstances
      ? {
          OPENCODE_PERF_MEMORY_DIR: path.join(perf.artifactDir, "memory"),
          OPENCODE_PERF_MEMORY_CHECKPOINTS: args.memoryCheckpointNames,
          OPENCODE_PERF_INSTANCE: String(perf.index + 1),
          OPENCODE_PERF_HEAP_DIR: path.join(perf.artifactDir, "heaps"),
          OPENCODE_PERF_HEAP_INSTANCE: String(perf.index + 1),
          OPENCODE_PERF_HEAP_CHECKPOINTS: args.heapCheckpoints,
        }
        : {}),
  }
}

function needsRepoWorkspace(scenario: Scenario) {
  return scenario === "read-ts" || scenario === "lsp-ts" || scenario === "task-ts"
}

function needsToolTurn(scenario: Scenario) {
  return scenario === "read-ts" || scenario === "lsp-ts" || scenario === "task-ts"
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
  const proc = Bun.spawn(["ps", "-axo", "pid=,ppid=,pcpu=,rss=,command="], { stdout: "pipe", stderr: "ignore" })
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
  if (
    name.includes("typescript-language-server") ||
    name.includes("tsserver.js") ||
    name.includes("language-server") ||
    name.includes("oxlint") ||
    name.includes("oxc_language_server")
  )
    return "lsp"
  if (name.includes("npm") || name.includes("@npmcli/arborist")) return "npm"
  if (name.includes("opencode") || name.endsWith("/bun") || name === "bun") return "opencode"
  if (name.includes("/git ") || name.startsWith("git ") || name.endsWith("/git") || name === "git") return "git"
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
  exitCode: number | number[]
  llmRequests: number
  samples: ProcessSample[]
  timings: ReturnType<typeof parsePerfTimings>
}): Summary {
  const targetSamples = primarySamples(input.args.mode, input.samples)
  const treeCpu = totalsByElapsed(input.samples, (sample) => sample.cpu)
  const treeRss = totalsByElapsed(input.samples, (sample) => sample.rss_mb)
  const processKindCounts = processKindUniqueCounts(input.samples)
  const processKindPeakCpu = valuesByKind(input.samples, (sample) => sample.cpu, max)
  const processKindPeakRss = valuesByKind(input.samples, (sample) => sample.rss_mb, max)
  const processKindTreePeakCpu = treeValuesByKind(input.samples, (sample) => sample.cpu)
  const processKindTreePeakRss = treeValuesByKind(input.samples, (sample) => sample.rss_mb)

  return {
    scenario: input.args.scenario,
    mode: input.args.mode,
    runner: input.args.runner,
    md_finalize_mode: input.args.mdFinalizeMode,
    smol: input.args.smol,
    attach: input.args.attach,
    warm_home: input.args.warmHome,
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
    process_kind_counts: processKindCounts,
    process_kind_peak_cpu: processKindPeakCpu,
    process_kind_peak_rss_mb: processKindPeakRss,
    process_kind_tree_peak_cpu: processKindTreePeakCpu,
    process_kind_tree_peak_rss_mb: processKindTreePeakRss,
    llm_requests: input.llmRequests,
    sample_count: targetSamples.length,
    exit_code: input.exitCode,
    timing_instances: input.timings.timing_instances,
    boot_complete_ms: input.timings.boot_complete_ms,
    first_visible_ms: input.timings.first_visible_ms,
    last_visible_ms: input.timings.last_visible_ms,
    final_rich_done_ms: input.timings.final_rich_done_ms,
    finalization_tail_ms: input.timings.finalization_tail_ms,
  }
}

function parsePerfTimings(stderrText: string) {
  const events = stderrText
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      if (!line.startsWith('{"opencode_perf_timing":')) {
        return []
      }

      const parsed = JSON.parse(line) as Partial<PerfTimingEvent> & { opencode_perf_timing?: boolean }
      if (!parsed.opencode_perf_timing || typeof parsed.instance !== "string" || typeof parsed.name !== "string") {
        return []
      }

      if (typeof parsed.ms !== "number" || !Number.isFinite(parsed.ms)) {
        return []
      }

      return [{ instance: parsed.instance, name: parsed.name as PerfTimingName, ms: parsed.ms }]
    })

  const grouped = events.reduce<Record<string, PerfTimingEvent[]>>((result, event) => {
    result[event.instance] = [...(result[event.instance] ?? []), event]
    return result
  }, {})

  const instances = Object.values(grouped)
  return {
    timing_instances: instances.length,
    boot_complete_ms: medianDefined(instances.flatMap((events) => firstTiming(events, "boot_complete"))),
    first_visible_ms: medianDefined(instances.flatMap((events) => firstTiming(events, "first_visible"))),
    last_visible_ms: medianDefined(instances.flatMap((events) => lastTiming(events, "last_visible"))),
    final_rich_done_ms: medianDefined(instances.flatMap((events) => lastTiming(events, "final_rich_done"))),
    finalization_tail_ms: medianDefined(
      instances.flatMap((events) => {
        const last = lastTiming(events, "last_visible")[0]
        const final = lastTiming(events, "final_rich_done")[0]
        if (last === undefined || final === undefined) {
          return []
        }

        return [Math.max(0, final - last)]
      }),
    ),
  }
}

function firstTiming(events: PerfTimingEvent[], name: PerfTimingName) {
  const match = events.find((event) => event.name === name)
  return match ? [match.ms] : []
}

function lastTiming(events: PerfTimingEvent[], name: PerfTimingName) {
  const match = [...events].reverse().find((event) => event.name === name)
  return match ? [match.ms] : []
}

function emptyKindRecord() {
  return Object.fromEntries(processKinds.map((kind) => [kind, 0])) as Record<ProcessKind, number>
}

function processKindUniqueCounts(samples: ProcessSample[]) {
  return processKinds.reduce<Record<ProcessKind, number>>((result, kind) => {
    result[kind] = new Set(samples.filter((sample) => sample.kind === kind).map((sample) => sample.pid)).size
    return result
  }, emptyKindRecord())
}

function valuesByKind(samples: ProcessSample[], value: (sample: ProcessSample) => number, aggregate: (values: number[]) => number) {
  return processKinds.reduce<Record<ProcessKind, number>>((result, kind) => {
    result[kind] = aggregate(samples.filter((sample) => sample.kind === kind).map(value))
    return result
  }, emptyKindRecord())
}

function treeValuesByKind(samples: ProcessSample[], value: (sample: ProcessSample) => number) {
  return processKinds.reduce<Record<ProcessKind, number>>((result, kind) => {
    result[kind] = max(totalsByElapsed(samples.filter((sample) => sample.kind === kind), value))
    return result
  }, emptyKindRecord())
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
      `runner=${summary.runner}`,
      `md_finalize=${summary.md_finalize_mode}`,
      `smol=${summary.smol}`,
      `attach=${summary.attach}`,
      `warm_home=${summary.warm_home}`,
      `target=${summary.target}`,
      `duration=${duration}s`,
      `peak_cpu=${summary.peak_cpu}%`,
      `avg_cpu=${summary.avg_cpu}%`,
      `peak_rss=${summary.peak_rss_mb}MB`,
      `avg_rss=${summary.avg_rss_mb}MB`,
      `tree_peak_cpu=${summary.tree_peak_cpu}%`,
      `tree_peak_rss=${summary.tree_peak_rss_mb}MB`,
      ...(summary.boot_complete_ms === undefined ? [] : [`boot_complete=${summary.boot_complete_ms}ms`]),
      ...(summary.first_visible_ms === undefined ? [] : [`first_visible=${summary.first_visible_ms}ms`]),
      ...(summary.last_visible_ms === undefined ? [] : [`last_visible=${summary.last_visible_ms}ms`]),
      ...(summary.final_rich_done_ms === undefined ? [] : [`final_rich_done=${summary.final_rich_done_ms}ms`]),
      ...(summary.finalization_tail_ms === undefined ? [] : [`finalize_tail=${summary.finalization_tail_ms}ms`]),
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
      `runner=${first.runner}`,
      `md_finalize=${first.md_finalize_mode}`,
      `smol=${first.smol}`,
      `attach=${first.attach}`,
      `warm_home=${first.warm_home}`,
      `runs=${summaries.length}`,
      `median_peak_cpu=${median(summaries.map((summary) => summary.peak_cpu))}%`,
      `median_peak_rss=${median(summaries.map((summary) => summary.peak_rss_mb))}MB`,
      `median_tree_peak_cpu=${median(summaries.map((summary) => summary.tree_peak_cpu))}%`,
      `median_tree_peak_rss=${median(summaries.map((summary) => summary.tree_peak_rss_mb))}MB`,
      `median_duration=${median(summaries.map((summary) => summary.duration_ms))}ms`,
      ...(definedValues(summaries.map((summary) => summary.boot_complete_ms)).length === 0
        ? []
        : [`median_boot_complete=${medianDefined(summaries.map((summary) => summary.boot_complete_ms))}ms`]),
      ...(definedValues(summaries.map((summary) => summary.first_visible_ms)).length === 0
        ? []
        : [`median_first_visible=${medianDefined(summaries.map((summary) => summary.first_visible_ms))}ms`]),
      ...(definedValues(summaries.map((summary) => summary.last_visible_ms)).length === 0
        ? []
        : [`median_last_visible=${medianDefined(summaries.map((summary) => summary.last_visible_ms))}ms`]),
      ...(definedValues(summaries.map((summary) => summary.final_rich_done_ms)).length === 0
        ? []
        : [`median_final_rich_done=${medianDefined(summaries.map((summary) => summary.final_rich_done_ms))}ms`]),
      ...(definedValues(summaries.map((summary) => summary.finalization_tail_ms)).length === 0
        ? []
        : [`median_finalize_tail=${medianDefined(summaries.map((summary) => summary.finalization_tail_ms))}ms`]),
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
  const instances = positiveInt(values.get("instances") ?? "1", "instances")
  return {
    mode,
    scenario: enumValue(values.get("scenario") ?? "markdown", ["text", "markdown", "code", "read-ts", "lsp-ts", "task-ts"]),
    runner: enumValue(values.get("runner") ?? "source", ["source", "binary"]),
    mdFinalizeMode: values.get("md-finalize-mode") ?? "immediate",
    perfTiming: booleanValue(values.get("perf-timing") ?? "false", "perf-timing"),
    smol: booleanValue(values.get("smol") ?? "false", "smol"),
    cpuProfile: booleanValue(values.get("cpu-profile") ?? "false", "cpu-profile"),
    workspace: values.get("workspace"),
    title: values.get("title"),
    attach: booleanValue(values.get("attach") ?? "false", "attach"),
    warmHome: booleanValue(values.get("warm-home") ?? "true", "warm-home"),
    runs: positiveInt(values.get("runs") ?? "1", "runs"),
    chunks: positiveInt(values.get("chunks") ?? "250", "chunks"),
    chunkSize: positiveInt(values.get("chunk-size") ?? "12", "chunk-size"),
    delayMs: nonNegativeInt(values.get("delay-ms") ?? (mode === "tui" ? "1" : "0"), "delay-ms"),
    timeoutMs: positiveInt(values.get("timeout-ms") ?? "20000", "timeout-ms"),
    sampleMs: positiveInt(values.get("sample-ms") ?? "100", "sample-ms"),
    settleMs: positiveInt(values.get("settle-ms") ?? "500", "settle-ms"),
    instances,
    enableLsp: booleanValue(values.get("enable-lsp") ?? "false", "enable-lsp"),
    disableLspDownload: booleanValue(values.get("disable-lsp-download") ?? "false", "disable-lsp-download"),
    memoryCheckpoints: booleanValue(
      values.get("memory-checkpoints") ?? values.get("heap-snapshots") ?? "false",
      "memory-checkpoints",
    ),
    memoryInstances: positiveInt(values.get("memory-instances") ?? String(instances), "memory-instances"),
    memoryCheckpointNames:
      values.get("memory-checkpoint-names") ?? "boot,before-turn,stream-ready,after-turn,idle,before-close",
    heapSnapshots: booleanValue(values.get("heap-snapshots") ?? "false", "heap-snapshots"),
    heapInstances: positiveInt(values.get("heap-instances") ?? "1", "heap-instances"),
    heapCheckpoints: values.get("heap-checkpoints") ?? "boot,before-turn,stream-ready,after-turn,idle,before-close",
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

function booleanValue(value: string, name: string) {
  if (value === "true") return true
  if (value === "false") return false
  throw new Error(`--${name} must be true or false`)
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

function definedValues(values: Array<number | undefined>) {
  return values.filter((value): value is number => value !== undefined)
}

function medianDefined(values: Array<number | undefined>) {
  const filtered = definedValues(values)
  if (filtered.length === 0) {
    return undefined
  }

  return median(filtered)
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
}
