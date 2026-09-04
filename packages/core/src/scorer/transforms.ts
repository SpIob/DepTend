/**
 * Pure transform helpers for the scoring pipeline.
 *
 * Extracted from impact.ts, ecosystem-value.ts, mission-scorer.ts to
 * eliminate duplication and provide a single source of truth.
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
