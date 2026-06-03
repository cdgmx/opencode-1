import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import * as Log from "@opencode-ai/core/util/log"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { NamedError } from "@opencode-ai/core/util/error"
import { FormatError } from "./cli/error"
import { Filesystem } from "@/util/filesystem"
import { EOL } from "os"
import { JsonMigration } from "@/storage/json-migration"
import { Database } from "@opencode-ai/core/database/database"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { ensureProcessMetadata } from "@opencode-ai/core/util/opencode-process"
import { isRecord } from "@/util/record"
import type { CommandModule } from "yargs"

const processMetadata = ensureProcessMetadata("main")
type LoadedCommand = CommandModule<unknown, never>

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

const args = hideBin(process.argv)

function loaded(command: unknown): LoadedCommand {
  return command as LoadedCommand
}

async function commands(argv: string[]): Promise<LoadedCommand[]> {
  if (primaryCommand(argv) === "run") {
    return [await import("./cli/cmd/run").then((mod) => loaded(mod.RunCommand))]
  }

  return Promise.all([
    import("./cli/cmd/acp").then((mod) => loaded(mod.AcpCommand)),
    import("./cli/cmd/mcp").then((mod) => loaded(mod.McpCommand)),
    import("./cli/cmd/tui/thread").then((mod) => loaded(mod.TuiThreadCommand)),
    import("./cli/cmd/tui/attach").then((mod) => loaded(mod.AttachCommand)),
    import("./cli/cmd/run").then((mod) => loaded(mod.RunCommand)),
    import("./cli/cmd/generate").then((mod) => loaded(mod.GenerateCommand)),
    import("./cli/cmd/debug").then((mod) => loaded(mod.DebugCommand)),
    import("./cli/cmd/account").then((mod) => loaded(mod.ConsoleCommand)),
    import("./cli/cmd/providers").then((mod) => loaded(mod.ProvidersCommand)),
    import("./cli/cmd/agent").then((mod) => loaded(mod.AgentCommand)),
    import("./cli/cmd/upgrade").then((mod) => loaded(mod.UpgradeCommand)),
    import("./cli/cmd/uninstall").then((mod) => loaded(mod.UninstallCommand)),
    import("./cli/cmd/serve").then((mod) => loaded(mod.ServeCommand)),
    import("./cli/cmd/web").then((mod) => loaded(mod.WebCommand)),
    import("./cli/cmd/models").then((mod) => loaded(mod.ModelsCommand)),
    import("./cli/cmd/stats").then((mod) => loaded(mod.StatsCommand)),
    import("./cli/cmd/export").then((mod) => loaded(mod.ExportCommand)),
    import("./cli/cmd/import").then((mod) => loaded(mod.ImportCommand)),
    import("./cli/cmd/github").then((mod) => loaded(mod.GithubCommand)),
    import("./cli/cmd/pr").then((mod) => loaded(mod.PrCommand)),
    import("./cli/cmd/session").then((mod) => loaded(mod.SessionCommand)),
    import("./cli/cmd/plug").then((mod) => loaded(mod.PluginCommand)),
    import("./cli/cmd/db").then((mod) => loaded(mod.DbCommand)),
  ])
}

function primaryCommand(argv: string[]) {
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (!value) continue
    if (value === "--") return undefined
    if (value === "--log-level") {
      index++
      continue
    }
    if (value.startsWith("--log-level=")) continue
    if (value.startsWith("-")) continue
    return value
  }
  return undefined
}

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)

    Log.Default.info("opencode", {
      version: InstallationVersion,
      args: process.argv.slice(2),
      process_role: processMetadata.processRole,
      run_id: processMetadata.runID,
    })

    const marker = Database.path()
    if (!(await Filesystem.exists(marker))) {
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      if (tty) process.stderr.write("\x1b[?25l")
      const sqlite = new (await import("bun:sqlite")).Database(marker)
      try {
        await JsonMigration.run(drizzle({ client: sqlite }), {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        sqlite.close()
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

for (const command of await commands(args)) {
  cli.command(command)
}

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof NamedError) {
    const obj = e.toObject()
    if (isRecord(obj.data)) {
      for (const [key, value] of Object.entries(obj.data)) {
        if (key === "name" || key === "stack" || key === "cause") continue
        data[key] = value
      }
    }
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
