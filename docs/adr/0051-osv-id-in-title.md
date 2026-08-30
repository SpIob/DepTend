# ADR 0051; Append short OSV ID to mission card title

**Status:** Accepted
**Date:** 2026-08-30

---

## Context

A UI audit on 2026-08-30 surfaced Finding U1: on `/missions?severity=critical`, 7 of 10 cards had title "Update golang.org/x/crypto to fix a critical vulnerability" and the same `Fix: 0.52.0` tag. The underlying OSV IDs were distinct (e.g. `GHSA-x527-x647-q7gg`, `GHSA-5cgq-3rg8-m6cv`, `GHSA-rm3j-f69w-wqmq`, `GHSA-89gr-r52h-f8rx`). The user had to expand each card and read the Source line to tell them apart.

`mission-copy.ts::buildTitle()` is deterministic per (package, severity, missionType), so two advisories against the same package at the same severity produce the same title by design. The `FixedVersionTag` was supposed to be the at-a-glance differentiator per the comment in `app/src/components/mission-card.tsx:212-219`, but the same fix version applies to multiple advisories in this dataset. The card summary as built offered no way to disambiguate.

## Decision

Append the short-form OSV ID — first two dash-separated chunks of the full ID — to the card title in muted weight, as a suffix in parentheses. Examples:

- `GHSA-x527-x647-q7gg` → `(GHSA-x527)`
- `CVE-2024-12345` → `(CVE-2024)`
- `PYSEC-2023-12345` → `(PYSEC-2023)`
- `GO-2024-1234` → `(GO-2024)`

Rendered as `<span className="text-ink-muted ml-1 font-normal">(GHSA-x527)</span>` inside the existing `<h3>`. The prefix sits at the end of the title in muted text; the full OSV ID is still in the Source line in the body for anyone who needs the complete identifier to file a fix or cross-reference.

### Why the short prefix, not the full ID

- The full ID is 18-26 characters; the prefix is 8-12. On a card title that's already truncated at 240px on mobile, adding the full ID would crowd the row and push the fix-version tag off the line in many cases.
- The full ID is already in the body (the Source line is a link to OSV). The card summary just needs enough to tell two rows apart.
- The prefix matches the human convention for OSV IDs: GitHub calls them "GHSA-x527", NVD calls them "CVE-2024", Go vulndb calls them "GO-2024". A user who recognizes the scheme can guess where to look it up.

### Why in muted text, not a badge

- A separate pill/badge would have to fit between the title and the fix-version tag, which is already a tight row. The current title row is `h3 + gap-2 + FixedVersionTag`; a third element compresses all three.
- A muted-text suffix in the same `<h3>` keeps the title as a single visual unit and doesn't break the existing flex layout.
- The visual treatment matches the rest of the card's "metadata in muted" pattern (effort label, repo owner/name, etc.).

### Why not a tool-tip / hover disclosure

- Mobile has no hover. The audit specifically called this out (`app/src/components/repo-card.tsx` truncate on the description).
- The OSV ID is the canonical identifier — it should be visible, not hidden behind an interaction.

## Implementation

### New helper: `shortOsvId(osvId)` in `app/src/components/mission-card.tsx`

```ts
function shortOsvId(osvId: string): string | null {
  const parts = osvId.split("-");
  if (parts.length < 2) {
    return null;
  }
  return `${parts[0]}-${parts[1]}`;
}
```

`null` for inputs that don't have a recognizable scheme (e.g. just one chunk). The title render falls back to no suffix in that case.

### Title render: `app/src/components/mission-card.tsx:312-322`

```tsx
<h3 className="text-ink min-w-0 truncate text-sm font-semibold">
  {mission.title}
  {osvShortId !== null && <span className="text-ink-muted ml-1 font-normal">({osvShortId})</span>}
</h3>
```

The `osvShortId` variable is computed once at the top of the component body (`advisory === null ? null : shortOsvId(advisory.osvId)`). The `text-ink-muted font-normal` class gives the prefix the same muted treatment as the rest of the card's metadata.

### What didn't change

- `mission-copy.ts` — the title builder is unchanged. The short OSV ID is a presentation concern, not a copy concern.
- `FixedVersionTag` — the fix-version tag is unchanged; it sits next to the title and the prefix doesn't displace it.
- No query, schema, or migration change. Pure presentation.
- The Source line in the body still shows the full OSV ID; the audit report and card summary both stay in sync with the body.

## Consequences

**Positive.**

- Multiple same-severity-same-package advisories now read as distinct at a glance: "Update golang.org/x/crypto to fix a critical vulnerability (GHSA-x527)" vs "(GHSA-5cgq)" vs "(GHSA-rm3j)". The user no longer needs to expand every card.
- The full OSV ID remains the canonical reference in the Source line. The prefix is just enough to disambiguate the summary.
- The fix is local to one file: one helper function (~10 lines including docstring) and one JSX change. Zero query, zero schema, zero migration.

**Negative.**

- Card titles are slightly longer. On the 240px mobile truncation, the prefix may push the fix-version tag off the right edge of the title row. Acceptable: the fix-version tag is in a sibling element with its own `shrink-0` class, so it stays in place, and the title truncates earlier. No layout breakage.
- The prefix is in `text-ink-muted`, which is the same hue used for the confidence pill and the effort/owner line. The user might briefly read the prefix as another metadata line. Acceptable: the prefix is inside the `<h3>`, so screen readers will announce it as part of the title, and the visual cue (parentheses, in-title placement) makes the role clear.
- A malformed OSV ID (no dash) renders no prefix at all. The audit didn't find any such IDs in the current dataset (all `GHSA-`, `CVE-`, `PYSEC-`, `GO-` shaped), but the `null` return guards against future malformed data.

**Open question / future work.**

- If a future "compact" view skips the parenthetical prefix for cards wider than 480px, that's a `md:hidden` class on the prefix span. Not in scope here.
- If the OSV prefix collides for two advisories (e.g. two `CVE-2024-1` IDs at different versions), the disambiguation drops to the fix-version tag. The audit didn't find this in the current dataset; if it surfaces, the prefix should grow to three chunks for affected ecosystems.
