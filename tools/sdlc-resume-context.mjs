#!/usr/bin/env node
// sdlc-resume-context.mjs — the journal, summarized for a resume.
//
// A fresh leader used to re-read spec.md, plan.md, trace.jsonl and the newest
// builder/qa replies and then *guess* where the run stands. That guess costs a
// full context re-read and can repeat finished work. This tool derives the same
// answer from machine state instead: status.json (the phase), the slice plan +
// slice state, lanes still in flight, the last trace events, and prior jev
// answers. Paste its output into the resume prompt; what is listed here must
// not be re-derived from prose.
//
//   node tools/sdlc-resume-context.mjs --feature <f> [--json] [--max-events N]
//
// Exit 0 with the brief, 3 when the feature has no journal to read.
import fs from "node:fs";
import path from "node:path";

const a = process.argv.slice(2);
const opt = (k, d = "") => { const i = a.indexOf("--" + k); return i < 0 ? d : (a[i + 1] ?? d); };
const has = (k) => a.includes("--" + k);
const feature = opt("feature");
if (!feature) { console.error("--feature required"); process.exit(3); }
const maxEvents = Math.max(1, parseInt(opt("max-events", "8"), 10) || 8);

const fdir = path.join(".sdlc", "features", feature);
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } };
if (!fs.existsSync(fdir)) { console.error(`no .sdlc/features/${feature}`); process.exit(3); }

const status = readJson(path.join(fdir, "status.json"), {});
const slices = readJson(path.join(fdir, "slices.json"), {}).slices || null;
const sliceState = readJson(path.join(fdir, ".oc", "slices", "state.json"), {});
const trace = (() => {
  try {
    return fs.readFileSync(path.join(fdir, "trace.jsonl"), "utf8").split("\n")
      .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
})();
const jev = (() => {
  try {
    return fs.readFileSync(path.join(fdir, "jev-ledger.jsonl"), "utf8").split("\n")
      .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
})();

// Lanes still in flight: a .pid + .current without a matching .done, and the pid alive.
// Mirrors workers_running in autopilot.sh so the brief and the waiter agree.
const inFlight = [];
for (const top of [path.join(fdir, ".oc")]) {
  let dirs = [];
  try { dirs = [top, ...fs.readdirSync(top).filter((d) => d.startsWith("lane-")).map((d) => path.join(top, d))]; }
  catch { continue; }
  for (const d of dirs) {
    let pids = [];
    try { pids = fs.readdirSync(d).filter((f) => f.endsWith(".pid")); } catch { continue; }
    for (const pf of pids) {
      const r = pf.slice(0, -4);
      const done = fs.existsSync(path.join(d, `${r}.done`));
      const cur = (() => { try { return fs.readFileSync(path.join(d, `${r}.current`), "utf8").trim(); } catch { return ""; } })();
      if (done || !cur) continue;
      const pid = parseInt((fs.readFileSync(path.join(d, pf), "utf8") || "").trim(), 10);
      let alive = false;
      try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch { alive = false; }
      const lane = d.includes("lane-") ? ` (${path.basename(d).slice(5)})` : "";
      inFlight.push(`${r}${lane}: pid ${pid || "?"}${alive ? " alive" : " dead, result unread"}`);
    }
  }
}

const sliceRows = (slices || []).map((s) => {
  const st = sliceState[s.id] || {};
  return { id: s.id, status: st.status || "pending",
    depends: (s.depends || []).join(","), reasons: (st.reasons || []).slice(0, 2) };
});
const pending = sliceRows.filter((r) => r.status === "pending").map((r) => r.id);
const running = sliceRows.filter((r) => r.status === "running").map((r) => r.id);
const failed = sliceRows.filter((r) => r.status === "failed").map((r) => r.id);

const phase = status.phase || "unknown";
let next = "";
if (phase === "accepted") next = "nothing to resume: the feature is accepted.";
else if (phase === "blocked" || phase === "escalated")
  next = `do not restart: a human decision is outstanding (${status.blocked_reason || "see status.json"}).`;
else if (phase === "planned" || phase === "contract")
  next = "work was never begun: report only, do not start it here.";
else if (failed.length) next = `slices failed (${failed.join(", ")}): they need 'slices reset' before anything else runs.`;
else if (running.length) next = `slices running (${running.join(", ")}): check their lanes before starting anything new.`;
else if (pending.length) next = `resume with the pending slices (${pending.join(", ")}); finished slices must not run again.`;
else if (phase === "validating") next = "run sdlc-verify to re-check; the last run is summarized above.";
else next = "continue from the first step that is not done, per the slices and events above.";

const brief = {
  feature,
  phase,
  repair: `${status.repair_iterations ?? 0}/${status.budget ?? "?"}`,
  blocked_reason: status.blocked_reason || null,
  last_run: status.last_run || null,
  slices: sliceRows,
  in_flight: inFlight,
  prior_jev: jev.slice(-3).map((e) => ({ q: e.question, answer: e.answer, cached: !!e.cached })),
  last_events: trace.slice(-maxEvents).map((e) => ({
    ts: e.ts, kind: e.kind, path: `${e.from || "?"}->${e.to || "?"}`,
    note: String(e.note || (e.file ? path.basename(e.file) : e.kind || "")).slice(0, 160),
  })),
  next,
};

if (has("json")) { console.log(JSON.stringify(brief, null, 2)); process.exit(0); }

const L = [];
L.push(`RESUME BRIEF ${feature} — generated from the journal; do not re-derive what is listed here.`);
L.push(`phase: ${phase} (repair ${brief.repair}${brief.blocked_reason ? `, ${brief.blocked_reason}` : ""})`);
if (brief.last_run)
  L.push(`last_run: ${brief.last_run.result || "?"} at ${brief.last_run.at || "?"} (passed ${brief.last_run.passed ?? "?"}, failed ${brief.last_run.failed ?? "?"})`);
if (sliceRows.length) {
  L.push("slices:");
  for (const r of sliceRows)
    L.push(`  ${r.id} ${r.status}${r.depends ? ` (depends: ${r.depends})` : ""}${r.reasons.length ? ` — ${r.reasons.join("; ")}` : ""}`);
}
L.push(inFlight.length ? "in flight (do not start these again, read their lane output):" : "in flight: none observed.");
for (const w of inFlight) L.push(`  ${w}`);
if (brief.prior_jev.length) {
  L.push("prior jev answers (do not re-ask the same question):");
  for (const j of brief.prior_jev) L.push(`  ${j.q} -> ${j.answer}`);
}
if (brief.last_events.length) {
  L.push("last events:");
  for (const e of brief.last_events) L.push(`  [${e.kind}] ${e.path} ${e.note}`);
}
L.push(`next: ${next}`);
console.log(L.join("\n"));
