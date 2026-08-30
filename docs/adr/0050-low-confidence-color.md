# ADR 0050; Decouple low-confidence foreground color from severity

**Status:** Accepted
**Date:** 2026-08-30

---

## Context

A UI audit on 2026-08-30 surfaced Finding A8: the mission card used the same red (`text-severity-high`, `#C46210`) for the low-confidence state in three places where it could be confused with severity information:

1. `app/src/components/mission-card.tsx:24` — `CONFIDENCE_CLASS.low = "text-severity-high"` — the confidence pill in the card body.
2. `app/src/components/mission-card.tsx:293` — `<span className="text-severity-high font-semibold">⚠ low confidence</span>` — the inline summary indicator on the card collapsed view.
3. `app/src/components/mission-card.tsx:429` — the "Why low confidence" header inside the score breakdown.

The same red is the foreground of the `<SeverityMark>` for `severity: "high"` (`app/src/components/severity-mark.tsx:8`) and is one shade off `severity-critical` (`#B3261E`). On a card with `severity: "critical"` and `confidence: "low"` (the common case for any advisory without a CVSS score, per ADR 0029's note in AGENTS.md §11), the user sees:

- A red severity bar on the left edge (`severity-critical`).
- A red "CRITICAL" pill in the body (`severity-critical` foreground).
- A red "⚠ low confidence" or "Why low confidence" string somewhere in the row.

Three red signals in the same row, each claiming to mean something different. A user scanning the board at a glance could read the third as "another severity hint" — it's not; it's a confidence signal about how trustworthy the score is.

The score-breakdown's left-border accent (`border-severity-high/40`) was a separate red — a structural accent, not a foreground cue — and that one doesn't conflict because it can't be mistaken for a severity bar in the same horizontal row.

## Decision

Keep the red on the left-border accent in the score breakdown (it's a structural cue at the eye-line, not a foreground signal). Replace the foreground `text-severity-high` in all three places with `text-ink-muted` (or `text-ink` for the inline summary indicator). The ⚠ glyph + bold weight carry the warning; the hue doesn't.

```ts
// app/src/components/mission-card.tsx
const CONFIDENCE_CLASS: Record<ScoreConfidence, string> = {
  high: "text-ink-muted",
  medium: "text-severity-medium", // unchanged — yellow is the one place medium makes sense
  low: "text-ink-muted", // was "text-severity-high"
};
```

```tsx
// summary
<span className="text-ink font-semibold">⚠ low confidence</span>

// score breakdown
<p className={
  isLowConfidence
    ? "text-ink-muted mb-1 font-mono text-xs font-semibold uppercase tracking-wide"
    : "text-ink-muted mb-1 font-mono text-xs uppercase tracking-wide"
}>
```

The `border-severity-high/40` left border on the breakdown block stays as-is — it's the only red left in the low-confidence rendering, and it's a structural accent that doesn't compete with the severity bar in the same row.

### Why not pick a new color for "low"?

Considered `text-severity-medium` (yellow) for low confidence. Rejected because:

- The card already uses yellow for `severity: "medium"` severity marks. Two yellows for "low" and "medium" would re-create the same hue-collision problem in a different hue family.
- Adding a brand-new `confidence: "low"` color would mean a new token in `tailwind.config.ts` (a settled-decision change, per AGENTS.md §0). The fix should not need it.
- The visual identity "low confidence" was never about a color — it was about a ⚠ glyph + the bold weight. Removing the red foreground keeps both, and the "Why low confidence" body block still has the red left-border accent. The red isn't gone, it's relocated from the foreground to the structural accent, which is where it can't be confused with severity.

### Why not use `text-severity-critical`?

That would be worse — a stronger red on a different signal. Same hue-collision problem, escalated.

## Implementation

Three small text-class swaps in one file, all in `app/src/components/mission-card.tsx`:

- `CONFIDENCE_CLASS.low` change (line 24).
- Inline summary `⚠ low confidence` class (line 293).
- Score-breakdown header class (line 429).

No query, schema, or dependency change. The visual treatment of the rest of the card is unchanged.

## Consequences

**Positive.**

- A critical-severity low-confidence card now shows red on the severity bar, the severity mark, and the structural left-border accent in the score breakdown, and not on the low-confidence inline indicator. The four red items (bar, mark, "Why low confidence" left border, low-confidence ⚠) read as: "this is a high-stakes thing, but the score is approximate" — which is exactly the message the design has been trying to send.
- The ⚠ glyph and the bold weight remain. The "low confidence" signal isn't reduced; it's decoupled from severity's hue family.
- Three local class-string changes. Zero runtime cost, zero query cost, zero schema cost.

**Negative.**

- The "low" state in the body's confidence pill (line 341) is now `text-ink-muted`, the same as the "high" state. Distinguishing them is now the ⚠ glyph (low only) and the textual `Low confidence` / `High confidence` label. The glyph is the discriminator — if a reader is using a screen reader with `aria-hidden` on the symbol, the textual label still resolves. The pre-existing `role="alert"` block on `MissionActions` is unchanged.
- A user with a strong prior that "red = low confidence" (from the prior design) will see a muted-text change. The ⚠ glyph and the body block's red left border give the same warning cue; the only thing that moves is which red. Audited the existing screenshots in the audit report and the change reads correctly in isolation.

**Open question / future work.**

- The "confidence" color treatment is now a settled thing: text-ink-muted for both high and low, text-severity-medium for medium. If a future feature ever needs to differentiate "low" from "high" by color, that's the place to revisit, not the current fix.
