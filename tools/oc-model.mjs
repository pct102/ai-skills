#!/usr/bin/env node
// oc-model.mjs — print the provider/model pairs found in `opencode export <session>` (stdin).
//   opencode export <session-id> | node tools/oc-model.mjs
// Exit 0 with a comma-separated list; exit 1 with the reason on stderr when nothing is found.
// `opencode export` is cut at 64 KiB when its stdout is a pipe, so prefer a file:
//   opencode export <id> > /tmp/x.json; node tools/oc-model.mjs < /tmp/x.json
// A truncated export is still read: the model objects sit near the top.
let t = "";
process.stdin.on("data", (d) => (t += d)).on("end", () => {
  const i = t.indexOf("{\n") >= 0 ? t.indexOf("{\n") : t.indexOf("{");
  if (i < 0) { console.error("no JSON in export output"); process.exit(1); }
  const found = new Set();
  const add = (o) => {
    if (!o || typeof o.providerID !== "string") return;
    const m = typeof o.modelID === "string" ? o.modelID : (o.role === undefined && typeof o.id === "string" ? o.id : "");
    if (m) found.add(o.providerID + "/" + m);
  };
  let j;
  try { j = JSON.parse(t.slice(i)); } catch { j = null; }
  if (j) {
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      add(o);
      for (const v of Object.values(o)) walk(v);
    })(j);
  } else {
    // Truncated or damaged JSON: read the flat objects that carry a providerID.
    for (const m of t.slice(i).matchAll(/\{[^{}]*"providerID"[^{}]*\}/g)) {
      try { add(JSON.parse(m[0])); } catch {}
    }
    if (found.size) console.error("warning: export was not valid JSON (truncated?); read the model from its flat objects");
  }
  if (!found.size) { console.error("no providerID/modelID pairs in export"); process.exit(1); }
  console.log([...found].join(","));
});
