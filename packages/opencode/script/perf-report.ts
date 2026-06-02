import { readdir } from "node:fs/promises"
import path from "node:path"

const opencodeRoot = path.resolve(import.meta.dir, "..")
const repoRoot = path.resolve(opencodeRoot, "../..")
const artifactRoot = path.join(opencodeRoot, ".artifacts/perf")
const args = parseArgs(Bun.argv.slice(2))
const summaries = (await Promise.all(args.targets.map(readSummaries))).flat().sort((left, right) => left.artifact.localeCompare(right.artifact))

if (summaries.length === 0) {
  console.error("No summary.json files found")
  process.exit(1)
}

await Bun.write(args.out, renderReport(summaries))
console.log(`Wrote ${args.out}`)

function parseArgs(values: string[]) {
  const outIndex = values.indexOf("--out")
  const out = outIndex === -1 ? path.join(repoRoot, "perf/opencode-runtime-performance-report.html") : path.resolve(values[outIndex + 1] ?? "")
  if (outIndex !== -1 && !values[outIndex + 1]) {
    console.error("Usage: bun run perf:report [artifact-dir ...] [--out <html-file>]")
    process.exit(1)
  }
  const targets = values
    .filter((value, index) => outIndex === -1 || (index !== outIndex && index !== outIndex + 1))
    .map((value) => path.resolve(value))
  return {
    out,
    targets: targets.length === 0 ? [artifactRoot] : targets,
  }
}

async function readSummaries(target: string) {
  const entries = await readdir(target, { withFileTypes: true })
  const direct = entries.find((entry) => entry.isFile() && entry.name === "summary.json")
  if (direct) return [await readSummary(path.join(target, "summary.json"))]
  return (await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readSummary(path.join(target, entry.name, "summary.json")).catch(() => undefined)),
  )).filter((summary): summary is Awaited<ReturnType<typeof readSummary>> => summary !== undefined)
}

async function readSummary(file: string) {
  const summary = await Bun.file(file).json() as Record<string, unknown>
  return { artifact: path.dirname(file), name: path.basename(path.dirname(file)), ...summary }
}

function renderReport(summaries: Array<Awaited<ReturnType<typeof readSummary>>>) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenCode Perf Report</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #10100d;
      --panel: #181812;
      --ink: #f4edda;
      --muted: #9c947e;
      --grid: rgba(244, 237, 218, 0.12);
      --cpu: #ff4d2e;
      --rss: #e8c64a;
      --proc: #74d4b4;
      --fail: #ff6b7f;
      --ok: #8fd46f;
      --warn: #ffb454;
      --line: #333022;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px) 0 0 / 48px 48px,
        linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px) 0 0 / 48px 48px,
        radial-gradient(circle at 18% 12%, rgba(255, 77, 46, 0.18), transparent 32rem),
        radial-gradient(circle at 80% 3%, rgba(232, 198, 74, 0.12), transparent 30rem),
        var(--bg);
      color: var(--ink);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }

    main { width: min(1480px, calc(100vw - 32px)); margin: 0 auto; padding: 38px 0 52px; }
    header { display: grid; grid-template-columns: 1.25fr 0.75fr; gap: 22px; align-items: end; margin-bottom: 24px; }
    h1 { margin: 0; font-size: clamp(34px, 6vw, 82px); line-height: 0.88; letter-spacing: -0.08em; text-transform: uppercase; }
    .lede { color: var(--muted); line-height: 1.55; max-width: 64ch; margin: 14px 0 0; }
    .stamp { border: 1px solid var(--line); background: rgba(24,24,18,0.82); padding: 18px; box-shadow: 8px 8px 0 rgba(0,0,0,0.34); }
    .stamp strong { display: block; font-size: 28px; color: var(--rss); }
    .stamp span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.12em; }
    .controls { display: flex; gap: 10px; flex-wrap: wrap; margin: 24px 0; }
    button { appearance: none; border: 1px solid var(--line); background: #171710; color: var(--ink); padding: 10px 13px; font: inherit; cursor: pointer; }
    button.active { background: var(--ink); color: #14140f; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 14px; }
    .card { border: 1px solid var(--line); background: rgba(24,24,18,0.9); padding: 16px; min-height: 116px; box-shadow: 5px 5px 0 rgba(0,0,0,0.25); }
    .label { color: var(--muted); font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; }
    .value { font-size: clamp(24px, 3vw, 44px); margin-top: 10px; letter-spacing: -0.05em; }
    .note { color: var(--muted); font-size: 12px; margin-top: 8px; line-height: 1.4; }
    .explain { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 14px; margin-bottom: 14px; }
    .verdict, .guide { border: 1px solid var(--line); background: rgba(24,24,18,0.94); padding: 18px; box-shadow: 5px 5px 0 rgba(0,0,0,0.25); }
    .verdict h2, .guide h2 { margin: 0 0 12px; font-size: 20px; letter-spacing: -0.05em; text-transform: uppercase; }
    .verdict ul, .guide ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; }
    .verdict li, .guide li { line-height: 1.45; }
    .guide strong { color: var(--rss); }
    .pill { display: inline-block; padding: 3px 8px; margin-right: 8px; border: 1px solid currentColor; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
    .pill.bad { color: var(--fail); }
    .pill.warn { color: var(--warn); }
    .pill.good { color: var(--ok); }
    .caption { color: var(--muted); line-height: 1.5; margin: 0 0 14px; font-size: 13px; }
    .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .chart { border: 1px solid var(--line); background: rgba(24,24,18,0.92); padding: 18px; min-height: 360px; }
    .chart h2, .table-card h2 { margin: 0 0 12px; font-size: 18px; text-transform: uppercase; letter-spacing: -0.04em; }
    svg { width: 100%; height: 300px; overflow: visible; }
    .axis { stroke: var(--grid); stroke-width: 1; }
    .tick { fill: var(--muted); font-size: 10px; }
    .bar-label { fill: var(--ink); font-size: 11px; }
    .table-card { border: 1px solid var(--line); background: rgba(24,24,18,0.94); padding: 18px; margin-top: 14px; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; min-width: 1080px; }
    th, td { border-bottom: 1px solid var(--line); padding: 11px 10px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; }
    td { font-size: 12px; }
    code { color: var(--rss); }
    .bad { color: var(--fail); }
    .good { color: var(--ok); }
    .legend { display: flex; gap: 16px; flex-wrap: wrap; color: var(--muted); font-size: 12px; margin-bottom: 10px; }
    .swatch { display: inline-block; width: 10px; height: 10px; margin-right: 6px; }
    @media (max-width: 900px) {
      header, .charts, .explain { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <section>
        <h1>Runtime Pressure Board</h1>
        <p class="lede">Plain-English comparison of OpenCode stress runs. In this report, taller bars are bad: more CPU, more memory, more child processes, or more failures.</p>
      </section>
      <aside class="stamp">
        <span>Runs Loaded</span>
        <strong id="run-count">0</strong>
        <p class="note" id="generated-at"></p>
      </aside>
    </header>
    <section class="controls" id="filters"></section>
    <section class="explain">
      <article class="verdict">
        <h2>What This Says</h2>
        <ul id="verdict-list"></ul>
      </article>
      <article class="guide">
        <h2>How To Read It</h2>
        <ul>
          <li><strong>Higher CPU is worse.</strong> It means OpenCode or git is burning more processor time and can make the machine feel laggy.</li>
          <li><strong>Higher memory/RSS is worse.</strong> It means processes keep more RAM; swap is the danger signal for system-wide lag.</li>
          <li><strong>More child processes is worse.</strong> It means each OpenCode instance fans out into extra git/shell/watcher/LSP work.</li>
          <li><strong>Exit code 143 is okay here.</strong> The harness stops interactive runs on purpose. Exit code 1 means real failure.</li>
        </ul>
      </article>
    </section>
    <section class="grid" id="cards"></section>
    <section class="charts">
      <article class="chart">
        <h2>CPU Peaks</h2>
        <p class="caption">Taller bars are worse. This compares the worst sampled CPU spike from OpenCode and git child processes during each run.</p>
        <div class="legend"><span><i class="swatch" style="background:var(--cpu)"></i>OpenCode CPU</span><span><i class="swatch" style="background:var(--proc)"></i>Git CPU</span></div>
        <svg id="cpu-chart" role="img" aria-label="CPU peak comparison"></svg>
      </article>
      <article class="chart">
        <h2>RSS and Process Fan-Out</h2>
        <p class="caption">Taller bars are worse. RSS is memory used by one OpenCode child; unique children shows how much process fan-out the run created.</p>
        <div class="legend"><span><i class="swatch" style="background:var(--rss)"></i>OpenCode RSS MB</span><span><i class="swatch" style="background:var(--proc)"></i>Unique children</span></div>
        <svg id="rss-chart" role="img" aria-label="RSS and process comparison"></svg>
      </article>
    </section>
    <section class="table-card">
      <h2>Run Ledger</h2>
      <p class="caption">Raw numbers for debugging. Use this only after reading the verdict and chart captions.</p>
      <table>
        <thead><tr><th>Run</th><th>Mode</th><th>Scenario</th><th>Duration</th><th>Exit</th><th>OpenCode CPU high=worse</th><th>Git CPU high=worse</th><th>OpenCode RSS high=worse</th><th>Total RSS high=worse</th><th>Host Mem high=worse</th><th>Swap high=worse</th><th>Children high=worse</th><th>Artifact</th></tr></thead>
        <tbody id="run-table"></tbody>
      </table>
    </section>
  </main>
  <script>
    const runs = ${JSON.stringify(summaries)};
    let filter = "all";
    const number = (value) => typeof value === "number" ? value : 0;
    const kindValue = (run, field, kind) => run[field] && typeof run[field] === "object" ? number(run[field][kind]) : 0;
    const exitText = (run) => Array.isArray(run.exit_code) ? run.exit_code.join(",") : String(run.exit_code ?? "");
    const failed = (run) => Array.isArray(run.exit_code) ? run.exit_code.some((code) => code !== 0 && code !== 143) : run.exit_code !== 0 && run.exit_code !== 143;
    const filtered = () => runs.filter((run) => filter === "all" || run.mode === filter || (filter === "failed" && failed(run)));
    document.getElementById("generated-at").textContent = "Generated " + new Date().toLocaleString();

    function render() {
      const current = filtered();
      document.getElementById("run-count").textContent = current.length;
      renderFilters();
      renderVerdict(current);
      renderCards(current);
      renderBars("cpu-chart", current, [
        { label: "OpenCode", color: "var(--cpu)", value: (run) => kindValue(run, "child_kind_max_cpu", "opencode") },
        { label: "Git", color: "var(--proc)", value: (run) => kindValue(run, "child_kind_max_cpu", "git") },
      ], "%");
      renderBars("rss-chart", current, [
        { label: "RSS", color: "var(--rss)", value: (run) => kindValue(run, "child_kind_max_rss_mb", "opencode") },
        { label: "Children", color: "var(--proc)", value: (run) => number(run.child_process_count) },
      ], "");
      renderTable(current);
    }

    function renderFilters() {
      const modes = ["all", ...Array.from(new Set(runs.map((run) => run.mode).filter(Boolean))), "failed"];
      document.getElementById("filters").innerHTML = modes.map((mode) => '<button class="' + (filter === mode ? 'active' : '') + '" data-filter="' + mode + '">' + mode + '</button>').join("");
      document.querySelectorAll("button[data-filter]").forEach((button) => button.addEventListener("click", () => { filter = button.dataset.filter; render(); }));
    }

    function renderCards(current) {
      const peakCpu = Math.max(0, ...current.map((run) => kindValue(run, "child_kind_max_cpu", "opencode")));
      const peakRss = Math.max(0, ...current.map((run) => kindValue(run, "child_kind_max_rss_mb", "opencode")));
      const trackedRss = Math.max(0, ...current.map((run) => number(run.tracked_max_total_rss_mb)));
      const hostMemory = Math.max(0, ...current.map((run) => number(run.host_max_memory_used_percent)));
      const hostSwap = Math.max(0, ...current.map((run) => number(run.host_max_swap_used_mb)));
      const peakChildren = Math.max(0, ...current.map((run) => number(run.child_process_count)));
      const failures = current.filter(failed).length;
      document.getElementById("cards").innerHTML = [
        card("CPU Pressure", peakCpu + "%", severity(peakCpu, 150, 100) + " Higher is worse. Above 100% means more than one core was busy."),
        card("Memory Pressure", peakRss + "MB", severity(peakRss, 1000, 500) + " Higher is worse. This is one OpenCode child, not total system RAM."),
        card("Tracked Total RAM", trackedRss + "MB", trackedRss === 0 ? "Not available in these older runs." : severity(trackedRss, 3000, 1500) + " Higher is worse. Parent + child RSS in one sample."),
        card("Host Memory", hostMemory + "%", hostMemory === 0 ? "Not available in these older runs." : severity(hostMemory, 90, 75) + " Higher is worse. Whole-machine memory pressure."),
        card("Swap", hostSwap + "MB", hostSwap === 0 ? "No swap seen or not sampled. Swap above 0 can explain system lag." : severity(hostSwap, 1024, 1) + " Higher is worse. Swap is a strong lag signal."),
        card("Process Fan-Out", peakChildren, severity(peakChildren, 80, 30) + " Higher is worse. More children means more git/shell/LSP work."),
        card("Failures", failures, failures > 0 ? "Bad. One or more runs crashed instead of cleanly finishing." : "Good. No run crashed."),
      ].join("");
    }

    function renderVerdict(current) {
      const failures = current.filter(failed).length;
      const peakCpu = Math.max(0, ...current.map((run) => kindValue(run, "child_kind_max_cpu", "opencode")));
      const peakGitCpu = Math.max(0, ...current.map((run) => kindValue(run, "child_kind_max_cpu", "git")));
      const peakRss = Math.max(0, ...current.map((run) => kindValue(run, "child_kind_max_rss_mb", "opencode")));
      const peakChildren = Math.max(0, ...current.map((run) => number(run.child_process_count)));
      const hostMemory = Math.max(0, ...current.map((run) => number(run.host_max_memory_used_percent)));
      const swap = Math.max(0, ...current.map((run) => number(run.host_max_swap_used_mb)));
      document.getElementById("verdict-list").innerHTML = [
        verdict(failures > 0 ? "bad" : "good", failures > 0 ? "Some runs failed. This proves instability, not just slowness." : "No crash in the selected runs."),
        verdict(peakCpu > 100 || peakGitCpu > 100 ? "warn" : "good", peakCpu > 100 || peakGitCpu > 100 ? "CPU pressure is visible. OpenCode or git crossed one full CPU core during the test." : "CPU pressure was low in these selected runs."),
        verdict(peakChildren > 30 ? "warn" : "good", peakChildren > 30 ? "Process fan-out is high. Multiple OpenCode instances create many child processes." : "Process fan-out is modest in these selected runs."),
        verdict(peakRss >= 1000 ? "warn" : "good", peakRss >= 1000 ? "Memory is concerning, but this alone does not prove memory caused lag." : "Memory does not look like the main proven cause yet."),
        verdict(hostMemory === 0 && swap === 0 ? "warn" : swap > 0 || hostMemory > 90 ? "bad" : "good", hostMemory === 0 && swap === 0 ? "Whole-machine memory/swap was not captured for these older runs." : swap > 0 || hostMemory > 90 ? "Whole-machine memory pressure is visible. This can explain real OS lag." : "Whole-machine memory pressure looks okay."),
      ].join("");
    }

    function verdict(kind, text) {
      return '<li><span class="pill ' + kind + '">' + kind + '</span>' + text + '</li>';
    }

    function severity(value, bad, warn) {
      if (value >= bad) return "Bad.";
      if (value >= warn) return "Watch.";
      return "Good.";
    }

    function card(label, value, note) {
      return '<article class="card"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="note">' + note + '</div></article>';
    }

    function renderBars(id, current, series, unit) {
      const svg = document.getElementById(id);
      const width = 680;
      const height = 300;
      const pad = 34;
      const max = Math.max(1, ...current.flatMap((run) => series.map((item) => item.value(run))));
      const group = (width - pad * 2) / Math.max(1, current.length);
      const bar = Math.min(28, group / (series.length + 1));
      const rows = Array.from({ length: 5 }, (_, index) => index);
      svg.setAttribute("viewBox", "0 0 " + width + " " + height);
      svg.innerHTML = rows.map((row) => {
        const y = pad + row * ((height - pad * 2) / 4);
        const value = Math.round(max - row * (max / 4));
        return '<line class="axis" x1="' + pad + '" y1="' + y + '" x2="' + (width - pad) + '" y2="' + y + '"></line><text class="tick" x="4" y="' + (y + 4) + '">' + value + unit + '</text>';
      }).join("") + current.map((run, runIndex) => series.map((item, itemIndex) => {
        const value = item.value(run);
        const h = value / max * (height - pad * 2);
        const x = pad + runIndex * group + itemIndex * (bar + 4) + group * 0.28;
        const y = height - pad - h;
        return '<rect x="' + x + '" y="' + y + '" width="' + bar + '" height="' + h + '" fill="' + item.color + '"><title>' + run.name + ' ' + item.label + ': ' + value + unit + '</title></rect>';
      }).join("") + '<text class="bar-label" transform="translate(' + (pad + runIndex * group + group * 0.5) + ' ' + (height - 4) + ') rotate(-18)" text-anchor="end">' + shortName(run.name) + '</text>').join("");
    }

    function shortName(name) {
      return String(name).replace(/^\\d{8}T\\d{6}Z-/, "").replace("multi-instance-slow-stream-", "");
    }

    function renderTable(current) {
      document.getElementById("run-table").innerHTML = current.map((run) => '<tr><td><code>' + run.name + '</code></td><td>' + run.mode + '</td><td>' + run.scenario + '</td><td>' + number(run.duration_ms) + 'ms</td><td class="' + (failed(run) ? 'bad' : 'good') + '">' + exitText(run) + '</td><td>' + kindValue(run, "child_kind_max_cpu", "opencode") + '%</td><td>' + kindValue(run, "child_kind_max_cpu", "git") + '%</td><td>' + kindValue(run, "child_kind_max_rss_mb", "opencode") + 'MB</td><td>' + number(run.tracked_max_total_rss_mb) + 'MB</td><td>' + number(run.host_max_memory_used_percent) + '%</td><td>' + number(run.host_max_swap_used_mb) + 'MB</td><td>' + number(run.child_process_count) + '</td><td><code>' + run.artifact + '</code></td></tr>').join("");
    }

    render();
  </script>
</body>
</html>
`
}
