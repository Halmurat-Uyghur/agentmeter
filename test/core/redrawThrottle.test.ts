import { describe, expect, it } from "vitest";
import { FOCUSED_REDRAW_MS, RedrawThrottle, type ThrottleClock } from "../../src/core/redrawThrottle";

/** A manual clock: timers fire only when `advance` passes them. */
function fakeClock() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: ThrottleClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (h) => void timers.delete(h as number),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = end;
  };
  return { clock, advance, timers };
}

function setup(changed = () => true) {
  const c = fakeClock();
  let draws = 0;
  const t = new RedrawThrottle(
    () => {
      const ok = changed();
      if (ok) draws++;
      return ok;
    },
    FOCUSED_REDRAW_MS,
    c.clock,
  );
  return { ...c, t, draws: () => draws };
}

describe("RedrawThrottle (A11y C1)", () => {
  it("the interval is 10 s", () => {
    expect(FOCUSED_REDRAW_MS).toBe(10_000);
  });

  it("draws the first request at once", () => {
    const x = setup();
    x.t.request("k", true);
    expect(x.draws()).toBe(1);
  });

  it("while focused, two snapshots within the interval cause one redraw, then one trailing redraw", () => {
    const x = setup();
    x.t.request("k", true);
    x.advance(1_000);
    x.t.request("k", true);
    x.advance(1_000);
    x.t.request("k", true);
    expect(x.draws()).toBe(1);
    expect(x.t.pending).toBe(true);
    x.advance(7_999);
    expect(x.draws()).toBe(1);
    x.advance(1);
    expect(x.draws()).toBe(2);
    expect(x.t.pending).toBe(false);
    expect(x.timers.size).toBe(0);
  });

  it("never more than one redraw per 10 s while focused, however many snapshots arrive", () => {
    const x = setup();
    x.t.request("k", true);
    for (let i = 0; i < 300; i++) {
      x.advance(200);
      x.t.request("k", true);
    }
    // 60 s of snapshots every 200 ms: the first draw plus one per 10 s
    expect(x.draws()).toBe(7);
  });

  it("not focused: every request draws at once", () => {
    const x = setup();
    for (let i = 0; i < 5; i++) {
      x.t.request("k", false);
      x.advance(100);
    }
    expect(x.draws()).toBe(5);
  });

  it("a changed key (section, month, filter or unit) draws at once even while focused", () => {
    const x = setup();
    x.t.request("overview", true);
    x.advance(500);
    x.t.request("overview", true);
    expect(x.draws()).toBe(1);
    x.t.request("daily", true);
    expect(x.draws()).toBe(2);
    expect(x.t.pending).toBe(false);
  });

  it("drawNow draws at once and restarts the interval", () => {
    const x = setup();
    x.t.request("k", true);
    x.advance(500);
    x.t.drawNow("k");
    expect(x.draws()).toBe(2);
    x.advance(500);
    x.t.request("k", true);
    expect(x.draws()).toBe(2);
    x.advance(9_500);
    expect(x.draws()).toBe(3);
  });

  it("release (lost focus, shown again) draws what was held back, once", () => {
    const x = setup();
    x.t.request("k", true);
    x.advance(100);
    x.t.request("k", true);
    expect(x.draws()).toBe(1);
    x.t.release();
    expect(x.draws()).toBe(2);
    x.t.release();
    expect(x.draws()).toBe(2);
    x.advance(20_000);
    expect(x.draws()).toBe(2);
  });

  it("an unchanged document does not count as a redraw", () => {
    let changed = false;
    const x = setup(() => changed);
    x.t.request("k", true);
    expect(x.draws()).toBe(0);
    x.advance(100);
    changed = true;
    x.t.request("k", true);
    expect(x.draws()).toBe(1);
  });

  it("dispose and reset cancel the held redraw", () => {
    const x = setup();
    x.t.request("k", true);
    x.t.request("k", true);
    x.t.dispose();
    x.advance(20_000);
    expect(x.draws()).toBe(1);
    x.t.request("k", true); // the interval has passed: drawn
    x.t.request("k", true); // held
    expect(x.draws()).toBe(2);
    x.t.reset();
    expect(x.t.pending).toBe(false);
    x.advance(20_000);
    expect(x.draws()).toBe(2);
    x.t.request("k", true); // after a reset the next request draws at once
    expect(x.draws()).toBe(3);
  });
});
