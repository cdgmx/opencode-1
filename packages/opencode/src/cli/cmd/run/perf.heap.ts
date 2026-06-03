import path from "node:path"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { writeHeapSnapshot } from "node:v8"

const counters = new Map<string, number>()
const memoryCounters = new Map<string, number>()

export function writePerfHeapSnapshot(checkpoint: string): void {
  const memory = process.memoryUsage()
  writePerfMemory(checkpoint, memory)

  const dir = process.env.OPENCODE_PERF_HEAP_DIR
  if (!dir) return

  const selected = new Set((process.env.OPENCODE_PERF_HEAP_CHECKPOINTS ?? "").split(",").filter(Boolean))
  if (selected.size > 0 && !selected.has(checkpoint)) return

  mkdirSync(dir, { recursive: true })
  Bun.gc(true)
  const memoryAfterGc = process.memoryUsage()
  const count = (counters.get(checkpoint) ?? 0) + 1
  counters.set(checkpoint, count)

  const name = [
    perfInstance(),
    checkpoint.replace(/[^a-z0-9_-]/gi, "_"),
    String(count).padStart(2, "0"),
  ].join("-")
  const file = path.join(dir, `${name}.heapsnapshot`)
  const snapshot = writeHeapSnapshot(file)
  const memoryAfterSnapshot = process.memoryUsage()

  writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify(
      {
        checkpoint,
        file: snapshot,
        pid: process.pid,
        memory,
        memory_after_gc: memoryAfterGc,
        memory_after_snapshot: memoryAfterSnapshot,
        created_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
}

function writePerfMemory(checkpoint: string, memory: NodeJS.MemoryUsage): void {
  const dir = process.env.OPENCODE_PERF_MEMORY_DIR
  if (!dir) return

  const selected = new Set((process.env.OPENCODE_PERF_MEMORY_CHECKPOINTS ?? "").split(",").filter(Boolean))
  if (selected.size > 0 && !selected.has(checkpoint)) return

  mkdirSync(dir, { recursive: true })
  const count = (memoryCounters.get(checkpoint) ?? 0) + 1
  memoryCounters.set(checkpoint, count)
  appendFileSync(
    path.join(dir, `${perfInstance()}.jsonl`),
    JSON.stringify({
      checkpoint,
      count,
      pid: process.pid,
      memory,
      created_at: new Date().toISOString(),
    }) + "\n",
  )
}

function perfInstance() {
  return process.env.OPENCODE_PERF_INSTANCE ?? process.env.OPENCODE_PERF_HEAP_INSTANCE ?? String(process.pid)
}
