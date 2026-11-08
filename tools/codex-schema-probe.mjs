#!/usr/bin/env node
// Dev-only, shape-only probe of Codex CLI session logs (spec D53; rules as in schema-probe.mjs).
//
// Prints key paths, value types, counts, lengths and digit-masked shapes. Never prints a
// field value, a model id, a folder or file name, or the root path. Identifier-shaped key
// names and lowercase line and payload type values may be printed, as shape only. It:
//   - lists only <root>/sessions/YYYY/MM/DD and opens only regular rollout-*.jsonl files there;
//   - lists <root>/archived_sessions/ by name only, counting extensions; never opens a file there;
//   - lists and opens nothing else under the Codex folder (auth.json, config.toml, history.jsonl,
//     log/, sqlite files);
//   - decodes a line only to learn its shape, in memory; the payload is walked only for
//     token_usage_record and token_count lines, and only top-level payload keys are listed for
//     turn_context and session_meta; rate_limits, instructions, git and similar subtrees are
//     counted as skipped, never walked;
//   - aborts, printing nothing, if any output token contains "/".
//
// Root: $CODEX_HOME (as the extension: no ~ expansion, relative → home) or ~/.codex.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const TYPE_NAME = /^[a-z][a-z_]{0,39}$/;
const KEY_CHARS = /^[A-Za-z0-9_-]+$/;
const ROLLOUT = /^rollout-.*\.jsonl$/;
const SKIP_KEYS = new Set(["rate_limits", "instructions", "git", "cwd", "sandbox_policy", "approval_policy", "user_instructions", "developer_instructions", "base_instructions", "content", "message", "text", "summary", "arguments", "output"]);
const FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];
const NEEDLES = ["token_usage_record", "turn_context", "session_meta", "event_msg"].map((t) => [t, Buffer.from(`"type":"${t}"`)]);
const MAX_PARSE_BYTES = 16 * 1024 * 1024;

/** As src/core/config.ts resolves an environment value: trimmed, blank = unset, no ~ expansion, relative → home. */
function expandRoot(env, fallback) {
  const v = env?.trim();
  if (!v) return join(homedir(), fallback);
  return resolve(homedir(), v);
}

// Node errors carry absolute paths in their message and stack: print only the code.
function fail(err) {
  const code = err && typeof err.code === "string" && /^[A-Z0-9_]{1,40}$/.test(err.code) ? err.code : "EXCEPTION";
  console.error(`codex-schema-probe: failed (${code})`);
  process.exit(1);
}
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "number";
  return typeof v;
}
function maskKey(k) {
  if (UUID.test(k)) return "<uuid>";
  return IDENT.test(k) ? k : "<key>";
}
function shape(s) {
  if (typeof s !== "string") return `(${typeOf(s)})`;
  if (s.length > 40) return `(string, ${s.length} chars)`;
  return s.replace(/[0-9]/g, "9").replace(/[a-z]/g, "a").replace(/[A-Z]/g, (c) => (c === "T" || c === "Z" ? c : "A")).replace(/[^9aAT Z:.+-]/g, "?");
}
function bump(map, key, n = 1) {
  map.set(key, (map.get(key) ?? 0) + n);
}
function pathMap(store, name) {
  if (!store.has(name)) store.set(name, new Map());
  return store.get(name);
}
function walk(value, path, paths, depth, deep) {
  if (value === null || typeof value !== "object" || depth > 8) return;
  if (Array.isArray(value)) {
    const p = `${path}[]`;
    for (const item of value) {
      bump(pathMap(paths, p), typeOf(item));
      if (deep) walk(item, p, paths, depth + 1, deep);
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    const p = `${path}.${maskKey(k)}`;
    if (SKIP_KEYS.has(k)) {
      bump(pathMap(paths, p), `(skipped ${typeOf(v)})`);
      continue;
    }
    bump(pathMap(paths, p), typeOf(v));
    if (deep) walk(v, p, paths, depth + 1, deep);
  }
}
function stats(nums) {
  if (nums.length === 0) return "none";
  const s = [...nums].sort((a, b) => a - b);
  return `min ${s[0]}, median ${s[Math.floor(s.length / 2)]}, max ${s[s.length - 1]}`;
}
const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ") || "none";
const isCount = (v) => Number.isInteger(v) && v >= 0;

// ---------------------------------------------------------------- discovery

const codexRoot = expandRoot(process.env.CODEX_HOME, ".codex");
const sessions = join(codexRoot, "sessions");
const out = [];
const emit = (s = "") => out.push(s);

function dirs(dir, re) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink() && re.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

let years;
try {
  years = readdirSync(sessions, { withFileTypes: true });
} catch {
  console.log("codex-schema-probe: no sessions folder under the Codex root");
  process.exit(2);
}
const layout = { years: 0, months: 0, days: 0, otherTop: 0, otherInDay: 0, symlinks: 0 };
const files = [];
for (const y of years) {
  if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) {
    layout.otherTop++;
    continue;
  }
  layout.years++;
  for (const m of dirs(join(sessions, y.name), /^\d{2}$/)) {
    layout.months++;
    for (const d of dirs(join(sessions, y.name, m), /^\d{2}$/)) {
      layout.days++;
      const dir = join(sessions, y.name, m, d);
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isSymbolicLink()) layout.symlinks++;
        else if (e.isFile() && ROLLOUT.test(e.name)) files.push(join(dir, e.name));
        else layout.otherInDay++;
      }
    }
  }
}

const archived = new Map();
try {
  for (const name of readdirSync(join(codexRoot, "archived_sessions"))) {
    bump(archived, name.endsWith(".jsonl.zst") ? ".jsonl.zst" : name.endsWith(".jsonl") ? ".jsonl" : "(other)");
  }
} catch {
  // no archived_sessions folder
}

// ---------------------------------------------------------------- scan

const lines = { total: 0, valid: 0, tooLong: 0, crlf: 0, standardHead: 0, keyOrder: new Map() };
const sizes = [];
let longest = 0;
const typeCounts = new Map();
const eventTypes = new Map();
const gate = new Map(NEEDLES.map(([t]) => [t, 0]));
const paths = new Map(); // type → paths
const rec = {
  n: 0, responseIdLen: new Map(), responseIdBad: 0, responseIds: new Set(), sessionUuid: 0, turnId: 0, ts: new Map(),
  fields: new Map(FIELDS.map((f) => [f, 0])), cachedLeInput: 0, reasoningLeOutput: 0, cacheWriteNonZero: 0, comparable: 0,
};
const files_ = {
  total: 0, withRecord: 0, withTokenCount: 0, tokenCountOnly: 0, bothKinds: 0, turnBeforeRecord: 0, maxModels: 0,
  multiMeta: 0, totalBelowSum: 0, totalEqualSum: 0, totalAboveSum: 0, modelMissing: 0,
};

for (const path of files) {
  let buf;
  try {
    if (!lstatSync(path).isFile()) continue;
    buf = readFileSync(path);
  } catch {
    continue;
  }
  files_.total++;
  sizes.push(buf.length);
  const f = { records: 0, tokenCount: 0, turnSeen: false, turnFirst: false, models: new Set(), metas: 0, sumInput: 0, lastTotalInput: -1 };
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    const raw = buf.subarray(start, end);
    start = end + 1;
    if (raw.length === 0) continue;
    lines.total++;
    longest = Math.max(longest, raw.length);
    if (raw[raw.length - 1] === 0x0d) lines.crlf++;
    if (raw.length > MAX_PARSE_BYTES) {
      lines.tooLong++;
      continue;
    }
    let ev;
    try {
      ev = JSON.parse(raw.toString("utf8"));
    } catch {
      continue;
    }
    if (ev === null || typeof ev !== "object" || Array.isArray(ev)) continue;
    lines.valid++;
    if (raw.subarray(0, 14).toString("latin1") === '{"timestamp":"') lines.standardHead++;
    bump(lines.keyOrder, Object.keys(ev).slice(0, 4).map(maskKey).join(", "));
    const type = typeof ev.type === "string" && TYPE_NAME.test(ev.type) ? ev.type : "(other)";
    bump(typeCounts, type);
    for (const [t, needle] of NEEDLES) if (ev.type !== t && raw.includes(needle)) bump(gate, t);
    const p = ev.payload && typeof ev.payload === "object" ? ev.payload : {};

    if (ev.type === "token_usage_record") {
      walk(p, "payload", pathMap(paths, type), 0, true);
      rec.n++;
      f.records++;
      if (!f.turnSeen) f.turnFirst = true;
      const id = p.response_id;
      if (typeof id === "string") {
        bump(rec.responseIdLen, id.length);
        if (!KEY_CHARS.test(id)) rec.responseIdBad++;
        rec.responseIds.add(id);
      } else bump(rec.responseIdLen, `(${typeOf(id)})`);
      if (typeof p.session_id === "string" && UUID.test(p.session_id)) rec.sessionUuid++;
      if (typeof p.turn_id === "string") rec.turnId++;
      bump(rec.ts, shape(ev.timestamp));
      const u = p.usage && typeof p.usage === "object" ? p.usage : {};
      for (const fld of FIELDS) if (isCount(u[fld])) rec.fields.set(fld, rec.fields.get(fld) + 1);
      if (isCount(u.input_tokens) && isCount(u.cached_input_tokens)) {
        rec.comparable++;
        if (u.cached_input_tokens <= u.input_tokens) rec.cachedLeInput++;
      }
      if (isCount(u.output_tokens) && isCount(u.reasoning_output_tokens) && u.reasoning_output_tokens <= u.output_tokens) rec.reasoningLeOutput++;
      if (isCount(u.cache_write_input_tokens) && u.cache_write_input_tokens > 0) rec.cacheWriteNonZero++;
      if (isCount(u.input_tokens)) f.sumInput += u.input_tokens;
    } else if (ev.type === "turn_context") {
      walk(p, "payload", pathMap(paths, type), 0, false);
      f.turnSeen = true;
      if (typeof p.model === "string") f.models.add(p.model);
    } else if (ev.type === "session_meta") {
      walk(p, "payload", pathMap(paths, type), 0, false);
      f.metas++;
    } else if (ev.type === "event_msg") {
      const et = typeof p.type === "string" && TYPE_NAME.test(p.type) ? p.type : "(other)";
      bump(eventTypes, et);
      if (p.type === "token_count") {
        walk(p, "payload", pathMap(paths, "event_msg token_count"), 0, true);
        f.tokenCount++;
        const tin = p.info?.total_token_usage?.input_tokens;
        if (isCount(tin)) f.lastTotalInput = tin;
      }
    }
  }
  if (f.records > 0) files_.withRecord++;
  if (f.tokenCount > 0) files_.withTokenCount++;
  if (f.tokenCount > 0 && f.records === 0) files_.tokenCountOnly++;
  if (f.tokenCount > 0 && f.records > 0) {
    files_.bothKinds++;
    if (f.lastTotalInput >= 0) {
      if (f.lastTotalInput < f.sumInput) files_.totalBelowSum++;
      else if (f.lastTotalInput === f.sumInput) files_.totalEqualSum++;
      else files_.totalAboveSum++;
    }
  }
  if (f.records > 0 && !f.turnFirst) files_.turnBeforeRecord++;
  if (f.records > 0 && f.models.size === 0) files_.modelMissing++;
  files_.maxModels = Math.max(files_.maxModels, f.models.size);
  if (f.metas > 1) files_.multiMeta++;
}

// ---------------------------------------------------------------- report

emit("# Codex log schema probe (shape only)");
emit();
emit("## Layout");
emit(`- sessions: year folders ${layout.years}, month folders ${layout.months}, day folders ${layout.days}; other top-level entries ${layout.otherTop}; other entries in day folders ${layout.otherInDay}; symlinks skipped ${layout.symlinks}`);
emit(`- rollout files: ${files_.total}; sizes (bytes): ${stats(sizes)}; total ${sizes.reduce((x, y) => x + y, 0)} bytes`);
emit(`- archived_sessions entries (names only, never opened): ${fmt(archived)}`);
emit();
emit("## Lines");
emit(`- lines: ${lines.total}; valid JSON objects: ${lines.valid}; longest (bytes): ${longest}; over 16 MiB (not decoded): ${lines.tooLong}; CRLF: ${lines.crlf}`);
emit(`- starting with {"timestamp":" — ${lines.standardHead}`);
emit(`- first four keys: ${fmt(lines.keyOrder)}`);
emit();
emit("## Line types");
emit("| type | lines |");
emit("|---|---|");
for (const [t, n] of [...typeCounts].sort((x, y) => y[1] - x[1])) emit(`| ${t} | ${n} |`);
emit(`- event_msg payload.type: ${fmt(eventTypes)}`);
emit();
emit("## Gate safety (lines of another type containing the needle)");
for (const [t, n] of gate) emit(`- "type":"${t}": ${n}`);
emit();
emit("## token_usage_record");
emit(`- records: ${rec.n}; response_id length: ${fmt(rec.responseIdLen)}; outside [A-Za-z0-9_-]: ${rec.responseIdBad}; distinct: ${rec.responseIds.size} of ${rec.n}`);
emit(`- session_id UUID: ${rec.sessionUuid}; with turn_id string: ${rec.turnId}; timestamp shapes: ${fmt(rec.ts)}`);
emit(`- usage ints present: ${FIELDS.map((x) => `${x} ${rec.fields.get(x)}`).join(", ")}`);
emit(`- cached_input_tokens ≤ input_tokens: ${rec.cachedLeInput} of ${rec.comparable}; reasoning_output_tokens ≤ output_tokens: ${rec.reasoningLeOutput}; cache_write_input_tokens above 0: ${rec.cacheWriteNonZero}`);
emit();
emit("## Per file");
emit(`- with token_usage_record: ${files_.withRecord}; with token_count: ${files_.withTokenCount}; token_count only: ${files_.tokenCountOnly}; both: ${files_.bothKinds}`);
emit(`- both kinds, last total input vs the records' sum: below ${files_.totalBelowSum}, equal ${files_.totalEqualSum}, above ${files_.totalAboveSum}`);
emit(`- files with records whose first record follows a turn_context: ${files_.turnBeforeRecord} of ${files_.withRecord}; with records and no turn_context model: ${files_.modelMissing}`);
emit(`- most distinct turn_context models in one file: ${files_.maxModels}; files with more than one session_meta: ${files_.multiMeta}`);
emit();
emit("## Payload key paths (turn_context and session_meta: top-level keys only; rate_limits, instructions, git, cwd and similar subtrees skipped)");
for (const [t, m] of [...paths].sort()) {
  emit();
  emit(`### ${t}`);
  emit("| path | types |");
  emit("|---|---|");
  for (const [k, v] of [...m].sort()) emit(`| ${k} | ${fmt(v)} |`);
}

// Privacy guard: nothing printed may look like a path.
if (out.some((line) => line.split(/\s+/).some((token) => token.includes("/")))) {
  console.error("codex-schema-probe: aborted, a printed token contained '/'; nothing was printed");
  process.exit(1);
}
console.log(out.join("\n"));
