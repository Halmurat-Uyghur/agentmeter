// When the details panel redraws (A11y C1). Assigning webview.html reloads the page, so
// a keyboard or screen-reader user reading the panel is sent back to the top and open
// folds close. While the panel is the active editor, background redraws (a new snapshot
// after a model call) are held to at most one per interval, trailing; anything the user
// asked for (a section, month, filter or unit change, shown by a changed `key`) and any
// redraw while the panel is not focused happen at once. Pure: no vscode import, and the
// clock and timers are injectable for tests. No new command or setting.

export interface ThrottleClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_CLOCK: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** At most one background redraw per this many ms while the panel has focus. */
export const FOCUSED_REDRAW_MS = 10_000;

export class RedrawThrottle {
  private lastDrawMs = Number.NEGATIVE_INFINITY;
  private lastKey: string | undefined;
  private timer: unknown;
  private pendingKey: string | undefined;

  /**
   * @param draw redraws the page; returns false when nothing was assigned (an unchanged
   *   document), which does not count as a redraw for the interval.
   */
  constructor(
    private readonly draw: () => boolean,
    private readonly intervalMs = FOCUSED_REDRAW_MS,
    private readonly clock: ThrottleClock = SYSTEM_CLOCK,
  ) {}

  /** A redraw is wanted. `key` names what the user chose (section, month, filter, unit);
   * `focused` is whether the panel is the active editor. */
  request(key: string, focused: boolean): void {
    const userChange = this.lastKey !== undefined && key !== this.lastKey;
    if (this.lastKey === undefined || userChange || !focused || this.clock.now() - this.lastDrawMs >= this.intervalMs) {
      this.flush(key);
      return;
    }
    this.pendingKey = key;
    if (this.timer !== undefined) return;
    const wait = Math.max(0, this.lastDrawMs + this.intervalMs - this.clock.now());
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      if (this.pendingKey !== undefined) this.flush(this.pendingKey);
    }, wait);
  }

  /** A user action (open, section switch): draw now; the interval counts from here. */
  drawNow(key: string): void {
    this.flush(key);
  }

  /** The panel lost focus or became visible again: draw anything held back, now. */
  release(): void {
    if (this.pendingKey !== undefined) this.flush(this.pendingKey);
  }

  /** A redraw is held back. */
  get pending(): boolean {
    return this.pendingKey !== undefined;
  }

  /** Forget the last draw (the page was disposed): the next request draws at once. */
  reset(): void {
    this.cancel();
    this.lastKey = undefined;
    this.lastDrawMs = Number.NEGATIVE_INFINITY;
  }

  dispose(): void {
    this.cancel();
  }

  private cancel(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingKey = undefined;
  }

  private flush(key: string): void {
    this.cancel();
    this.lastKey = key;
    if (this.draw()) this.lastDrawMs = this.clock.now();
  }
}
