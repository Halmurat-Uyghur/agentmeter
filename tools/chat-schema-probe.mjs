#!/usr/bin/env node
// Dev-only, shape-only probe of VS Code Copilot Chat logs (plan §13 "Task 10", rules in §4 "Tests").
//
// Prints key paths, value types, counts, sizes and a small allowlist of enum values
// (event type names, file-name classes). Never prints a field value, a folder or file
// name, the root path, a model id, a session id or any text. It:
//   - opens only `<root>/<hash>/GitHub.copilot-chat/debug-logs/<session>/*.jsonl` and
//     `<root>/<hash>/chatSessions/*.jsonl`; everything else is readdir/lstat only
//     (never `workspace.json`, `state.vscdb`, transcripts or any other file);
//   - in chatSessions files walks key paths only to depth 3 and, below that, only
//     under keys that look like usage (`token`, `usage`, `model`, `result`, `metadata`),
//     masking array indices and UUID-shaped / non-identifier keys; the keys of a map
//     keyed by data (ID_KEYED: `toolCallResults`, keyed by tool-call id) print as <id>
//     and every key below them as <key>, in key paths and in patch paths alike;
//   - in debug-log events prints the top-level keys and, below them (`attrs` and any
//     other object), only keys in ATTR_KEYS (token, model, version, time, duration and
//     id field names); every other nested key prints as <key>, still counted;
//   - prints a string value only if it passes an enum regex for that one field;
//   - compares the two sources (debug-logs vs ~/.copilot/session-state usage records)
//     by counts only: id equality and (token tuple, ±5 s) matches;
//   - aborts, printing nothing, if any output token contains "/" or "\".
//
// Root: $VSCODE_WORKSPACE_STORAGE, else every existing platform default (macOS, Linux,
// Windows, remote server; stable and Insiders). Copilot root: $COPILOT_HOME or ~/.copilot.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEXHASH = /^[0-9a-f]{16,64}$/i;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const EVENT_NAME = /^[a-z][a-zA-Z_]{0,39}(\.[a-z][a-zA-Z_]{0,39}){0,3}$/;
const MODEL_OK = /^[A-Za-z0-9._:\/-]{1,100}$/; // same allowlist as §4; never printed
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const ISO_OFF = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}:\d{2}$/;
const USAGEISH = /token|usage|model|result|metadata|timing|aiu/i;
const TS_KEYS = new Set(["ts", "timestamp", "time", "startTime", "endTime", "creationDate", "lastMessageDate"]);
const TOKEN_ATTRS = ["inputTokens", "outputTokens", "cachedTokens", "copilotUsageNanoAiu"];
// Debug-log events: the only nested key names (in `attrs` or any other object below the
// top level) that are printed; any other key there may be data (a tool or file name) and
// prints as <key>.
const ATTR_KEYS = new Set([
  ...TOKEN_ATTRS, ...TS_KEYS,
  "model", "copilotVersion", "vscodeVersion",
  "promptTokens", "completionTokens", "totalTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens",
  "duration", "durationMs", "elapsedMs", "totalElapsed",
  "id", "spanId", "parentSpanId", "sid", "sessionId", "requestId",
]);
// chatSessions: maps keyed by data (ids), at any depth of a key path or patch path.
const ID_KEYED = new Set(["toolCallResults"]);

// ---------------------------------------------------------------- helpers

function fail(err) {
  const code = err && typeof err.code === "string" && /^[A-Z0-9_]{1,40}$/.test(err.code) ? err.code : "EXCEPTION";
  console.error(`chat-schema-probe: failed (${code})`);
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
  if (/^\d+$/.test(k)) return "<n>";
  return IDENT.test(k) ? k : "<key>";
}
function attrKey(k) {
  return ATTR_KEYS.has(k) ? k : "<key>";
}
function bump(map, key, n = 1) {
  map.set(key, (map.get(key) ?? 0) + n);
}
function pathBump(paths, p, t) {
  if (!paths.has(p)) paths.set(p, new Map());
  bump(paths.get(p), t);
}
function stats(nums) {
  if (nums.length === 0) return "none";
  const s = [...nums].sort((a, b) => a - b);
  return `min ${s[0]}, median ${s[Math.floor(s.length / 2)]}, max ${s[s.length - 1]}`;
}
function fmtTypes(m) {
  return [...m.entries()].map(([t, n]) => `${t} ${n}`).join(", ");
}
function tsClass(v) {
  if (typeof v === "number") {
    if (Number.isInteger(v) && v > 1.5e12 && v < 2.5e12) return "epoch-ms";
    if (Number.isInteger(v) && v > 1.5e9 && v < 2.5e9) return "epoch-s";
    return "number-other";
  }
  if (typeof v === "string") {
    if (ISO_Z.test(v)) return "iso-Z";
    if (ISO_OFF.test(v)) return "iso-offset";
    return "string-other";
  }
  return typeOf(v);
}
function tsMs(v) {
  const c = tsClass(v);
  if (c === "epoch-ms") return v;
  if (c === "epoch-s") return v * 1000;
  if (c === "iso-Z" || c === "iso-offset") return Date.parse(v);
  return undefined;
}

/** Key-path walk for debug-log events: nested keys print only when in ATTR_KEYS. */
function walk(value, path, paths, depth, maxDepth) {
  if (value === null || typeof value !== "object" || depth >= maxDepth) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      pathBump(paths, `${path}[]`, typeOf(item));
      walk(item, `${path}[]`, paths, depth + 1, maxDepth);
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    const p = `${path}.${attrKey(k)}`;
    pathBump(paths, p, typeOf(v));
    walk(v, p, paths, depth + 1, maxDepth);
  }
}
/**
 * Restricted walk for chatSessions: shallow everywhere, deeper only under usage-like keys.
 * idState: 0 normal; 1 this object's keys are ids (<id>); 2 below an id (every key <key>).
 */
function walkChat(value, path, paths, depth, usageBranch, idState = 0) {
  if (value === null || typeof value !== "object" || depth > 9) return;
  if (!usageBranch && depth >= 4) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      pathBump(paths, `${path}[]`, typeOf(item));
      walkChat(item, `${path}[]`, paths, depth + 1, usageBranch, idState);
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    const p = `${path}.${idState === 1 ? "<id>" : idState === 2 ? "<key>" : maskKey(k)}`;
    pathBump(paths, p, typeOf(v));
    const next = idState > 0 ? 2 : ID_KEYED.has(k) ? 1 : 0;
    walkChat(v, p, paths, depth + 1, usageBranch || (idState === 0 && USAGEISH.test(k)), next);
  }
}

// ---------------------------------------------------------------- roots

function storageRoots() {
  const env = process.env.VSCODE_WORKSPACE_STORAGE;
  if (env) {
    const e = env.startsWith("~/") ? join(homedir(), env.slice(2)) : env;
    return [{ label: "env", path: isAbsolute(e) ? e : resolve(homedir(), e) }];
  }
  const h = homedir();
  const out = [];
  for (const product of ["Code", "Code - Insiders"]) {
    const tag = product === "Code" ? "stable" : "insiders";
    if (platform() === "darwin") out.push({ label: `macos-${tag}`, path: join(h, "Library", "Application Support", product, "User", "workspaceStorage") });
    else if (platform() === "win32") out.push({ label: `windows-${tag}`, path: join(process.env.APPDATA ?? join(h, "AppData", "Roaming"), product, "User", "workspaceStorage") });
    else out.push({ label: `linux-${tag}`, path: join(h, ".config", product, "User", "workspaceStorage") });
  }
  out.push({ label: "remote-stable", path: join(h, ".vscode-server", "data", "User", "workspaceStorage") });
  out.push({ label: "remote-insiders", path: join(h, ".vscode-server-insiders", "data", "User", "workspaceStorage") });
  return out;
}
function copilotRoot() {
  const env = process.env.COPILOT_HOME;
  if (!env) return join(homedir(), ".copilot");
  const e = env === "~" ? homedir() : env.startsWith("~/") ? join(homedir(), env.slice(2)) : env;
  return isAbsolute(e) ? e : resolve(homedir(), e);
}
function ls(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return err && err.code === "ENOENT" ? null : "unreadable";
  }
}
function isFile(p) {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}
function debugFileClass(name) {
  if (name === "main.jsonl") return "main.jsonl";
  if (/^runSubagent-.+\.jsonl$/.test(name)) return "runSubagent-*.jsonl";
  if (/^title-.+\.jsonl$/.test(name)) return "title-*.jsonl";
  if (name.endsWith(".jsonl")) return "<other>.jsonl";
  const ext = /\.([a-z]{1,5})$/.exec(name);
  return ext ? `<other>.${ext[1]}` : "<other file>";
}

// ---------------------------------------------------------------- layout

const out = [];
const emit = (s = "") => out.push(s);
const layout = {
  roots: new Map(),
  hashFolders: 0, hashNameShape: new Map(), withChatSessions: 0, withCopilotChat: 0, withDebugLogs: 0,
  copilotChatEntries: new Map(), debugSessionDirs: 0, debugSessionNameShape: new Map(), debugFiles: new Map(),
  debugSessionWithoutMain: 0, chatFiles: 0, chatOtherEntries: 0, unreadable: 0,
};
const debugFiles = []; // {path, cls, sessionName}
const chatFiles = [];
for (const r of storageRoots()) {
  const entries = ls(r.path);
  layout.roots.set(r.label, entries === null ? "absent" : entries === "unreadable" ? "unreadable" : "present");
  if (!Array.isArray(entries)) continue;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    layout.hashFolders++;
    bump(layout.hashNameShape, HEXHASH.test(e.name) ? "hex hash" : "other");
    const ws = join(r.path, e.name);
    const chat = ls(join(ws, "chatSessions"));
    if (Array.isArray(chat)) {
      layout.withChatSessions++;
      for (const c of chat) {
        if (c.isFile() && c.name.endsWith(".jsonl")) chatFiles.push(join(ws, "chatSessions", c.name));
        else layout.chatOtherEntries++;
      }
    } else if (chat === "unreadable") layout.unreadable++;
    const cc = ls(join(ws, "GitHub.copilot-chat"));
    if (!Array.isArray(cc)) continue;
    layout.withCopilotChat++;
    for (const c of cc) bump(layout.copilotChatEntries, ["debug-logs", "transcripts", "chat-session-resources"].includes(c.name) ? `${c.name}${c.isDirectory() ? " (dir)" : ""}` : c.isDirectory() ? "<other dir>" : "<other file>");
    const dl = ls(join(ws, "GitHub.copilot-chat", "debug-logs"));
    if (!Array.isArray(dl)) continue;
    layout.withDebugLogs++;
    for (const s of dl) {
      if (!s.isDirectory()) continue;
      layout.debugSessionDirs++;
      bump(layout.debugSessionNameShape, UUID.test(s.name) ? "uuid" : "other");
      const files = ls(join(ws, "GitHub.copilot-chat", "debug-logs", s.name));
      if (!Array.isArray(files)) { layout.unreadable++; continue; }
      let hasMain = false;
      for (const f of files) {
        const cls = f.isFile() ? debugFileClass(f.name) : "<dir>";
        bump(layout.debugFiles, cls);
        if (cls === "main.jsonl") hasMain = true;
        if (cls.endsWith(".jsonl") && isFile(join(ws, "GitHub.copilot-chat", "debug-logs", s.name, f.name)))
          debugFiles.push({ path: join(ws, "GitHub.copilot-chat", "debug-logs", s.name, f.name), cls, sessionName: s.name });
      }
      if (!hasMain) layout.debugSessionWithoutMain++;
    }
  }
}

// ---------------------------------------------------------------- copilot session-state (for overlap only)

const cliFolderIds = new Set();
const cliRecords = []; // {ms, input, output, cacheRead}
{
  const ss = join(copilotRoot(), "session-state");
  const dirs = ls(ss);
  if (Array.isArray(dirs)) {
    for (const d of dirs) {
      if (!d.isDirectory() || !UUID.test(d.name)) continue;
      cliFolderIds.add(d.name.toLowerCase());
      const p = join(ss, d.name, "events.jsonl");
      if (!isFile(p)) continue;
      let buf;
      try { buf = readFileSync(p); } catch { continue; }
      let start = 0;
      const gate = Buffer.from('{"type":"session.usage_record"');
      while (start < buf.length) {
        let end = buf.indexOf(0x0a, start);
        if (end === -1) end = buf.length;
        if (buf.subarray(start, start + gate.length).equals(gate)) {
          try {
            const ev = JSON.parse(buf.subarray(start, end).toString("utf8"));
            const u = ev?.data?.usage ?? {};
            cliRecords.push({ ms: Date.parse(ev.timestamp), input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadTokens });
          } catch { /* ignore */ }
        }
        start = end + 1;
      }
    }
  }
}

// ---------------------------------------------------------------- debug-logs

const dbg = {
  files: new Map(), bytes: [], lines: 0, valid: 0, crlf: 0, unterminated: 0, unreadable: 0, longest: 0,
  firstBytes: new Map(), // first 2–12 bytes class: '{"<key>":' with key allowlisted
  topKeys: new Map(), typeField: new Map(), eventNames: new Map(),
  attrsPaths: new Map(), // eventName → paths
  llm: { n: 0, fields: new Map(TOKEN_ATTRS.map((k) => [k, { int: 0, zero: 0, neg: 0, other: 0, absent: 0 }])),
    model: { ok: 0, bad: 0, absent: 0 }, distinctModels: new Set(), ts: new Map(), idKeys: new Map(),
    ids: new Set(), dupIds: 0, outOfOrder: 0, nameInOtherLines: 0 },
  versions: new Map(), sessionIdEqualsDir: 0, sessionIdPresent: 0, dirIsCliFolder: 0, anyStringIsCliFolder: 0,
  overlap: { tuple5s: 0, tupleAny: 0, inputOnly5s: 0 },
};
const llmRecords = [];
const NAME_KEYS = ["type", "name", "event", "kind"];
for (const f of debugFiles) {
  let buf;
  try { buf = readFileSync(f.path); } catch { dbg.unreadable++; continue; }
  bump(dbg.files, f.cls);
  dbg.bytes.push(buf.length);
  if (buf.length && buf[buf.length - 1] !== 0x0a) dbg.unterminated++;
  if (f.cls === "main.jsonl" && cliFolderIds.has(f.sessionName.toLowerCase())) dbg.dirIsCliFolder++;
  let start = 0, lastMs = -Infinity;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    const raw = buf.subarray(start, end);
    start = end + 1;
    if (!raw.length) continue;
    dbg.lines++;
    dbg.longest = Math.max(dbg.longest, raw.length);
    if (raw[raw.length - 1] === 0x0d) dbg.crlf++;
    const m = /^\{"([A-Za-z_]{1,20})":/.exec(raw.subarray(0, 24).toString("latin1"));
    bump(dbg.firstBytes, `${f.cls}: ${m ? `{"${m[1]}":` : "(other)"}`);
    let ev;
    try { ev = JSON.parse(raw.toString("utf8")); } catch { continue; }
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) continue;
    dbg.valid++;
    for (const [k, v] of Object.entries(ev)) pathBump(dbg.topKeys, `${f.cls} ${maskKey(k)}`, typeOf(v));
    let name = "(none)";
    for (const nk of NAME_KEYS) {
      if (typeof ev[nk] === "string") {
        bump(dbg.typeField, `${f.cls} ${nk}`);
        if (name === "(none)") name = EVENT_NAME.test(ev[nk]) ? ev[nk] : "(other)";
      }
    }
    bump(dbg.eventNames, `${f.cls} ${name}`);
    if (name === "session_start" && ev.attrs) {
      const V = /^\d{1,3}\.\d{1,3}\.\d{1,4}([-.][A-Za-z0-9.-]{1,20})?$/;
      bump(dbg.versions, `copilotVersion ${V.test(ev.attrs.copilotVersion) ? ev.attrs.copilotVersion : "(other)"}`);
      bump(dbg.versions, `vscodeVersion ${V.test(ev.attrs.vscodeVersion) ? ev.attrs.vscodeVersion : "(other)"}`);
      const ms = tsMs(ev.ts);
      const d = new Date();
      bump(dbg.versions, `started ${ms === undefined ? "no-ts" : ms >= new Date(d.getFullYear(), d.getMonth(), 1).getTime() ? "this-month" : "before-this-month"}`);
    }
    if (!dbg.attrsPaths.has(name)) dbg.attrsPaths.set(name, new Map());
    for (const [k, v] of Object.entries(ev)) {
      if (NAME_KEYS.includes(k)) continue;
      // full walk only for llm_request / session / turn markers; others: top level of each object
      const deep = /llm|request|session|turn|child|usage/i.test(name);
      pathBump(dbg.attrsPaths.get(name), maskKey(k), typeOf(v));
      walk(v, maskKey(k), dbg.attrsPaths.get(name), 0, deep ? 4 : 1);
    }
    // timestamps
    let evMs;
    for (const k of Object.keys(ev)) if (TS_KEYS.has(k) && evMs === undefined) evMs = tsMs(ev[k]);
    if (name !== "llm_request") {
      if (raw.includes('"llm_request"')) dbg.llm.nameInOtherLines++;
      continue;
    }
    dbg.llm.n++;
    const a = ev.attrs && typeof ev.attrs === "object" ? ev.attrs : {};
    for (const k of TOKEN_ATTRS) {
      const c = dbg.llm.fields.get(k);
      const v = a[k];
      if (v === undefined) c.absent++;
      else if (Number.isSafeInteger(v)) { c.int++; if (v === 0) c.zero++; if (v < 0) c.neg++; }
      else c.other++;
    }
    if (a.model === undefined) dbg.llm.model.absent++;
    else if (typeof a.model === "string" && MODEL_OK.test(a.model)) { dbg.llm.model.ok++; dbg.llm.distinctModels.add(a.model); }
    else dbg.llm.model.bad++;
    for (const k of Object.keys(ev)) if (TS_KEYS.has(k)) bump(dbg.llm.ts, `top.${k} ${tsClass(ev[k])}`);
    for (const k of Object.keys(a)) if (TS_KEYS.has(k)) bump(dbg.llm.ts, `attrs.${k} ${tsClass(a[k])}`);
    for (const [k, v] of [...Object.entries(ev).map(([k, v]) => [`top.${k}`, v]), ...Object.entries(a).map(([k, v]) => [`attrs.${k}`, v])]) {
      if (/id$/i.test(k) && typeof v === "string") {
        bump(dbg.llm.idKeys, `${k.split(".")[0]}.${k.startsWith("attrs.") ? attrKey(k.slice(6)) : maskKey(k.slice(4))} ${UUID.test(v) ? "uuid" : "string"}`);
        if (cliFolderIds.has(v.toLowerCase())) dbg.anyStringIsCliFolder++;
        if (/session/i.test(k)) { dbg.sessionIdPresent++; if (v === f.sessionName) dbg.sessionIdEqualsDir++; }
      }
    }
    for (const k of ["spanId", "id", "requestId"]) {
      const v = ev[k] ?? a[k];
      if (typeof v === "string") { if (dbg.llm.ids.has(v)) dbg.llm.dupIds++; dbg.llm.ids.add(v); break; }
    }
    if (evMs !== undefined) { if (evMs < lastMs) dbg.llm.outOfOrder++; lastMs = evMs; }
    llmRecords.push({ ms: evMs, input: a.inputTokens, output: a.outputTokens, cached: a.cachedTokens });
  }
}
// overlap: same input+output tokens (cached == cacheRead when both present) within ±5 s, or at any time
for (const r of llmRecords) {
  if (!Number.isSafeInteger(r.input) || !Number.isSafeInteger(r.output)) continue;
  const same = cliRecords.filter((c) => c.input === r.input && c.output === r.output && (r.cached === undefined || c.cacheRead === undefined || r.cached === c.cacheRead));
  if (same.length) dbg.overlap.tupleAny++;
  if (r.ms !== undefined && same.some((c) => Math.abs(c.ms - r.ms) <= 5000)) dbg.overlap.tuple5s++;
  if (r.ms !== undefined && cliRecords.some((c) => c.input === r.input && Math.abs(c.ms - r.ms) <= 5000)) dbg.overlap.inputOnly5s++;
}
// llm_request per day (counts only, to see recency)
const now = Date.now();
const recency = { today: 0, last7: 0, thisMonth: 0, older: 0, noTs: 0 };
{
  const d = new Date(now);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  for (const r of llmRecords) {
    if (r.ms === undefined || !Number.isFinite(r.ms)) recency.noTs++;
    else if (r.ms >= dayStart) recency.today++;
    else if (r.ms >= monthStart) recency.thisMonth++;
    else if (r.ms >= now - 7 * 86_400_000) recency.last7++;
    else recency.older++;
  }
}

// ---------------------------------------------------------------- chatSessions

const TOKEN_PATCH = /^\{"kind":1,"k":\["requests",\d{1,6},"(promptTokens|completionTokens|elapsedMs|modelState|outputBuffer)"\],"v":/;
const chat = {
  gate: new Map(),
  files: 0, bytes: [], lines: 0, valid: 0, longest: 0, kinds: new Map(), paths: new Map(), unreadable: 0,
  kShapes: new Map(), kind2Applied: 0, kind2Unapplied: 0, patchNoParent: 0, filesWithRequests: 0, sessionIsCliFolder: 0,
  lineSizes: new Map(),
  req: {
    n: 0, fields: new Map(), rounds: [], roundModel: { ok: 0, bad: 0 }, ptEqual: 0, ptDiffer: 0, ctEqual: 0, ctDiffer: 0,
    models: new Map(), modelEqual: 0, modelDiffer: 0, ts: new Map(), state: new Map(), agents: new Map(), modes: new Map(),
    ids: new Set(), dupIds: 0, metaSessionIsCli: 0, responseIds: 0, recency: { today: 0, month: 0, older: 0, noTs: 0 },
    overlapAny: 0, overlap5s: 0, cliRecordWithin5s: 0,
  },
};
for (const p of chatFiles) {
  let buf;
  let state;
  try { buf = readFileSync(p); } catch { chat.unreadable++; continue; }
  chat.files++;
  chat.bytes.push(buf.length);
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    const raw = buf.subarray(start, end);
    start = end + 1;
    if (!raw.length) continue;
    chat.lines++;
    chat.longest = Math.max(chat.longest, raw.length);
    let ev;
    try { ev = JSON.parse(raw.toString("utf8")); } catch { continue; }
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) continue;
    chat.valid++;
    const kind = Number.isInteger(ev.kind) && ev.kind >= 0 && ev.kind < 10 ? `kind=${ev.kind}` : "kind=(other)";
    bump(chat.kinds, kind);
    if (!chat.lineSizes.has(kind)) chat.lineSizes.set(kind, []);
    chat.lineSizes.get(kind).push(raw.length);
    const head = raw.subarray(0, 80).toString("latin1");
    const g = TOKEN_PATCH.exec(head);
    if (g) bump(chat.gate, `byte gate {"kind":1,"k":["requests",<n>,"${g[1]}"],"v": → ${typeOf(ev.v)}`);
    else if (/"(promptTokens|completionTokens)"/.test(head) && ev.kind === 1) bump(chat.gate, "token patch NOT matching byte gate");
    if (!chat.paths.has(kind)) chat.paths.set(kind, new Map());
    // A patch whose path k reaches into an id-keyed map: walk its v with that id state.
    const kState = Array.isArray(ev.k) ? idStateAfter(ev.k) : 0;
    if (kState > 0 && ev.v && typeof ev.v === "object") {
      const { v, ...rest } = ev;
      walkChat(rest, "", chat.paths.get(kind), 0, false);
      pathBump(chat.paths.get(kind), ".v", typeOf(v));
      walkChat(v, ".v", chat.paths.get(kind), 1, true, kState);
    } else walkChat(ev, "", chat.paths.get(kind), 0, false);
    if (Array.isArray(ev.k)) bump(chat.kShapes, `${kind} k=${kShape(ev.k)} v:${typeOf(ev.v)}`);
    // Replay: kind 0 = full snapshot, kind 1 = set value at path k, kind 2 = append array v at path k.
    if (ev.kind === 0 && ev.v && typeof ev.v === "object") state = ev.v;
    else if (state && Array.isArray(ev.k) && ev.k.length) {
      const parent = getPath(state, ev.k.slice(0, -1));
      const last = ev.k[ev.k.length - 1];
      if (parent && typeof parent === "object") {
        if (ev.kind === 1) parent[last] = ev.v;
        else if (ev.kind === 2) {
          const target = parent[last];
          if (Array.isArray(target) && Array.isArray(ev.v)) {
            if (Number.isInteger(ev.i)) target.splice(ev.i, target.length - ev.i, ...ev.v);
            else target.push(...ev.v);
            chat.kind2Applied++;
          } else chat.kind2Unapplied++;
        }
      } else chat.patchNoParent++;
    }
  }
  if (state && Array.isArray(state.requests)) {
    chat.filesWithRequests++;
    const sid = typeof state.sessionId === "string" ? state.sessionId.toLowerCase() : undefined;
    if (sid && cliFolderIds.has(sid)) chat.sessionIsCliFolder++;
    for (const r of state.requests) analyzeRequest(r);
  }
}
function kShape(k) {
  let idState = 0;
  return k.map((x) => {
    if (Number.isInteger(x)) return "<n>";
    const shown = idState === 1 ? "<id>" : idState === 2 ? "<key>" : typeof x === "string" && IDENT.test(x) ? x : "<key>";
    idState = idState > 0 ? 2 : ID_KEYED.has(x) ? 1 : 0;
    return shown;
  }).join(".");
}
/** The walkChat id state of the value at patch path k (array indices keep the state). */
function idStateAfter(k) {
  let idState = 0;
  for (const x of k) if (!Number.isInteger(x)) idState = idState > 0 ? 2 : ID_KEYED.has(x) ? 1 : 0;
  return idState;
}
function getPath(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}
function intField(name, v) {
  const c = chat.req.fields.get(name) ?? { int: 0, zero: 0, other: 0, absent: 0 };
  chat.req.fields.set(name, c);
  if (v === undefined) c.absent++;
  else if (Number.isSafeInteger(v) && v >= 0) { c.int++; if (v === 0) c.zero++; }
  else c.other++;
  return Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}
function analyzeRequest(r) {
  if (!r || typeof r !== "object") return;
  const q = chat.req;
  q.n++;
  const meta = r.result?.metadata ?? {};
  const pt = intField("requests[].promptTokens", r.promptTokens);
  const ct = intField("requests[].completionTokens", r.completionTokens);
  const mpt = intField("requests[].result.metadata.promptTokens", meta.promptTokens);
  const mot = intField("requests[].result.metadata.outputTokens", meta.outputTokens);
  intField("requests[].elapsedMs", r.elapsedMs);
  intField("requests[].result.timings.totalElapsed", r.result?.timings?.totalElapsed);
  const rounds = Array.isArray(meta.toolCallRounds) ? meta.toolCallRounds : [];
  q.rounds.push(rounds.length);
  for (const rd of rounds) {
    intField("toolCallRounds[].thinking.tokens", rd?.thinking?.tokens);
    if (typeof rd?.modelId === "string") q.roundModel[MODEL_OK.test(rd.modelId) ? "ok" : "bad"]++;
  }
  if (pt !== undefined && mpt !== undefined) q[pt === mpt ? "ptEqual" : "ptDiffer"]++;
  if (ct !== undefined && mot !== undefined) q[ct === mot ? "ctEqual" : "ctDiffer"]++;
  for (const [k, v] of [["modelId", r.modelId], ["result.metadata.resolvedModel", meta.resolvedModel]]) {
    const c = q.models.get(k) ?? { ok: 0, bad: 0, absent: 0, distinct: new Set() };
    q.models.set(k, c);
    if (v === undefined) c.absent++;
    else if (typeof v === "string" && MODEL_OK.test(v)) { c.ok++; c.distinct.add(v); }
    else c.bad++;
  }
  if (typeof r.modelId === "string" && typeof meta.resolvedModel === "string") q[r.modelId === meta.resolvedModel ? "modelEqual" : "modelDiffer"]++;
  bump(q.ts, `timestamp ${tsClass(r.timestamp)}`);
  bump(q.ts, `modelState.completedAt ${tsClass(r.modelState?.completedAt)}`);
  if (Number.isInteger(r.modelState?.value) && r.modelState.value >= 0 && r.modelState.value < 10) bump(q.state, `modelState.value=${r.modelState.value}`);
  const agentId = r.agent?.id;
  bump(q.agents, typeof agentId === "string" && /^[a-z][a-zA-Z0-9.-]{0,60}$/.test(agentId) ? agentId : agentId === undefined ? "(none)" : "(other)");
  const mode = r.modeInfo?.kind ?? r.modeInfo?.modeId;
  bump(q.modes, typeof mode === "string" && /^[a-z][a-zA-Z-]{0,20}$/.test(mode) ? mode : mode === undefined ? "(none)" : "(other)");
  if (typeof r.requestId === "string") { if (q.ids.has(r.requestId)) q.dupIds++; q.ids.add(r.requestId); }
  if (typeof meta.sessionId === "string" && cliFolderIds.has(meta.sessionId.toLowerCase())) q.metaSessionIsCli++;
  if (typeof meta.responseId === "string") q.responseIds++;
  const ms = tsMs(r.timestamp);
  const d = new Date();
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  if (ms === undefined) q.recency.noTs++;
  else if (ms >= dayStart) q.recency.today++;
  else if (ms >= monthStart) q.recency.month++;
  else q.recency.older++;
  const done = tsMs(r.modelState?.completedAt) ?? ms;
  const inTok = pt ?? mpt, outTok = ct ?? mot;
  if (inTok !== undefined && outTok !== undefined) {
    const same = cliRecords.filter((c) => c.input === inTok && c.output === outTok);
    if (same.length) q.overlapAny++;
    if (done !== undefined && same.some((c) => Math.abs(c.ms - done) <= 5000)) q.overlap5s++;
  }
  if (done !== undefined && cliRecords.some((c) => Math.abs(c.ms - done) <= 5000)) q.cliRecordWithin5s++;
}

// ---------------------------------------------------------------- report

emit("# VS Code Copilot Chat log probe (shape only)");
emit();
emit("## Roots");
for (const [k, v] of layout.roots) emit(`- ${k}: ${v}`);
emit();
emit("## Layout");
emit(`- workspace folders: ${layout.hashFolders}${layout.hashFolders ? ` (${fmtTypes(layout.hashNameShape)})` : ""}; unreadable dirs: ${layout.unreadable}`);
emit(`- with chatSessions: ${layout.withChatSessions}; chatSessions *.jsonl files: ${chatFiles.length}; other entries: ${layout.chatOtherEntries}`);
emit(`- with GitHub.copilot-chat: ${layout.withCopilotChat}; with debug-logs: ${layout.withDebugLogs}`);
emit(`- GitHub.copilot-chat entries: ${fmtTypes(layout.copilotChatEntries) || "none"}`);
emit(`- debug-log session dirs: ${layout.debugSessionDirs} (${fmtTypes(layout.debugSessionNameShape) || "none"}); without main.jsonl: ${layout.debugSessionWithoutMain}`);
emit(`- debug-log files: ${fmtTypes(layout.debugFiles) || "none"}`);
emit();
emit("## debug-logs lines");
emit(`- files read: ${fmtTypes(dbg.files) || "none"}; unreadable: ${dbg.unreadable}; not newline-terminated: ${dbg.unterminated}`);
emit(`- sizes (bytes): ${stats(dbg.bytes)}; longest line: ${dbg.longest}`);
emit(`- lines: ${dbg.lines}; valid JSON objects: ${dbg.valid}; CRLF: ${dbg.crlf}`);
emit("- first key of each line:");
for (const [k, n] of dbg.firstBytes) emit(`  - ${k} × ${n}`);
emit("- top-level keys:");
for (const [k, m] of dbg.topKeys) emit(`  - ${k}: ${fmtTypes(m)}`);
emit(`- string name fields: ${fmtTypes(dbg.typeField) || "none"}`);
emit("- event names:");
for (const [k, n] of [...dbg.eventNames].sort((a, b) => b[1] - a[1])) emit(`  - ${k} × ${n}`);
emit();
emit(`- session_start: ${fmtTypes(dbg.versions) || "none"}`);
emit();
emit("## debug-logs key paths by event");
for (const [name, paths] of dbg.attrsPaths) {
  emit(`### ${name}`);
  for (const [p, m] of paths) emit(`- ${p}: ${fmtTypes(m)}`);
}
emit();
emit("## llm_request");
emit(`- records: ${dbg.llm.n}`);
for (const [k, c] of dbg.llm.fields) emit(`- attrs.${k}: int ${c.int} (zero ${c.zero}, negative ${c.neg}), other type ${c.other}, absent ${c.absent}`);
emit(`- attrs.model: passes model allowlist ${dbg.llm.model.ok}, fails ${dbg.llm.model.bad}, absent ${dbg.llm.model.absent}; distinct models ${dbg.llm.distinctModels.size}`);
emit(`- timestamp fields: ${fmtTypes(dbg.llm.ts) || "none"}`);
emit(`- id-like fields: ${fmtTypes(dbg.llm.idKeys) || "none"}`);
emit(`- distinct record ids: ${dbg.llm.ids.size}; duplicate ids: ${dbg.llm.dupIds}; out-of-order timestamps within a file: ${dbg.llm.outOfOrder}`);
emit(`- lines of another type containing "llm_request": ${dbg.llm.nameInOtherLines}`);
emit(`- recency: today ${recency.today}, earlier this month ${recency.thisMonth}, earlier in last 7 days ${recency.last7}, older ${recency.older}, no timestamp ${recency.noTs}`);
emit();
emit("## Overlap with Copilot session-state usage records");
emit(`- session-state folders: ${cliFolderIds.size}; usage records: ${cliRecords.length}`);
{
  let incl = 0, excl = 0, unknown = 0;
  for (const c of cliRecords) {
    if (!Number.isSafeInteger(c.input) || !Number.isSafeInteger(c.cacheRead)) unknown++;
    else if (c.cacheRead > c.input) excl++;
    else incl++;
  }
  emit(`- session-state records with cacheRead > input (input excludes cache): ${excl}; cacheRead <= input: ${incl}; not comparable: ${unknown}`);
}
emit(`- debug-log session dir names equal to a session-state folder id: ${dbg.dirIsCliFolder}`);
emit(`- llm_request id-like strings equal to a session-state folder id: ${dbg.anyStringIsCliFolder}`);
emit(`- llm_request with a session-id field: ${dbg.sessionIdPresent}; equal to its debug-log dir name: ${dbg.sessionIdEqualsDir}`);
emit(`- llm_request whose (input, output, cached) equals a usage record: any time ${dbg.overlap.tupleAny}, within ±5 s ${dbg.overlap.tuple5s}; input only within ±5 s ${dbg.overlap.inputOnly5s}`);
emit();
emit("## chatSessions");
emit(`- files: ${chat.files}; unreadable: ${chat.unreadable}; sizes (bytes): ${stats(chat.bytes)}; longest line: ${chat.longest}`);
emit(`- lines: ${chat.lines}; valid JSON objects: ${chat.valid}; ${fmtTypes(chat.kinds) || "no kinds"}`);
for (const [kind, paths] of chat.paths) {
  emit(`### ${kind} (depth ≤ 3, deeper only under usage-like keys)`);
  for (const [p, m] of paths) if (p.split(".").length <= 4 || USAGEISH.test(p)) emit(`- ${p}: ${fmtTypes(m)}`);
}
emit();
emit("## chatSessions line sizes and patch paths");
for (const [k, s] of chat.lineSizes) emit(`- ${k} line bytes: ${stats(s)}`);
for (const [k, n] of [...chat.kShapes].sort((a, b) => b[1] - a[1])) emit(`- ${k} × ${n}`);
for (const [k, n] of chat.gate) emit(`- ${k} × ${n}`);
emit(`- kind=2 applied as array append: ${chat.kind2Applied}; not applicable: ${chat.kind2Unapplied}; patches with no parent: ${chat.patchNoParent}`);
emit();
emit("## chatSessions requests (after replaying patches)");
const q = chat.req;
emit(`- files with requests[]: ${chat.filesWithRequests}; session ids equal to a session-state folder id: ${chat.sessionIsCliFolder}`);
emit(`- requests: ${q.n}; distinct requestId: ${q.ids.size}; duplicate requestId across files: ${q.dupIds}; with responseId: ${q.responseIds}`);
for (const [k, c] of q.fields) emit(`- ${k}: int ${c.int} (zero ${c.zero}), other type ${c.other}, absent ${c.absent}`);
emit(`- promptTokens vs result.metadata.promptTokens: equal ${q.ptEqual}, differ ${q.ptDiffer}; completionTokens vs result.metadata.outputTokens: equal ${q.ctEqual}, differ ${q.ctDiffer}`);
for (const [k, c] of q.models) emit(`- ${k}: passes model allowlist ${c.ok}, fails ${c.bad}, absent ${c.absent}; distinct ${c.distinct.size}`);
emit(`- modelId vs resolvedModel: equal ${q.modelEqual}, differ ${q.modelDiffer}; toolCallRounds[].modelId passes ${q.roundModel.ok}, fails ${q.roundModel.bad}`);
emit(`- toolCallRounds per request: ${stats(q.rounds)}`);
emit(`- time fields: ${fmtTypes(q.ts) || "none"}`);
emit(`- ${fmtTypes(q.state) || "no modelState"}`);
emit(`- agent ids: ${fmtTypes(q.agents) || "none"}`);
emit(`- modes: ${fmtTypes(q.modes) || "none"}`);
emit(`- recency: today ${q.recency.today}, earlier this month ${q.recency.month}, older ${q.recency.older}, no timestamp ${q.recency.noTs}`);
emit(`- result.metadata.sessionId equal to a session-state folder id: ${q.metaSessionIsCli}`);
emit(`- (prompt, output) tokens equal to a session-state usage record: any time ${q.overlapAny}, within ±5 s ${q.overlap5s}; any session-state record within ±5 s: ${q.cliRecordWithin5s}`);

// No Chat log files under any root: say so instead of a zero-filled report, and exit 2
// like schema-probe.mjs does when there is nothing to read (v0.7).
if (debugFiles.length === 0 && chatFiles.length === 0) {
  out.length = 0;
  emit("# VS Code Copilot Chat log probe (shape only)");
  emit();
  emit("## Roots");
  for (const [k, v] of layout.roots) emit(`- ${k}: ${v}`);
  emit();
  emit(`chat-schema-probe: nothing found (no debug-logs or chatSessions *.jsonl files under ${layout.hashFolders} workspace folder${layout.hashFolders === 1 ? "" : "s"})`);
  process.exitCode = 2;
}

// ---------------------------------------------------------------- guard
for (const line of out) {
  for (const token of line.split(/\s+/)) {
    if (token.includes("/") || token.includes("\\")) {
      console.error("chat-schema-probe: aborted (an output token contained a path separator)");
      process.exit(3);
    }
  }
}
console.log(out.join("\n"));
