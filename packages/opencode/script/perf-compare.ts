import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

type SummaryRecord = Record<string, unknown> & { artifact: string }

const targets = Bun.argv.slice(2)
if (targets.length === 0) {
  console.error("Usage: bun run perf:compare <artifact-dir> [artifact-dir ...]")
  process.exit(1)
}

const summaries = (await Promise.all(targets.map(readSummaries))).flat()
if (summaries.length === 0) {
  console.error("No summary.json files found")
  process.exit(1)
}

console.table(
  summaries.map((summary) => ({
    artifact: summary.artifact,
    mode: summary.mode,
    scenario: summary.scenario,
    duration_ms: summary.duration_ms,
    max_cpu: summary.max_cpu,
    avg_cpu: summary.avg_cpu,
    max_rss_mb: summary.max_rss_mb,
    child_max_cpu: summary.child_max_cpu,
    child_max_rss_mb: summary.child_max_rss_mb,
    chunks_per_second: summary.chunks_per_second,
    exit_code: Array.isArray(summary.exit_code) ? summary.exit_code.join(",") : summary.exit_code,
  })),
)

async function readSummaries(target: string): Promise<SummaryRecord[]> {
  const entries = await readdir(target, { withFileTypes: true })
  const direct = entries.find((entry) => entry.isFile() && entry.name === "summary.json")
  if (direct) return [await readSummary(path.join(target, "summary.json"))]
  return (await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readSummary(path.join(target, entry.name, "summary.json")).catch(() => undefined)),
  )).filter((summary): summary is SummaryRecord => summary !== undefined)
}

async function readSummary(file: string): Promise<SummaryRecord> {
  return { artifact: path.dirname(file), ...(JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>) }
}
