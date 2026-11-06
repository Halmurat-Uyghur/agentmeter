// User-facing wording. Every figure here is a local observation from Copilot
// session logs, never an account statement: "—" means nothing was reported,
// "*" means some contributing records did not report the field.

import { addMetrics } from "./store";
import type { Counts, Health, Metric, Snapshot } from "./types";

export const LOCAL_BANNER =
  "Locally observed from Copilot session logs on this computer. Not your GitHub bill, not your remaining allowance, and not usage from other devices or Copilot features that don't write these logs.";

export const STREAMING_NOTE =
  "Updates when Copilot finishes each model call, not token by token.";

export const NOT_COVERED: string[] = [
  "Only Copilot clients that write session-state/*/events.jsonl (the Copilot CLI and coding agent, including agent sessions started from VS Code) are counted. Inline completions, Copilot Chat surfaces without these logs, github.com, mobile, JetBrains and other computers are not.",
  "Sessions from Copilot before 1.0.99 have no per-call records; they are listed as sessions without per-call data and add nothing to the totals.",
  '"Today" starts at local midnight on this computer; GitHub\'s own day may follow UTC.',
];

const DASH = "—";

export function formatCount(m: Metric): string {
  if (m.reported === 0) return DASH;
  const n = m.sum;
  let s: string;
  if (n < 1000) {
    s = String(n);
  } else {
    const k = (n / 1e3).toFixed(1);
    s = Number(k) >= 1000 ? (n / 1e6).toFixed(1) + "M" : k + "K";
  }
  return m.missing > 0 ? s + "*" : s;
}

export function formatAiu(m: Metric): string {
  if (m.reported === 0) return DASH;
  const s = (m.sum / 1e9).toFixed(2);
  return m.missing > 0 ? s + "*" : s;
}

export function partialNote(m: Metric): string | undefined {
  if (m.missing === 0) return undefined;
  return `reported by ${m.reported} of ${m.reported + m.missing} records`;
}

function star(s: string): string {
  return s === DASH || s.endsWith("*") ? s : s + "*";
}

export function statusText(s: Snapshot | undefined): string {
  if (!s) return "$(sync~spin) Copilot usage: loading";
  if (s.health.state === "no-dir")
    return "$(circle-slash) Copilot logs not found";
  if (s.health.state === "permission") return "$(lock) Copilot logs unreadable";
  // The icon is chosen independently, so a format change that stops every
  // record from parsing (no `today`) still shows the warning.
  const icon = s.health.state === "format-changed" ? "$(warning)" : "$(pulse)";
  if (!s.today) return `${icon} Local today: ${DASH}`;
  let n = formatCount(addMetrics(s.today.input, s.today.output));
  if (s.health.partial) n = star(n);
  return `${icon} Local today: ${n} tok`;
}

/** Backslash-escapes every ASCII punctuation character (all are escapable in
 * CommonMark), so a log-derived string cannot form a link, autolink, HTML or
 * emphasis — `:` and `/` included, which GFM would otherwise autolink. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[!-/:-@[-`{-~]/g, (c) => "\\" + c);
}

function tok(m: Metric): string {
  return escapeMarkdown(formatCount(m)) + " tok";
}

function fieldLine(label: string, m: Metric): string {
  const note = partialNote(m);
  return `${label}: ${tok(m)}` + (note ? ` (\\* ${note})` : "");
}

function countsLines(c: Counts): string[] {
  return [fieldLine("Input", c.input), fieldLine("Output", c.output)];
}

function healthLines(h: Health): string[] {
  const out: string[] = [];
  if (h.state === "no-dir") {
    out.push(
      "No Copilot session logs were found. Set `copilotUsageMonitor.copilotHome` if Copilot keeps them elsewhere.",
    );
  } else if (h.state === "permission") {
    out.push(
      "The Copilot session log folder could not be read on this computer.",
    );
  } else if (h.state === "format-changed") {
    out.push(
      `Data health: ${h.unrecognized} line(s) in a format this version doesn't recognize. Copilot may have changed its log format, so figures may be incomplete.`,
    );
  } else if (h.state === "no-data") {
    out.push("No per-call records dated today yet.");
  }
  if (h.partial) {
    const reasons = ["Figures marked \\* may be incomplete:"];
    if (h.unreadableFiles > 0)
      reasons.push(`- ${h.unreadableFiles} log file(s) could not be read.`);
    if (h.malformed > 0)
      reasons.push(`- ${h.malformed} malformed line(s) were skipped.`);
    if (h.overlong > 0)
      reasons.push(`- ${h.overlong} over-long line(s) were skipped.`);
    out.push(reasons.join("\n"));
  }
  if (h.sessionsWithoutUsage > 0) {
    out.push(
      `${h.sessionsWithoutUsage} session(s) without per-call data (older Copilot) are not in the totals.`,
    );
  }
  return out;
}

export function tooltipMarkdown(s: Snapshot | undefined): string {
  const parts: string[] = [LOCAL_BANNER, STREAMING_NOTE];
  if (!s) {
    parts.push("Reading Copilot session logs…");
    return parts.join("\n\n");
  }

  if (s.today) {
    parts.push(["**Local today**", ...countsLines(s.today)].join("  \n"));
  } else if (s.health.state !== "no-dir" && s.health.state !== "permission") {
    parts.push(`**Local today**: ${DASH}`);
  }

  const cur = s.current;
  if (cur) {
    const tags = [
      cur.live ? undefined : "ended",
      cur.pinned ? "pinned" : undefined,
    ].filter(Boolean);
    const label =
      "Current session" + (tags.length ? ` (${tags.join(", ")})` : "");
    if (cur.totals) {
      const both = addMetrics(cur.totals.input, cur.totals.output);
      parts.push(`${label}: ${tok(both)}`);
    } else {
      parts.push(`${label}: ${DASH}`);
    }
  }

  if (s.today) {
    const models = Object.keys(s.today.byModel).sort();
    if (models.length > 0) {
      const lines = models.map((model) => {
        const c = s.today!.byModel[model]!;
        return `- ${escapeMarkdown(model)}: ${tok(addMetrics(c.input, c.output))}`;
      });
      parts.push(["**By model today**", ...lines].join("\n"));
    }
  }

  parts.push(...healthLines(s.health));
  return parts.join("\n\n");
}

/** Model time as "18m 22s" / "42s" / "1h 03m"; "—" when unreported, "*" when partial. */
export function formatDuration(m: Metric): string {
  if (m.reported === 0) return DASH;
  const total = Math.round(m.sum / 1000);
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const s = h > 0 ? `${h}h ${pad(min)}m` : min > 0 ? `${min}m ${pad(sec)}s` : `${sec}s`;
  return m.missing > 0 ? s + "*" : s;
}
