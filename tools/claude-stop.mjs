#!/usr/bin/env node
// claude-stop.mjs — say why a headless `claude -p` call ended, and how long to wait if the account's
// usage window is spent.
//
//   node claude-stop.mjs --rc <n> [--file <path>]... [--elapsed <s>] [--min-wait <s>] [--default-wait <s>]
//                        [--quick <s>] [--past-threshold <min>] [--now <iso>]
//
// Prints exactly three lines: kind, wait_seconds, note.
//
//   done   the turn ended and Claude can be called again (rc 0)
//   limit  the subscription window is spent — "You've hit your session limit · resets 8:10pm
//          (Asia/Saigon)". No retry can help, only the clock. wait_seconds is the time until the
//          reset as stated in the message, in the timezone the message names.
//   other  it died for another reason (rc != 0, no usage-limit text)
//
// Why a separate tool: `claude -p --output-format json` ends with one JSON result object, so the
// reason a leader stopped is a fact on disk, not a guess from an exit code. autopilot.sh reads the
// kind and either resumes (done/other) or waits for the window to reopen (limit).
//
// Detection is deliberately conservative. A run whose *own report* talks about session limits must
// not be mistaken for one that hit a limit, so the text only counts when the call also failed
// (rc != 0, or is_error true in the JSON) — plus one exception, --quick: a call that returns in
// under N seconds (default 20) cannot have done real work, so a limit message in its output is
// trusted even when the CLI calls the result a success.
//
// Nothing is guessed when the message states no reset time: the wait is then --default-wait
// (default 1800 s) — short enough to retry, long enough not to hammer the API.
//
// Exit 0 always. The caller acts on the printed kind, never on the exit code.
import fs from "node:fs";

const a = process.argv.slice(2);
const vals = (k) => a.reduce((o, v, i) => (v === "--" + k && a[i + 1] !== undefined ? o.concat(a[i + 1]) : o), []);
const opt = (k, d) => { const i = a.indexOf("--" + k); return i < 0 ? d : (a[i + 1] ?? d); };

const rc = Number(opt("rc", "0"));
const elapsed = opt("elapsed", "") === "" ? null : Number(opt("elapsed"));
const minWait = Math.max(0, Number(opt("min-wait", "30")));
const defaultWait = Math.max(0, Number(opt("default-wait", "1800")));
const quick = Math.max(0, Number(opt("quick", "20")));
const pastThreshold = Math.max(0, Number(opt("past-threshold", "180")));
const nowArg = opt("now", "");

// The messages Claude Code returns when the plan's window is spent. Kept narrow on purpose: every
// pattern here also appears in ordinary prose about limits, which is why it is gated on a failure.
const LIMIT = new RegExp([
  "hit your (?:session|usage|weekly|hourly|daily) limit",
  "(?:session|usage|weekly|hourly|daily) limit (?:has been )?reached",
  "limit will reset",
  "rate ?limit exceeded",
  "quota (?:exceeded|reached)",
  "out of (?:credits|usage|extra usage)",
  "credit balance is too low",
  "resets? +(?:at +)?\\d{1,2}(?::\\d{2})? *(?:am|pm)?",
].join("|"), "i");

function readAll(files) {
  let text = "";
  for (const f of files) { try { text += fs.readFileSync(f, "utf8") + "\n"; } catch {} }
  return text;
}

// The result object is a single JSON document. Read `result` and `is_error` from it when it parses;
// when it does not (stderr, an older CLI, a truncated file) fall back to the raw bytes.
function inspect(raw) {
  const t = raw.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return { text: raw, isError: null, parsed: false };
  let j; try { j = JSON.parse(t); } catch { return { text: raw, isError: null, parsed: false }; }
  const o = Array.isArray(j) ? (j.find((x) => x && typeof x === "object" && "result" in x) || {}) : j;
  const text = [o.result, o.error, o.subtype].filter((x) => typeof x === "string").join("\n");
  return { text: text || raw, isError: typeof o.is_error === "boolean" ? o.is_error : null, parsed: true };
}

// Seconds until the next occurrence of the stated wall-clock time, in the timezone the message names
// (or the machine's own when it names none).
//
// A negative difference is ambiguous: 20:10 stated at 21:00 has already passed (the window is open,
// retry now), while 03:00 stated at 23:00 is tomorrow (wait four hours). Session windows are hours
// long, so the reading that is near in time is the real one: a difference short of --past-threshold
// backwards means the reset has just passed, anything further back means the next day.
function waitForReset(text, isErrorKnown) {
  const m = /resets? +(?:at +)?(\d{1,2})(?::(\d{2}))? *(am|pm)?/i.exec(text);
  const tzm = /\(([A-Za-z]+(?:\/[A-Za-z_+\-0-9]+)+)\)/.exec(text);
  const tz = tzm ? tzm[1] : null;
  const fallback = (why) => ({ s: defaultWait, why });
  if (!m) return fallback(`no reset time in the message; trying again in ${Math.round(defaultWait / 60)} min`);

  let h = Number(m[1]);
  const mi = m[2] === undefined ? 0 : Number(m[2]);
  const ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || mi > 59) return fallback(`unreadable reset time "${m[0]}"; trying again in ${Math.round(defaultWait / 60)} min`);

  let nowH, nowM;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz || undefined, hour: "2-digit", minute: "2-digit", hour12: false });
    const parts = Object.fromEntries(fmt.formatToParts(nowArg ? new Date(nowArg) : new Date()).map((p) => [p.type, p.value]));
    nowH = Number(parts.hour) % 24;
    nowM = Number(parts.minute);
  } catch {
    return fallback(`unknown timezone "${tz}" in the message; trying again in ${Math.round(defaultWait / 60)} min`);
  }

  const stated = `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}${tz ? " " + tz : ""}`;
  let mins = h * 60 + mi - (nowH * 60 + nowM);
  if (mins === 0) return { s: minWait, why: `resets ${stated} (now); trying again in ${minWait}s` };
  if (mins < 0) {
    if (-mins <= pastThreshold) return { s: minWait, why: `the stated reset ${stated} has already passed; trying again in ${minWait}s` };
    mins += 1440;
  }
  const s = Math.max(minWait, mins * 60);
  return { s, why: `resets ${stated} (in ${mins} min)${isErrorKnown === false ? ", stated in a successful reply" : ""}` };
}

const raw = readAll(vals("file"));
const { text, isError, parsed } = inspect(raw);
const failed = rc !== 0 || isError === true;
const quickStop = quick > 0 && elapsed !== null && elapsed >= 0 && elapsed < quick;
const limited = LIMIT.test(text) && (failed || quickStop);

let kind, wait, note;
if (limited) {
  kind = "limit";
  const info = waitForReset(text, isError);
  wait = info.s;
  note = `usage window spent: ${info.why}`;
} else if (failed) {
  kind = "other";
  wait = 0;
  const first = text.replace(/\s+/g, " ").trim().slice(0, 160);
  note = `failed without a usage-limit message (rc=${rc}${parsed ? `, is_error=${isError}` : ", output not JSON"})${first ? `: ${first}` : ""}`;
} else {
  kind = "done";
  wait = 0;
  note = "the turn ended";
}

process.stdout.write(`${kind}\n${wait}\n${note}\n`);
