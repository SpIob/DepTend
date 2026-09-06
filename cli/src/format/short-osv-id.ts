/**
 * Short-form OSV ID for at-a-glance disambiguation in the human summary.
 *
 * Same shape as app/src/components/mission-card.tsx#shortOsvId (ADR 0051);
 * mirrored CLI-side so two advisories on the same package at the same
 * severity don't render as visually identical rows in the human summary.
 * Local copy rather than an import because /core intentionally doesn't
 * re-export scorer helpers (see packages/core/src/index.ts).
 */
export function shortOsvId(osvId: string): string | null {
  const parts = osvId.split("-");
  if (parts.length < 2) return null;
  // The `??` defaults satisfy template-expressions rules (which reject
  // string|undefined in template literals under typed-lint).
  return `${parts[0] ?? ""}-${parts[1] ?? ""}`;
}
