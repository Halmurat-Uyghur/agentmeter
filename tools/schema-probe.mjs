#!/usr/bin/env node
// Dev-only, shape-only probe of Copilot session logs (plan §3, rules in §4 "Tests").
//
// Prints key paths, value types, counts, sizes and a small allowlist of enum values
// (event type names, Copilot versions, producer). Never prints a field value, a
// folder or file name, the root path, or a model id. It:
//   - opens only `<root>/session-state/<folder>/events.jsonl`; everything else is readdir/lstat;
//   - walks `data` key paths only for the usage/session event types below;
//   - skips the `context` and `codeChanges` subtrees;
//   - masks every child key of a map keyed by data (DATA_KEYED: modelMetrics and
//     providerModelMetrics → <model>, toolCounts → <tool>, agentMetrics → <agent>,
//     usageAccountingWatermarks → <key>), so no model, tool or agent name is printed;
//   - masks other UUID-shaped keys as <uuid> and any other non-identifier key as <key>;
//   - aborts, printing nothing, if any output token contains "/".
//
// Root: $COPILOT_HOME (~ expanded, relative → home) or ~/.copilot.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const TYPE_NAME = /^[a-z][a-z_]{0,39}(\.[a-z][a-z_]{0,39}){0,3}$/;
const VERSION = /^(\d{1,3}\.\d{1,3}\.\d{1,4}([-.][A-Za-z0-9.-]{1,20})?|unknown)$/;
const PRODUCER = /^[a-z][a-z-]{0,39}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOCK = /^inuse\.(\d{1,10})\.(lock|hold)$/;
// Only these exact names are ever printed; anything else is counted as <other file> / <other dir>.
const KNOWN_NAMES = new Set([
  "session-state", ".session-operation-locks", "workspace.yaml", "session.db", "checkpoints",
  "research", "files", "events.jsonl", "vscode.metadata.json", "plan.md", "rewind-snapshots",
  "rewind-file-snapshots",
]);
const PREFIX = Buffer.from('{"type":"');
const SKIP_KEYS = new Set(["context", "codeChanges"]);
// Maps keyed by data (model, tool, agent names, session ids): every child key of one of
// these, at any depth of the path, is printed as the mask, never as itself.
const DATA_KEYED = new Map([
  ["modelMetrics", "<model>"],
  ["providerModelMetrics", "<model>"],
  ["toolCounts", "<tool>"],
  ["agentMetrics", "<agent>"],
  ["usageAccountingWatermarks", "<key>"],
]);
const WALK_TYPES = new Set([
  "session.usage_record",
  "session.usage_checkpoint",
  "session.shutdown",
  "session.start",
  "session.resume",
  "assistant.turn_end",
]);
const GATE_STRINGS = ["session.usage_record", "assistant.turn_end"];
const USAGE_FIELDS = [
  ["model", "string"],
  ["inputTokens", "int"],
  ["outputTokens", "int"],
  ["cacheReadTokens", "int"],
  ["cacheWriteTokens", "int"],
  ["reasoningTokens", "int"],
  ["duration", "int"],
  ["copilotUsage.totalNanoAiu", "int"],
  ["accounting.usageId", "string"],
  ["accounting.sequence", "int"],
  ["accounting.sourceSessionId", "string"],
];

function copilotRoot() {
  const env = process.env.COPILOT_HOME;
  if (!env) return join(homedir(), ".copilot");
  const expanded =
    env === "~"
      ? homedir()
      : env.startsWith("~/")
        ? join(homedir(), env.slice(2))
        : env;
  return isAbsolute(expanded) ? expanded : resolve(homedir(), expanded);
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "number";
  return typeof v;
}

function maskKey(key, parentPath) {
  const parent = parentPath.slice(parentPath.lastIndexOf(".") + 1);
  if (DATA_KEYED.has(parent)) return DATA_KEYED.get(parent);
  if (UUID.test(key)) return "<uuid>";
  return IDENT.test(key) ? key : "<key>";
}

function enumValue(v, re) {
  return typeof v === "string" && re.test(v) ? v : "(other)";
}

function get(obj, path) {
  let cur = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function bump(map, key, n = 1) {
  map.set(key, (map.get(key) ?? 0) + n);
}

/** paths: Map<path, Map<type, count>> */
function walk(value, path, paths, depth) {
  if (value === null || typeof value !== "object" || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      const p = `${path}[]`;
      if (!paths.has(p)) paths.set(p, new Map());
      bump(paths.get(p), typeOf(item));
      walk(item, p, paths, depth + 1);
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    const p = `${path}.${maskKey(k, path)}`;
    if (!paths.has(p)) paths.set(p, new Map());
    if (SKIP_KEYS.has(k)) {
      bump(paths.get(p), "(skipped)");
      continue;
    }
    bump(paths.get(p), typeOf(v));
    walk(v, p, paths, depth + 1);
  }
}

function stats(nums) {
  if (nums.length === 0) return "none";
  const s = [...nums].sort((a, b) => a - b);
  return `min ${s[0]}, median ${s[Math.floor(s.length / 2)]}, max ${s[s.length - 1]}`;
}

function fmtTypes(m) {
  return [...m.entries()].map(([t, n]) => `${t} ${n}`).join(", ");
}

// ---------------------------------------------------------------- scan

// Node errors carry absolute paths in their message and stack: print only the code.
function fail(err) {
  const code = err && typeof err.code === "string" && /^[A-Z0-9_]{1,40}$/.test(err.code) ? err.code : "EXCEPTION";
  console.error(`schema-probe: failed (${code})`);
  process.exit(1);
}
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

function entryLabel(name, isDir) {
  if (LOCK.test(name)) return "inuse.<pid>.lock";
  if (KNOWN_NAMES.has(name)) return isDir ? `${name} (dir)` : name;
  return isDir ? "<other dir>" : "<other file>";
}

const root = join(copilotRoot(), "session-state");
const out = [];
const emit = (s = "") => out.push(s);

let entries;
try {
  entries = readdirSync(root, { withFileTypes: true });
} catch {
  console.log("schema-probe: no session-state folder under the Copilot root");
  process.exit(2);
}

const layout = {
  folders: 0,
  withEvents: 0,
  unreadableFolders: 0,
  otherEntries: new Map(),
  folderContents: new Map(),
};
const locks = { total: 0, alive: 0, ages: [], unreadable: 0, badPid: 0 };
const files = [];
for (const e of entries) {
  if (!e.isDirectory() || !UUID.test(e.name)) {
    bump(layout.otherEntries, entryLabel(e.name, e.isDirectory()));
    continue;
  }
  layout.folders++;
  const dir = join(root, e.name);
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch {
    layout.unreadableFolders++;
    continue;
  }
  for (const c of children) {
    const m = LOCK.exec(c.name);
    bump(layout.folderContents, entryLabel(c.name, c.isDirectory()));
    if (m) {
      locks.total++;
      try {
        locks.ages.push(Math.floor((Date.now() - lstatSync(join(dir, c.name)).mtimeMs) / 86_400_000));
      } catch {
        locks.unreadable++;
      }
      const pid = Number(m[1]);
      if (Number.isSafeInteger(pid) && pid >= 1) {
        try {
          process.kill(pid, 0);
          locks.alive++;
        } catch (err) {
          if (err && err.code === "EPERM") locks.alive++;
        }
      } else {
        locks.badPid++;
      }
    }
  }
  const events = join(dir, "events.jsonl");
  try {
    if (lstatSync(events).isFile()) {
      layout.withEvents++;
      files.push({ folderId: e.name, path: events });
    }
  } catch {
    // no events.jsonl in this folder
  }
}

const lines = {
  total: 0,
  valid: 0,
  prefixed: 0,
  crlf: 0,
  badTimestamp: 0,
  outOfOrder: 0,
  duplicateIds: 0,
  unterminatedFiles: 0,
  unreadableFiles: 0,
  longest: 0,
  longestUsage: 0,
};
const sizes = [];
const ids = new Set();
const typeCounts = new Map();
const envelope = new Map();
const dataPaths = new Map(); // type → paths map
const gateHits = new Map(GATE_STRINGS.map((g) => [g, 0]));
const generations = new Map(); // version → counters
const producers = new Map();
const usage = {
  records: 0,
  withAgentId: 0,
  sourceEqualsFolder: 0,
  usageIds: new Set(),
  fields: new Map(
    USAGE_FIELDS.map(([p]) => [p, { ok: 0, zeros: 0, negative: 0 }]),
  ),
  seqSessions: 0,
  seqBroken: 0,
};
const sequences = new Map(); // sourceSessionId → last sequence (in file order)

for (const f of files) {
  let buf;
  try {
    buf = readFileSync(f.path);
  } catch {
    lines.unreadableFiles++;
    continue;
  }
  sizes.push(buf.length);
  if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) lines.unterminatedFiles++;
  const seen = {
    version: "unknown",
    usage: false,
    checkpoint: false,
    shutdown: false,
    shutdownMetrics: false,
  };
  let lastTs = "";
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    const raw = buf.subarray(start, end);
    start = end + 1;
    if (raw.length === 0) continue;
    lines.total++;
    lines.longest = Math.max(lines.longest, raw.length);
    if (raw[raw.length - 1] === 0x0d) lines.crlf++;
    if (raw.subarray(0, PREFIX.length).equals(PREFIX)) lines.prefixed++;
    let ev;
    try {
      ev = JSON.parse(raw.toString("utf8"));
    } catch {
      continue;
    }
    if (ev === null || typeof ev !== "object" || Array.isArray(ev)) continue;
    lines.valid++;
    const type = enumValue(ev.type, TYPE_NAME);
    bump(typeCounts, type);

    for (const [k, v] of Object.entries(ev)) {
      const key = `${type === "session.usage_record" ? "usage" : "all"} ${maskKey(k, "")}`;
      if (!envelope.has(key)) envelope.set(key, new Map());
      bump(envelope.get(key), typeOf(v));
    }

    if (typeof ev.timestamp !== "string" || !TIMESTAMP.test(ev.timestamp))
      lines.badTimestamp++;
    else {
      if (ev.timestamp < lastTs) lines.outOfOrder++;
      lastTs = ev.timestamp;
    }
    if (typeof ev.id === "string") {
      if (ids.has(ev.id)) lines.duplicateIds++;
      ids.add(ev.id);
    }
    for (const g of GATE_STRINGS) {
      if (ev.type !== g && raw.includes(`"${g}"`)) bump(gateHits, g);
    }

    if (WALK_TYPES.has(ev.type)) {
      if (!dataPaths.has(type)) dataPaths.set(type, new Map());
      walk(ev.data, "data", dataPaths.get(type), 0);
    }

    if (ev.type === "session.start") {
      seen.version = enumValue(get(ev, "data.copilotVersion"), VERSION);
      bump(producers, enumValue(get(ev, "data.producer"), PRODUCER));
    } else if (ev.type === "session.usage_checkpoint") {
      seen.checkpoint = true;
    } else if (ev.type === "session.shutdown") {
      seen.shutdown = true;
      const mm = get(ev, "data.modelMetrics");
      if (
        mm &&
        typeof mm === "object" &&
        Object.values(mm).some((m) => m && typeof m.usage === "object")
      ) {
        seen.shutdownMetrics = true;
      }
    } else if (ev.type === "session.usage_record") {
      seen.usage = true;
      usage.records++;
      lines.longestUsage = Math.max(lines.longestUsage, raw.length);
      if ("agentId" in ev) usage.withAgentId++;
      const u = get(ev, "data.usage") ?? {};
      for (const [p, want] of USAGE_FIELDS) {
        const v = get(u, p);
        const c = usage.fields.get(p);
        if (typeOf(v) === want) {
          c.ok++;
          if (want === "int" && v === 0) c.zeros++;
          if (want === "int" && v < 0) c.negative++;
        }
      }
      const usageId = get(u, "accounting.usageId");
      if (typeof usageId === "string") usage.usageIds.add(usageId);
      const source = get(u, "accounting.sourceSessionId");
      if (source === f.folderId) usage.sourceEqualsFolder++;
      const seq = get(u, "accounting.sequence");
      if (typeof source === "string" && Number.isInteger(seq)) {
        const last = sequences.get(source);
        if (last === undefined) usage.seqSessions++;
        else if (seq !== last + 1) usage.seqBroken++;
        sequences.set(source, seq);
      }
    }
  }
  const g = generations.get(seen.version) ?? {
    logs: 0,
    usage: 0,
    checkpoint: 0,
    shutdown: 0,
    shutdownMetrics: 0,
  };
  g.logs++;
  if (seen.usage) g.usage++;
  if (seen.checkpoint) g.checkpoint++;
  if (seen.shutdown) g.shutdown++;
  if (seen.shutdownMetrics) g.shutdownMetrics++;
  generations.set(seen.version, g);
}

// ---------------------------------------------------------------- report

emit("# Copilot log schema probe (shape only)");
emit();
emit("## Layout");
emit(`- session folders (UUID-named): ${layout.folders}`);
emit(`- folders with events.jsonl: ${layout.withEvents}`);
emit(`- unreadable session folders: ${layout.unreadableFolders}; unreadable events.jsonl files: ${lines.unreadableFiles}`);
for (const [k, n] of layout.otherEntries)
  emit(`- other entry in session-state: ${k} × ${n}`);
emit("- folder contents (entries across all folders):");
for (const [k, n] of [...layout.folderContents].sort((a, b) => b[1] - a[1]))
  emit(`  - ${k}: ${n}`);
emit(`- events.jsonl sizes (bytes): ${stats(sizes)}`);
emit(
  `- longest line (bytes): ${lines.longest}; longest usage line: ${lines.longestUsage}`,
);
emit(
  `- lines: ${lines.total}; valid JSON objects: ${lines.valid}; start with the type prefix: ${lines.prefixed}`,
);
emit(
  `- CRLF lines: ${lines.crlf}; files not newline-terminated: ${lines.unterminatedFiles}`,
);
emit(
  `- bad timestamps: ${lines.badTimestamp}; out-of-order timestamps: ${lines.outOfOrder}; duplicate ids: ${lines.duplicateIds}`,
);
emit();
emit("## Lock files");
emit(
  `- inuse lock files: ${locks.total}; owning process alive: ${locks.alive}; invalid pid: ${locks.badPid}; unreadable: ${locks.unreadable}; age in days: ${stats(locks.ages)}`,
);
emit();
emit("## Event types");
emit("| type | lines |");
emit("|---|---|");
for (const [t, n] of [...typeCounts].sort((a, b) => b[1] - a[1]))
  emit(`| ${t} | ${n} |`);
emit();
emit("## Envelope (top-level keys)");
emit("| scope | key | types |");
emit("|---|---|---|");
for (const [k, m] of [...envelope].sort()) {
  const [scope, key] = k.split(" ");
  emit(`| ${scope} | ${key} | ${fmtTypes(m)} |`);
}
emit();
emit("## Format generations (by session.start data.copilotVersion)");
emit(
  "| Copilot version | logs | with usage_record | with usage_checkpoint | with shutdown | shutdown with modelMetrics usage |",
);
emit("|---|---|---|---|---|---|");
for (const [v, g] of [...generations].sort()) {
  emit(
    `| ${v} | ${g.logs} | ${g.usage} | ${g.checkpoint} | ${g.shutdown} | ${g.shutdownMetrics} |`,
  );
}
emit(
  `- producers: ${[...producers].map(([p, n]) => `${p} × ${n}`).join(", ") || "none"}`,
);
emit();
emit("## session.usage_record allowlisted fields (data.usage)");
emit(`- records: ${usage.records}; with agentId: ${usage.withAgentId}`);
emit("| field | expected type | present with that type | zeros | negative |");
emit("|---|---|---|---|---|");
for (const [p, want] of USAGE_FIELDS) {
  const c = usage.fields.get(p);
  emit(
    `| ${p} | ${want} | ${c.ok} of ${usage.records} | ${want === "int" ? c.zeros : "-"} | ${want === "int" ? c.negative : "-"} |`,
  );
}
emit(
  `- distinct accounting.usageId: ${usage.usageIds.size} of ${usage.records}`,
);
emit(
  `- accounting.sourceSessionId equal to the folder id: ${usage.sourceEqualsFolder} of ${usage.records}`,
);
emit(
  `- accounting.sequence: ${usage.seqSessions} source sessions; breaks in a strictly increasing, gap-free run: ${usage.seqBroken}`,
);
emit();
emit("## Gate safety (lines of another type containing the quoted string)");
for (const [g, n] of gateHits) emit(`- ${g}: ${n}`);
emit();
emit("## Data key paths (walked types only; context and codeChanges skipped)");
for (const [t, paths] of [...dataPaths].sort()) {
  emit();
  emit(`### ${t}`);
  emit("| path | types |");
  emit("|---|---|");
  for (const [p, m] of [...paths].sort()) emit(`| ${p} | ${fmtTypes(m)} |`);
}

// Privacy guard: nothing printed may look like a path.
if (
  out.some((line) => line.split(/\s+/).some((token) => token.includes("/")))
) {
  console.error(
    "schema-probe: aborted, a printed token contained '/'; nothing was printed",
  );
  process.exit(1);
}
console.log(out.join("\n"));
