import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"

const enabled = process.env.OPENCODE_PERF_TIMING === "1"
const instance = process.env.OPENCODE_PERF_INSTANCE ?? String(process.pid)
const timingFile = process.env.OPENCODE_PERF_TIMING_FILE

export function markPerfTiming(name: string, extra: Record<string, string | number | boolean | undefined> = {}) {
  if (!enabled) {
    return
  }

  const line = JSON.stringify({
    opencode_perf_timing: true,
    instance,
    name,
    ms: Math.max(0, Math.round(performance.now())),
    ...extra,
  })

  if (timingFile) {
    mkdirSync(path.dirname(timingFile), { recursive: true })
    appendFileSync(timingFile, `${line}\n`)
    return
  }

  process.stderr.write(`${line}\n`)
}
