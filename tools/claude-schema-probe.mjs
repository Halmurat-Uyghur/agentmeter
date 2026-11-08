#!/usr/bin/env node
// Dev-only, shape-only probe of Claude Code session logs (spec D53; rules as in schema-probe.mjs).
//
// Prints key paths, value types, counts, lengths and digit-masked shapes. Never prints a
// field value, a model id, a tool name, a folder or file name, or the root path. It:
//   - lists only <root>/projects/ (depth ≤ 6, symlinks not followed, memory/ and tool-results/
//     not entered) and opens only regular *.jsonl files found there; nothing else under the
//     Claude Code folder is listed or opened;
//   - decodes a line only to learn its shape, in memory; prompts, replies, thinking and tool
//     inputs are skipped as subtrees and never printed;
//   - masks UUID-shaped keys as <uuid> and any other non-identifier key as <key>;
//   - prints line types only from a small pattern of lowercase words, else (other);
//   - aborts, printing nothing, if any output token contains "/".
//
// Root: $CLAUDE_CONFIG_DIR (~ expanded, relative → home) or ~/.claude.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const TYPE_NAME = /^[a-z][a-z_-]{0,39}$/;
const CONTENT_TYPE = /^[a-z][a-z_]{0,39}$/;
const KEY_CHARS = /^[A-Za-z0-9_-]+$/;
const STOP_REASONS = new Set(["end_turn", "tool_use", "max_tokens", "refusal", "stop_sequence", "pause_turn"]);
// Folder names printed as themselves; anything else is <session dir> (UUID) or <other dir>.
const KNOWN_DIRS = new Set(["subagents", "workflows", "memory", "tool-results", "vercel-plugin", "remote-agents", "scripts"]);
const SKIP_DIRS = new Set(["memory", "tool-results"]);
const MAX_DEPTH = 6;
const MAX_PARSE_BYTES = 16 * 1024 * 1024;
// Subtrees whose keys may come from user content: counted, never walked.
const SKIP_KEYS = new Set(["content", "input", "toolUseResult", "text", "thinking", "signature", "snapshot", "attachment", "data", "cwd", "gitBranch"]);
const USAGE_FIELDS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"];
const NEEDLE_ASSISTANT = Buffer.from('"type":"assistant"');
const NEEDLE_USER = Buffer.from('"type":"user"');
const NEEDLE_USAGE = Buffer.from('"usage":{');
const DAY = 86_400_000;

function expandRoot(env, fallback) {
  if (!env) return join(homedir(), fallback);
  const expanded = env === "~" ? homedir() : env.startsWith("~/") ? join(homedir(), env.slice(2)) : env;
  return isAbsolute(expanded) ? expanded : resolve(homedir(), expanded);
}

// Node errors carry absolute paths in their message and stack: print only the code.
function fail(err) {
  const code = err && typeof err.code === "string" && /^[A-Z0-9_]{1,40}$/.test(err.code) ? err.code : "EXCEPTION";
  console.error(`claude-schema-probe: failed (${code})`);
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
/** Digits → 9, letters → a/A, everything else kept only if it is one of - : . T Z + space. */
function shape(s) {
  if (typeof s !== "string") return `(${typeOf(s)})`;
  if (s.length > 40) return `(string, ${s.length} chars)`;
  return s.replace(/[0-9]/g, "9").replace(/[a-z]/g, "a").replace(/[A-Z]/g, (c) => (c === "T" || c === "Z" ? c : "A")).replace(/[^9aAT Z:.+-]/g, "?");
}
function bump(map, key, n = 1) {
  map.set(key, (map.get(key) ?? 0) + n);
}
function walk(value, path, paths, depth) {
  if (value === null || typeof value !== "object" || depth > 8) return;
  if (Array.isArray(value)) {
    const p = `${path}[]`;
    if (!paths.has(p)) paths.set(p, new Map());
    for (const item of value) {
      bump(paths.get(p), typeOf(item));
      walk(item, p, paths, depth + 1);
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    const p = `${path}.${maskKey(k)}`;
    if (!paths.has(p)) paths.set(p, new Map());
    if (SKIP_KEYS.has(k)) {
      bump(paths.get(p), `(skipped ${typeOf(v)})`);
      continue;
    }
    bump(paths.get(p), typeOf(v));
    walk(v, p, paths, depth + 1);
  }
}
function stats(nums) {
  if (nums.length === 0) return "none";
  const s = [...nums].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return `min ${s[0]}, median ${at(0.5)}, p99 ${at(0.99)}, max ${s[s.length - 1]}`;
}
const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ") || "none";

// ---------------------------------------------------------------- discovery

const root = join(expandRoot(process.env.CLAUDE_CONFIG_DIR, ".claude"), "projects");
const out = [];
const emit = (s = "") => out.push(s);

let slugs;
try {
  slugs = readdirSync(root, { withFileTypes: true });
} catch {
  console.log("claude-schema-probe: no projects folder under the Claude Code root");
  process.exit(2);
}

const layout = { slugs: 0, otherTop: 0, dirs: new Map(), symlinks: 0, unreadableDirs: 0, files: [], otherFiles: 0, mainFiles: 0, nestedFiles: 0, mainNotUuid: 0, depthMax: 0 };
/** file: { path, depth, parentSession?: string (UUID dir), inPlugin: boolean } */
function visit(dir, depth, ctx) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    layout.unreadableDirs++;
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) {
      layout.symlinks++;
      continue;
    }
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const label = UUID.test(e.name) ? "<session dir>" : KNOWN_DIRS.has(e.name) ? e.name : e.name.startsWith("wf_") ? "wf_<id>" : "<other dir>";
      bump(layout.dirs, `depth ${depth + 1}: ${label}`);
      if (SKIP_DIRS.has(e.name) || depth + 1 >= MAX_DEPTH) continue;
      visit(p, depth + 1, {
        session: ctx.session ?? (UUID.test(e.name) ? e.name : undefined),
        plugin: ctx.plugin || e.name === "vercel-plugin",
      });
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      const fileDepth = depth + 1;
      layout.depthMax = Math.max(layout.depthMax, fileDepth);
      if (fileDepth === 2) {
        layout.mainFiles++;
        if (!UUID.test(e.name.slice(0, -6))) layout.mainNotUuid++;
      } else layout.nestedFiles++;
      layout.files.push({ path: p, depth: fileDepth, session: ctx.session, plugin: ctx.plugin });
    } else layout.otherFiles++;
  }
}
for (const s of slugs) {
  if (s.isDirectory() && !s.isSymbolicLink()) {
    layout.slugs++;
    visit(join(root, s.name), 1, { session: undefined, plugin: false });
  } else layout.otherTop++;
}

// ---------------------------------------------------------------- scan

const now = Date.now();
const recent = { d7: 0, d30: 0, d90: 0, min5: 0 };
const lines = { total: 0, valid: 0, tooLong: 0, crlf: 0, noType: 0, noTypeInPlugin: 0, unreadable: 0 };
const typeCounts = new Map();
const firstKeys = new Map();
const typeOffsets = [];
const envelope = new Map(); // "type key" → types
const assistantPaths = new Map();
const contentTypes = new Map();
const gate = { assistantInOther: 0, userMaxOffset: 0, userOver152: 0, userOver256: 0, usageInOther: new Map() };
const over1MiB = new Map();
const a = {
  lines: 0, sizes: [], model: new Map(), idLen: new Map(), idBadChars: 0, idMissing: 0, reqLen: new Map(),
  stop: new Map(), usage: new Map(USAGE_FIELDS.map((f) => [f, 0])), thinking: 0, ts: new Map(), sessionUuid: 0,
  cwdAbsolute: 0, sidechain: 0, agentId: 0, costUSD: 0, zero: 0, zeroSynthetic: 0, nestedSessionMatch: 0, nested: 0,
};
const byId = new Map(); // message.id → { n, files: Set<number>, out: number, differs, laterMore, firstNull, lastString }
let fileNo = 0;

for (const f of layout.files) {
  fileNo++;
  let st;
  try {
    st = lstatSync(f.path);
  } catch {
    lines.unreadable++;
    continue;
  }
  if (!st.isFile()) continue;
  const age = now - st.mtimeMs;
  if (age <= 7 * DAY) recent.d7 += st.size;
  if (age <= 30 * DAY) recent.d30 += st.size;
  if (age <= 90 * DAY) recent.d90 += st.size;
  if (age <= 300_000) recent.min5++;
  let buf;
  try {
    buf = readFileSync(f.path);
  } catch {
    lines.unreadable++;
    continue;
  }
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    const raw = buf.subarray(start, end);
    start = end + 1;
    if (raw.length === 0) continue;
    lines.total++;
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
    const hasType = typeof ev.type === "string";
    const type = hasType ? (TYPE_NAME.test(ev.type) ? ev.type : "(other)") : "(no-type)";
    if (!hasType) {
      lines.noType++;
      if (f.plugin) lines.noTypeInPlugin++;
    }
    bump(typeCounts, type);
    const keys = Object.keys(ev);
    bump(firstKeys, keys.slice(0, 2).map(maskKey).join(", "));
    if (hasType) {
      const off = raw.indexOf(Buffer.from(`"type":${JSON.stringify(ev.type)}`));
      if (off >= 0) typeOffsets.push(off);
    }
    for (const k of keys) {
      const ek = `${type} ${maskKey(k)}`;
      if (!envelope.has(ek)) envelope.set(ek, new Map());
      bump(envelope.get(ek), SKIP_KEYS.has(k) ? `(skipped ${typeOf(ev[k])})` : typeOf(ev[k]));
    }
    if (raw.length > 1_048_576) bump(over1MiB, type);

    // gate safety
    if (ev.type !== "assistant" && raw.includes(NEEDLE_ASSISTANT)) gate.assistantInOther++;
    if (ev.type !== "assistant" && raw.includes(NEEDLE_USAGE)) bump(gate.usageInOther, type);
    if (ev.type === "user") {
      const off = raw.indexOf(NEEDLE_USER);
      gate.userMaxOffset = Math.max(gate.userMaxOffset, off);
      if (off < 0 || off + NEEDLE_USER.length > 152) gate.userOver152++;
      if (off < 0 || off + NEEDLE_USER.length > 256) gate.userOver256++;
    }
    if (ev.type !== "assistant") continue;

    // assistant lines
    a.lines++;
    a.sizes.push(raw.length);
    walk(ev, "", assistantPaths, 0);
    const m = ev.message ?? {};
    const content = Array.isArray(m.content) ? m.content : [];
    for (const c of content) bump(contentTypes, c && typeof c.type === "string" && CONTENT_TYPE.test(c.type) ? c.type : "(other)");
    const model = m.model;
    bump(a.model, typeof model !== "string" ? `(${typeOf(model)})` : model === "<synthetic>" ? "<synthetic>" : model.startsWith("claude-") ? "claude-…" : "(other string)");
    if (typeof m.id === "string") {
      bump(a.idLen, m.id.length);
      if (!KEY_CHARS.test(m.id)) a.idBadChars++;
    } else a.idMissing++;
    if (typeof ev.requestId === "string") bump(a.reqLen, ev.requestId.length);
    else bump(a.reqLen, `(${typeOf(ev.requestId)})`);
    const sr = m.stop_reason;
    bump(a.stop, sr === null ? "null" : typeof sr === "string" ? (STOP_REASONS.has(sr) ? sr : "(other string)") : `(${typeOf(sr)})`);
    const u = m.usage && typeof m.usage === "object" ? m.usage : undefined;
    let allZero = true;
    for (const fld of USAGE_FIELDS) {
      const v = u?.[fld];
      if (Number.isInteger(v) && v >= 0) a.usage.set(fld, a.usage.get(fld) + 1);
      if (v !== undefined && v !== 0) allZero = false;
    }
    if (u && Number.isInteger(u.output_tokens_details?.thinking_tokens)) a.thinking++;
    if (allZero) {
      a.zero++;
      if (model === "<synthetic>") a.zeroSynthetic++;
    }
    bump(a.ts, shape(ev.timestamp));
    if (typeof ev.sessionId === "string" && UUID.test(ev.sessionId)) a.sessionUuid++;
    if (typeof ev.cwd === "string" && (ev.cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(ev.cwd))) a.cwdAbsolute++;
    if (ev.isSidechain === true) a.sidechain++;
    if ("agentId" in ev) a.agentId++;
    if ("costUSD" in ev) a.costUSD++;
    if (f.session !== undefined) {
      a.nested++;
      if (ev.sessionId === f.session) a.nestedSessionMatch++;
    }
    if (typeof m.id === "string") {
      const o = Number.isInteger(u?.output_tokens) ? u.output_tokens : -1;
      const sig = u ? USAGE_FIELDS.map((x) => u[x]).join(",") : "";
      const prev = byId.get(m.id);
      if (!prev) byId.set(m.id, { n: 1, files: new Set([fileNo]), out: o, sig, differs: false, laterMore: false, firstNull: sr === null, lastString: typeof sr === "string" });
      else {
        prev.n++;
        prev.files.add(fileNo);
        if (sig !== prev.sig) {
          prev.differs = true;
          if (o > prev.out) prev.laterMore = true;
        }
        prev.out = o;
        prev.sig = sig;
        prev.lastString = typeof sr === "string";
      }
    }
  }
}

const rep = { ids: byId.size, repeat: 0, differ: 0, laterMore: 0, firstNullLastString: 0, crossFile: 0 };
for (const r of byId.values()) {
  if (r.n < 2) continue;
  rep.repeat++;
  if (r.differs) rep.differ++;
  if (r.laterMore) rep.laterMore++;
  if (r.firstNull && r.lastString) rep.firstNullLastString++;
  if (r.files.size > 1) rep.crossFile++;
}

// ---------------------------------------------------------------- report

const gb = (n) => (n / 1e9).toFixed(2);
emit("# Claude Code log schema probe (shape only)");
emit();
emit("## Layout (projects folder)");
emit(`- project (slug) folders: ${layout.slugs}; other top-level entries: ${layout.otherTop}; symlinks skipped: ${layout.symlinks}; unreadable folders: ${layout.unreadableDirs}`);
emit(`- .jsonl files: ${layout.files.length} (main, depth 2: ${layout.mainFiles}, of which stem not a UUID: ${layout.mainNotUuid}; nested: ${layout.nestedFiles}; deepest: ${layout.depthMax}); other files: ${layout.otherFiles}`);
emit("- folders by depth and kind:");
for (const [k, n] of [...layout.dirs].sort()) emit(`  - ${k}: ${n}`);
emit(`- bytes modified in the last 7, 30 and 90 days (GB): ${gb(recent.d7)}, ${gb(recent.d30)} and ${gb(recent.d90)}; files modified in the last 5 minutes: ${recent.min5}`);
emit();
emit("## Lines");
emit(`- lines: ${lines.total}; valid JSON objects: ${lines.valid}; over 16 MiB (not decoded): ${lines.tooLong}; CRLF: ${lines.crlf}; unreadable files: ${lines.unreadable}`);
emit(`- without a type key: ${lines.noType} (in vercel-plugin: ${lines.noTypeInPlugin})`);
emit(`- byte offset of the type key: ${stats(typeOffsets)}`);
emit(`- first two keys: ${fmt(firstKeys)}`);
emit(`- lines over 1 MiB by type: ${fmt(over1MiB)}`);
emit();
emit("## Line types");
emit("| type | lines |");
emit("|---|---|");
for (const [t, n] of [...typeCounts].sort((x, y) => y[1] - x[1])) emit(`| ${t} | ${n} |`);
emit();
emit("## Gate safety");
emit(`- lines of another type containing "type":"assistant": ${gate.assistantInOther}`);
emit(`- user lines: largest end offset of "type":"user" ${gate.userMaxOffset + NEEDLE_USER.length}; past 152 bytes: ${gate.userOver152}; past 256 bytes: ${gate.userOver256}`);
emit(`- lines of another type containing "usage":{ — ${fmt(gate.usageInOther)}`);
emit();
emit("## Assistant lines");
emit(`- lines: ${a.lines}; size (bytes): ${stats(a.sizes)}`);
emit(`- message.model: ${fmt(a.model)}`);
emit(`- message.id length: ${fmt(a.idLen)}; outside [A-Za-z0-9_-]: ${a.idBadChars}; missing: ${a.idMissing}`);
emit(`- requestId length: ${fmt(a.reqLen)}`);
emit(`- message.stop_reason: ${fmt(a.stop)}`);
emit(`- message.usage ints present: ${USAGE_FIELDS.map((f) => `${f} ${a.usage.get(f)}`).join(", ")}; output_tokens_details.thinking_tokens: ${a.thinking}`);
emit(`- timestamp shapes: ${fmt(a.ts)}`);
emit(`- sessionId UUID: ${a.sessionUuid}; cwd absolute: ${a.cwdAbsolute}; isSidechain true: ${a.sidechain}; with agentId: ${a.agentId}; with costUSD: ${a.costUSD}`);
emit(`- all four token counts 0 or absent: ${a.zero} (model <synthetic>: ${a.zeroSynthetic})`);
emit(`- nested-file lines whose sessionId equals the session folder: ${a.nestedSessionMatch} of ${a.nested}`);
emit(`- message.content[].type: ${fmt(contentTypes)}`);
emit();
emit("## Repeated message ids");
emit(`- distinct ids: ${rep.ids}; ids on more than one line: ${rep.repeat}; repeats whose usage differs: ${rep.differ}; of those, a later line with more output: ${rep.laterMore}`);
emit(`- repeats whose first line has stop_reason null and last a string: ${rep.firstNullLastString}; repeats spanning more than one file: ${rep.crossFile}`);
emit();
emit("## Top-level keys by type");
emit("| type | key | types |");
emit("|---|---|---|");
for (const [k, m] of [...envelope].sort()) {
  const [t, key] = k.split(" ");
  emit(`| ${t} | ${key} | ${fmt(m)} |`);
}
emit();
emit("## Assistant key paths (content, input, text, thinking, signature, cwd and similar subtrees skipped)");
emit("| path | types |");
emit("|---|---|");
for (const [p, m] of [...assistantPaths].sort()) emit(`| ${p} | ${fmt(m)} |`);

// Privacy guard: nothing printed may look like a path.
if (out.some((line) => line.split(/\s+/).some((token) => token.includes("/")))) {
  console.error("claude-schema-probe: aborted, a printed token contained '/'; nothing was printed");
  process.exit(1);
}
console.log(out.join("\n"));
