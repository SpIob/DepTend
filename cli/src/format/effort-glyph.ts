/**
 * Effort label glyph and color utilities for terminal output.
 *
 * Prefixes a one-character glyph so the human eye can tell effort levels
 * apart at a glance without adding a second column. Color is bonus; the
 * glyph is the load-bearing fix (audit 2026-09-05 B9).
 */

export const EFFORT_GLYPH: Record<string, string> = {
  trivial: "·",
  low: "+",
  medium: "*",
  high: "×",
};

/**
 * Returns ANSI color code for an effort label.
 * Exhaustive switch guarantees no silent fall-through.
 */
export function effortColor(effortLabel: string): string {
  switch (effortLabel) {
    case "trivial":
      return "\x1b[90m"; // dim
    case "low":
      return "\x1b[32m"; // green
    case "medium":
      return "\x1b[33m"; // yellow
    case "high":
      return "\x1b[31m"; // red
    default:
      return "";
  }
}

/**
 * Returns a prefixed glyph with optional color for an effort label.
 * Format: "<color><glyph> " (note trailing space for alignment).
 */
export function effortPrefix(effortLabel: string, useColor: boolean): string {
  const glyph = EFFORT_GLYPH[effortLabel] ?? " ";
  const color = useColor ? effortColor(effortLabel) : "";
  return `${color}${glyph} `;
}
