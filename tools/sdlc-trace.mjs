#!/usr/bin/env node
// sdlc-trace.mjs — append-only conversation trace for one feature, plus renderers.
//
//   --feature <f> --log --from <a> --to <b> --kind <k> [--file <path>] [--note <text>] [--rc <n>] [--ms <n>]
//   --feature <f> --render        writes trace.md (mermaid) and trace.html
//   --feature <f> --follow        live one-line-per-event view (Ctrl-C to stop)
//
// Actors: leader, builder, qa, verify. Kinds: prompt, reply, verify, decision, note.
// trace.jsonl is the record; the rendered files are regenerable and never edited by hand.
import fs from "node:fs";
import path from "node:path";
import { stamp } from "./trace-time.mjs";

const a = process.argv.slice(2);
const opt = (k, d = "") => { const i = a.indexOf("--" + k); return i < 0 ? d : (a[i + 1] ?? true); };
const has = (k) => a.includes("--" + k);
const feature = opt("feature");
if (!feature) { console.error("--feature required"); process.exit(3); }
const dir = path.join(".sdlc", "features", feature);
const log = path.join(dir, "trace.jsonl");
const read = () => fs.existsSync(log)
  ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

// ts is stored as UTC ISO; show it in the machine's local time, with the date so a gap across midnight reads right.
const local = (iso) => stamp(iso, true);
const line = (e, i) => {
  const t = local(e.ts), ms = e.ms ? ` ${(e.ms / 1000).toFixed(0)}s` : "", rc = e.rc ? ` rc=${e.rc}` : "";
  return `${String(i + 1).padStart(3)} ${t} ${e.from} -> ${e.to} [${e.kind}]${ms}${rc} ${e.note || path.basename(e.file || "")}`;
};

if (has("log")) {
  fs.mkdirSync(dir, { recursive: true });
  const e = { ts: new Date().toISOString(), from: opt("from", "leader"), to: opt("to", "leader"), kind: opt("kind", "note"),
    file: opt("file") || undefined, note: opt("note") || undefined,
    rc: opt("rc") !== "" ? Number(opt("rc")) : undefined, ms: opt("ms") !== "" ? Number(opt("ms")) : undefined };
  fs.appendFileSync(log, JSON.stringify(e) + "\n");
  process.exit(0);
}

if (has("follow")) {
  let seen = 0;
  const tick = () => { const ev = read(); ev.slice(seen).forEach((e, j) => console.log(line(e, seen + j))); seen = ev.length; };
  tick(); setInterval(tick, 1000); await new Promise(() => {});
}

if (has("render")) {
  const ev = read();
  const esc = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const mm = (s) => String(s).replace(/[;#\n]/g, " ").slice(0, 70);
  const names = { leader: "Leader (Claude)", builder: "Builder (opencode)", qa: "QA (opencode)", verify: "sdlc-verify" };
  const used = [...new Set(ev.flatMap((e) => [e.from, e.to]))];
  const seq = ["sequenceDiagram", "  autonumber", ...used.map((u) => `  participant ${u} as ${names[u] || u}`),
    ...ev.map((e) => {
      const arrow = e.kind === "reply" || e.kind === "verify" ? "-->>" : "->>";
      const bad = e.rc ? " ❌" : "";
      return e.from === e.to ? `  Note over ${e.from}: ${mm(e.note || e.kind)}`
        : `  ${e.from}${arrow}${e.to}: ${mm(e.kind + ": " + (e.note || path.basename(e.file || "")))}${bad}`;
    })].join("\n");
  fs.writeFileSync(path.join(dir, "trace.md"),
    `# Trace: ${feature}\n\n\`\`\`mermaid\n${seq}\n\`\`\`\n\n## Events\n\n\`\`\`\n${ev.map(line).join("\n")}\n\`\`\`\n`);
  const body = ev.map((e, i) => {
    let txt = "";
    if (e.file && fs.existsSync(e.file) && /\.(md|txt|json|jsonl)$/.test(e.file)) txt = fs.readFileSync(e.file, "utf8").slice(0, 20000);
    const img = e.file && /\.png$/.test(e.file) ? `<img src="${esc(path.relative(dir, e.file))}" width="480">` : "";
    return `<details${e.rc ? " open" : ""}><summary>${esc(line(e, i))}</summary>${img}<pre>${esc(txt)}</pre></details>`;
  }).join("\n");
  fs.writeFileSync(path.join(dir, "trace.html"),
    `<!doctype html><meta charset=utf-8><title>Trace ${esc(feature)}</title><style>body{font:14px system-ui;max-width:1000px;margin:2em auto;padding:0 1em}pre{white-space:pre-wrap;background:#f4f4f4;padding:.8em;max-height:30em;overflow:auto}summary{cursor:pointer;font-family:monospace}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}pre{background:#222}}</style>
<h1>Trace: ${esc(feature)}</h1><pre class=mermaid>${esc(seq)}</pre>${body}
<script type=module>import m from"https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";m.initialize({startOnLoad:true,theme:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"default"})</script>`);
  console.log(`wrote ${dir}/trace.md and trace.html (${ev.length} events)`);
  process.exit(0);
}
console.error("one of --log, --render, --follow required"); process.exit(3);
