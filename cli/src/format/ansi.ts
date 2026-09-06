/**
 * ANSI color utilities for terminal output.
 * Gated on TTY + NO_COLOR — no colors when not a TTY or NO_COLOR is set.
 */

export const ANSI_RESET = "\x1b[0m";

/**
 * Returns ANSI reset code if colors are enabled, empty string otherwise.
 */
export function reset(useColor: boolean): string {
  return useColor ? ANSI_RESET : "";
}

/**
 * Severity to ANSI color mapping.
 * Exhaustive for known severities; unknown falls through to no color.
 */
export const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: "\x1b[31m", // red
  HIGH: "\x1b[31m", // red
  MEDIUM: "\x1b[33m", // yellow
  LOW: "\x1b[32m", // green
  UNKNOWN: "\x1b[90m", // dim gray
};

/**
 * Returns ANSI color code for a severity, or empty string if unknown.
 */
export function severityColor(severity: string): string {
  return SEVERITY_COLORS[severity] ?? "";
}

/**
 * Conditionally applies a color prefix.
 * Returns the prefix if colors are enabled and prefix is non-empty; otherwise empty string.
 */
export function colorize(prefix: string, useColor: boolean): string {
  return useColor && prefix !== "" ? prefix : "";
}
