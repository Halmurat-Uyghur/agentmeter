// What the store offers a caller that keeps results between changes: the records dated from a
// time on (`from`), a version per range of dates (`versionOf`), and sums that continue from
// kept ones (`totals` with a seed, `projectGroups`, `toolGroups`). None of it may change what
// a pass returns.
import { describe, expect, it } from "vitest";
import { extendScan, scanCalls } from "../../src/core/insights";
import { groupSummaries, projectGroups, projectSummaries, toolGroups, toolRows, toolSummaries, UsageStore } from "../../src/core/store";
import type { Source, UsageRecord } from "../../src/core/types";

const DAY = 86_400_000;
const T = Date.UTC(2026, 10, 18);

let n = 0;
function rec(o: Partial<UsageRecord> = {}): UsageRecord {
  n++;
  return {
    key: `k-${n}`,
    keySource: "usageId",
    source: "copilot",
    kind: "call",
    sessionId: "s-1",
    folderId: "s-1",
    timestampMs: T,
    model: "model-a",
    tokens: { input: 100 + n, output: 10 },
    nanoAiu: 1000 + n,
    ...o,
  };
}

function total(folderId: string, source: Source, timestampMs: number, o: Partial<UsageRecord> = {}): UsageRecord {
  return { key: `shutdown:${folderId}:m`, keySource: "shutdown", source, kind: "sessionTotal", sessionId: folderId, folderId, timestampMs, model: "m", calls: 3, tokens: { input: 900, output: 90 }, ...o };
}

/** A small seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SOURCES: Source[] = ["copilot", "claude-code", "codex"];
const ALL = () => true;

describe("UsageStore.from", () => {
  it("reads what a pass over the whole store reads from that time on, in the same order, through every kind of change", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = rng(seed);
      const int = (k: number) => Math.floor(r() * k);
      const store = new UsageStore();
      // Odd seeds: most records are recent, so the store reads the whole store for them;
      // even seeds: most are old, and it keeps the lists.
      const span = seed % 2 === 0 ? 60 : 3;
      const cuts = [T - 13 * DAY, T - 6 * DAY, T - DAY, T];
      const files = ["a", "b", "c", "d", "e"];
      const known: UsageRecord[] = [];
      const check = (step: string) => {
        for (const cut of [...cuts, T - 2 * DAY, T + DAY]) {
          const view = store.from(cut);
          const inRange = (x: UsageRecord) => x.timestampMs >= cut;
          expect(view.records(ALL), `${step}: records from ${cut}`).toEqual(store.records(inRange));
          expect(view.totals(ALL)).toEqual(store.totals(inRange));
          expect([...view.latest()]).toEqual([...store.latest(inRange)]);
          const seen: string[] = [];
          view.each((x) => seen.push(x.key));
          expect(seen).toEqual(store.records(inRange).map((x) => x.key));
          expect(view.totalsByBucket(2, (x) => (x.kind === "call" ? 0 : 1))).toEqual(store.totalsByBucket(2, (x) => (inRange(x) ? (x.kind === "call" ? 0 : 1) : undefined)));
        }
      };
      check("empty");
      for (let step = 0; step < 220; step++) {
        if (step === 40) store.setCuts(cuts);
        if (step === 150) store.setCuts(cuts.map((c) => c + DAY));
        const source = SOURCES[int(3)]!;
        const folder = `${source}-f${int(4)}`;
        const file = `${folder}/${files[int(files.length)]}`;
        const ts = T - int(span) * DAY + int(3) * 3_600_000;
        const p = r();
        if (p < 0.5) {
          const x = rec({ source, sessionId: r() < 0.9 ? folder : `${source}-f${int(4)}`, folderId: folder, timestampMs: ts, tools: { Bash: 1 } });
          known.push(x);
          store.add(structuredClone(x), file);
        } else if (p < 0.65 && known.length > 0) {
          // the same key again: from its own file a repeat (new figures, perhaps a time across a cut), from another a copy
          const x = known[int(known.length)]!;
          store.add({ ...structuredClone(x), timestampMs: r() < 0.5 ? x.timestampMs : ts, tokens: { input: int(900), output: int(90) } }, r() < 0.6 ? `${x.folderId}/${files[int(files.length)]}` : file);
        } else if (p < 0.8) {
          store.setSessionTotals(folder, file, r() < 0.2 ? [] : [total(folder, source, ts, { calls: int(9) })]);
        } else if (p < 0.92) {
          store.resetFile(file);
        } else {
          store.resetFiles(new Set(files.slice(0, 2).map((f) => `${folder}/${f}`)));
        }
        check(`seed ${seed}, step ${step}`);
      }
    }
  });

  it("a time that is not one of the cuts reads the whole store and skips the older records", () => {
    const store = new UsageStore();
    for (let i = 0; i < 10; i++) store.add(rec({ timestampMs: T - i * DAY }), "f");
    expect(store.from(T - 3 * DAY).records(ALL).map((x) => x.timestampMs)).toEqual([0, 1, 2, 3].map((i) => T - i * DAY));
    store.setCuts([T - 3 * DAY]);
    expect(store.from(T - 3 * DAY).records(ALL).length).toBe(4);
    // a view made before the cuts moved still reads its own time
    const view = store.from(T - 3 * DAY);
    store.setCuts([T - DAY]);
    expect(view.records(ALL).length).toBe(4);
    expect(store.from(T - DAY).records(ALL).length).toBe(2);
  });
});

describe("UsageStore.versionOf", () => {
  it("changes for a range when one of its records is added, replaced or removed, and not otherwise", () => {
    const store = new UsageStore();
    store.setCuts([T - 6 * DAY, T]);
    const old = () => store.versionOf(Number.NEGATIVE_INFINITY, T - 6 * DAY);
    const week = () => store.versionOf(T - 6 * DAY, T);
    const today = () => store.versionOf(T);
    const all = () => store.versionOf();
    let [o, w, t, a] = [old(), week(), today(), all()];
    const moved = (): boolean[] => {
      const now = [old(), week(), today(), all()];
      const out = [now[0] !== o, now[1] !== w, now[2] !== t, now[3] !== a];
      [o, w, t, a] = now as [number, number, number, number];
      return out;
    };
    const x = rec({ timestampMs: T + 1000 });
    store.add(x, "f");
    expect(moved()).toEqual([false, false, true, true]);
    store.add(rec({ timestampMs: T - 2 * DAY }), "f");
    expect(moved()).toEqual([false, true, false, true]);
    store.add(rec({ timestampMs: T - 40 * DAY }), "g");
    expect(moved()).toEqual([true, false, false, true]);
    // the same line again: nothing changed
    store.add({ ...x }, "f");
    expect(moved()).toEqual([false, false, false, false]);
    // a repeat with other figures; one that moves the call to another range stamps both
    store.add({ ...x, tokens: { input: 5, output: 5 } }, "f");
    expect(moved()).toEqual([false, false, true, true]);
    store.add({ ...x, timestampMs: T - DAY, tokens: { input: 5, output: 5 } }, "f");
    expect(moved()).toEqual([false, true, true, true]);
    // another file holding the same key changes no record
    store.add({ ...x, timestampMs: T - DAY, tokens: { input: 5, output: 5 } }, "copy");
    expect(moved()).toEqual([false, false, false, false]);
    store.resetFile("g");
    expect(moved()).toEqual([true, false, false, true]);
    // a range between cuts counts for every range it overlaps
    expect(store.versionOf(T - 3 * DAY, T - 2 * DAY)).toBe(week());
    expect(store.versionOf(T - 8 * DAY, T + DAY)).toBe(all());
  });

  it("changes everywhere when a session total hides or shows, and when the cuts change", () => {
    const store = new UsageStore();
    store.setCuts([T]);
    store.setSessionTotals("legacy", "legacy/events", [total("legacy", "copilot", T - 9 * DAY)]);
    const old = store.versionOf(Number.NEGATIVE_INFINITY, T);
    // a call for another session, today: the old range is untouched
    store.add(rec({ sessionId: "other", folderId: "other", timestampMs: T + 1 }), "other/events");
    expect(store.versionOf(Number.NEGATIVE_INFINITY, T)).toBe(old);
    // a call today that names the total's session hides the total, which is dated in the old range
    store.add(rec({ sessionId: "legacy", folderId: "other", timestampMs: T + 2 }), "other/events");
    const hidden = store.versionOf(Number.NEGATIVE_INFINITY, T);
    expect(hidden).not.toBe(old);
    expect(store.totals((x) => x.timestampMs < T)).toBeUndefined();
    store.resetFile("other/events");
    expect(store.versionOf(Number.NEGATIVE_INFINITY, T)).not.toBe(hidden);
    expect(store.totals((x) => x.timestampMs < T)?.sessionTotals).toBe(1);
    const before = store.versionOf();
    store.setCuts([T]);
    expect(store.versionOf()).toBe(before);
    store.setCuts([T + DAY]);
    expect(store.versionOf()).not.toBe(before);
  });
});

describe("sums that continue from kept ones", () => {
  const fill = (): { store: UsageStore; cut: number } => {
    const store = new UsageStore();
    const r = rng(42);
    const int = (k: number) => Math.floor(r() * k);
    for (let i = 0; i < 300; i++) {
      const source = SOURCES[int(3)]!;
      const folder = `${source}-f${int(6)}`;
      store.add(
        rec({
          source,
          sessionId: folder,
          folderId: folder,
          timestampMs: T - int(10) * DAY,
          model: `m-${int(4)}`,
          tokens: { ...(r() < 0.9 && { input: int(1000) }), ...(r() < 0.9 && { output: int(100) }) },
          ...(r() < 0.8 ? { nanoAiu: int(5000) } : { nanoAiu: undefined }),
          ...(r() < 0.7 && { tools: { [["Bash", "Read", "view"][int(3)]!]: 1 + int(3), Edit: 1 } }),
        }),
        `${folder}/events`,
      );
    }
    for (const f of ["copilot-f7", "codex-f8"]) store.setSessionTotals(f, `${f}/events`, [total(f, f.startsWith("codex") ? "codex" : "copilot", T - DAY, { calls: undefined })]);
    return { store, cut: T - 2 * DAY };
  };

  it("totals(filter, seed): the figures of one pass over both parts, the seed untouched", () => {
    const { store, cut } = fill();
    const seed = store.totals((x) => x.timestampMs < cut)!;
    const copy = structuredClone(seed);
    expect(store.totals((x) => x.timestampMs >= cut, seed)).toEqual(store.totals(ALL));
    expect(seed).toEqual(copy);
    // nothing to add: the seed's figures, in a new object; no seed and no record: undefined
    expect(store.totals(() => false, seed)).toEqual(seed);
    expect(store.totals(() => false, seed)).not.toBe(seed);
    expect(store.totals(() => false)).toBeUndefined();
  });

  it("projectGroups with a seed: the rows of one pass, the seed untouched (with and without session-total counts)", () => {
    const { store, cut } = fill();
    const projectOf = (x: UsageRecord) => x.folderId.slice(-2);
    for (const sessionTotals of [false, true]) {
      const seed = projectGroups(store, Number.NEGATIVE_INFINITY, cut, projectOf, ALL, { sessionTotals });
      const before = structuredClone([...seed].map(([k, g]) => [k, g.s, [...g.ids]]));
      const rows = groupSummaries(projectGroups(store, cut, Number.POSITIVE_INFINITY, projectOf, ALL, { seed, sessionTotals }));
      expect(rows).toEqual(groupSummaries(projectGroups(store, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, projectOf, ALL, { sessionTotals })));
      expect([...seed].map(([k, g]) => [k, g.s, [...g.ids]])).toEqual(before);
      expect(rows.some((g) => g.sessionTotals !== undefined)).toBe(sessionTotals);
    }
    expect(groupSummaries(projectGroups(store, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, projectOf))).toEqual(projectSummaries(store, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, projectOf));
  });

  it("toolGroups with a seed: the rows of one pass, the seed untouched", () => {
    const { store, cut } = fill();
    const seed = toolGroups(store, Number.NEGATIVE_INFINITY, cut);
    const before = structuredClone([...seed]);
    expect(toolRows(toolGroups(store, cut, Number.POSITIVE_INFINITY, ALL, seed))).toEqual(toolSummaries(store, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY));
    expect([...seed]).toEqual(before);
  });
});

describe("extendScan", () => {
  it("gives the scan of every call in its own order, or declines", () => {
    let answered = 0;
    let declined = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const int = (k: number) => Math.floor(r() * k);
      // Sessions with every call sequenced, none, or some; few distinct times and sequences, so calls tie.
      const calls = Array.from({ length: 4 + int(30) }, () => {
        const session = int(5);
        const source: Source = session === 4 ? "claude-code" : "copilot";
        const sequenced = session < 2 ? true : session === 2 ? r() < 0.5 : false;
        return rec({
          source,
          sessionId: `s-${session}`,
          folderId: `s-${session}`,
          timestampMs: T + (int(6) - 3) * 3_600_000,
          model: `m-${int(3)}`,
          ...(sequenced && { sequence: int(4) }),
          tokens: { input: 100, output: 1, ...(r() < 0.5 && { cacheRead: int(300) }) },
        });
      });
      const earlier = calls.filter((x) => x.timestampMs < T);
      const later = calls.filter((x) => x.timestampMs >= T);
      const whole = scanCalls(calls);
      const next = extendScan(scanCalls(earlier), later);
      if (next === undefined) {
        declined++;
        continue;
      }
      answered++;
      expect([...next.firsts].sort(), `seed ${seed}`).toEqual([...whole.firsts].sort());
      expect([...next.conventions].sort()).toEqual([...whole.conventions].sort());
    }
    // both happen often enough to mean something
    expect(answered).toBeGreaterThan(50);
    expect(declined).toBeGreaterThan(50);
  });

  it("declines only when a session's first call could depend on the order", () => {
    const a = rec({ sessionId: "x", timestampMs: T - 10, sequence: 2 });
    const b = rec({ sessionId: "x", timestampMs: T + 10, sequence: 1 });
    // every call sequenced: the lower sequence, wherever it was read
    expect([...extendScan(scanCalls([a]), [b])!.firsts]).toEqual([b.key]);
    expect([...extendScan(scanCalls([b]), [a])!.firsts]).toEqual([b.key]);
    // no call sequenced: the earlier time
    const c = rec({ sessionId: "y", timestampMs: T - 10 });
    const d = rec({ sessionId: "y", timestampMs: T + 10 });
    expect([...extendScan(scanCalls([c]), [d])!.firsts]).toEqual([c.key]);
    // a tie between the two parts, or a session with and without sequences
    expect(extendScan(scanCalls([a]), [{ ...b, sequence: 2 }])).toBeUndefined();
    expect(extendScan(scanCalls([c]), [{ ...d, timestampMs: T - 10 }])).toBeUndefined();
    expect(extendScan(scanCalls([a]), [{ ...b, sequence: undefined }])).toBeUndefined();
    expect(extendScan(scanCalls([a, { ...c, sessionId: "x" }]), [b])).toBeUndefined();
    // a session only one part knows
    expect([...extendScan(scanCalls([a]), [d])!.firsts].sort()).toEqual([a.key, d.key].sort());
    // a model is "separate" if either part found it so
    const sep = rec({ sessionId: "z", model: "gpt-x", tokens: { input: 10, output: 1, cacheRead: 50 } });
    const inc = rec({ sessionId: "z", model: "gpt-x", timestampMs: T + 5, tokens: { input: 100, output: 1, cacheRead: 50 } });
    expect(extendScan(scanCalls([inc]), [sep])!.conventions.get("gpt-x")).toBe("separate");
    expect(extendScan(scanCalls([sep]), [inc])!.conventions.get("gpt-x")).toBe("separate");
    expect(extendScan(scanCalls([inc]), [{ ...inc, key: "other", sessionId: "w" }])!.conventions.get("gpt-x")).toBe("included");
  });
});
