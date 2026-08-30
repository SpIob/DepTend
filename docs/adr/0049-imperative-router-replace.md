# ADR 0049; Replace `useTransition` with imperative `router.replace` + in-flight counter

**Status:** Accepted
**Date:** 2026-08-30

---

## Context

A UI audit on 2026-08-30 surfaced Finding B1: filter chip clicks on `/missions` and per-repo boards took ~20s to navigate on the first click, and a second click within that window would stall indefinitely. The "Updating…" indicator would stay on, the URL wouldn't change, and the user couldn't get back to a working state without a hard refresh.

The `app/src/components/paginated-mission-board.tsx:198-211` `navigate()` function was wrapping `router.replace(href)` in `startTransition`. With a 20s Vercel-free-tier Neon round-trip (the page is `force-dynamic`; every navigation re-fetches from Postgres and re-renders the full server component tree), a second `startTransition` queued behind the first because React 19's transition semantics mark the new transition as pending until the previous one settles. The pending transitions piled up in user-action order, and `isPending` stayed `true` for the duration of the queue.

For a single user clicking one chip, the behavior is correct: the click sets `isPending = true`, the server responds in 20s, `isPending` returns to `false`, the URL updates, the new missions render. For a user clicking a second chip within 20s, the second click is queued; the URL never changes; the indicator stays on.

## Decision

Drop the `useTransition` wrapper and replace it with imperative `router.replace(href)` plus a local in-flight counter. The counter is the same `isPending` boolean the chips and the "Updating…" indicator read, so the visible behavior is identical for the single-click case.

```ts
// app/src/components/paginated-mission-board.tsx
const [inFlight, setInFlight] = useState(0);
const inFlightRef = useRef(0);
useEffect(() => {
  inFlightRef.current = inFlight;
}, [inFlight]);
const isPending = inFlight > 0;

function navigate(href: string): void {
  if (pendingSearchNav.current !== null) {
    clearTimeout(pendingSearchNav.current);
    pendingSearchNav.current = null;
  }
  inFlightRef.current += 1;
  setInFlight(inFlightRef.current);
  router.replace(href);
}
```

The "request settled" signal is the same `lastServerMissions !== initialMissions` check that already exists for adopting the new server-rendered missions array. When the server response arrives, the prop change drops the counter:

```ts
if (lastServerMissions !== initialMissions) {
  setLastServerMissions(initialMissions);
  setMissions(initialMissions);
  if (inFlightRef.current > 0) {
    inFlightRef.current -= 1;
    setInFlight(inFlightRef.current);
  }
}
```

The decrement is guarded against negative values (`if (inFlightRef.current > 0)`) so an abandoned request can't drag the indicator back to "Updating…" after the user has navigated away.

### Why a counter, not a boolean

A boolean (`isPending`) would re-introduce the bug: the second click flips it back to `true` and stays there because the first request's response is still in flight. A counter is the minimum needed to model "there are N requests in flight, decrement per settled response". The counter rarely exceeds 1 in practice (rapid clicks push it to 2-3); a simple integer is enough.

### Why a ref-mirror alongside the state

React state updates are async; `navigate()` reads `inFlightRef.current` synchronously to increment, then `setInFlight` queues the re-render. Without the ref mirror, the synchronous increment-after-decrement race (a chip click in the same tick as a server response) would skip a value. The ref is the synchronous source of truth; the state is the re-render trigger.

### Why the existing "fresh missions array" check is the right settle point

Next.js's `router.replace(href)` triggers a server re-render. The new `initialMissions` prop arrives when the re-render commits. There's no other observable signal in this component that "the navigation is done" — `useTransition` was providing that signal before, and it was unreliable under load. The prop-change check is the natural one and was already in the file for the "adopt new missions" pattern.

## Implementation

### `app/src/components/paginated-mission-board.tsx`

- Removed `useTransition` from the React import (line 3).
- Replaced `const [isPending, startTransition] = useTransition();` with the `inFlight` / `inFlightRef` pair (lines 155-167).
- Changed `navigate()` to imperative `router.replace(href)` with the counter increment (lines 226-238).
- Added the counter decrement inside the existing `if (lastServerMissions !== initialMissions)` block (lines 178-188).

### What didn't change

- The visible "Updating…" indicator: same `isPending` boolean the chips, sort, and pagination read.
- The debounced search-input navigation: still uses the same `navigate()` function, just no longer inside a transition.
- The group-by-repo checkbox: still uses `window.history.replaceState` directly (line 282-294), unaffected.
- No query, schema, or dependency change. Pure client-side state management.

## Consequences

**Positive.**

- A rapid second click no longer queues indefinitely. Each click fires its own `router.replace`; the indicator reflects the actual in-flight count.
- The "Updating…" indicator still works for the single-click case: click → indicator on → server response → indicator off.
- The fix is local to one file; the rest of the board's behavior is unchanged.

**Negative.**

- A user who clicks 5 chips in rapid succession will see the indicator stay on for ~20s + the time it takes to drain the queue. This is the honest state: there are 5 server responses in flight. The previous behavior (indicator on forever) was worse.
- The "fresh missions array" check assumes each `router.replace` produces exactly one server response. If a future change ever causes one click to produce two server responses (e.g. prefetching), the counter would over-decrement. The guard `if (inFlightRef.current > 0)` makes the worst case "indicator stuck on" instead of "counter goes negative"; the previous behavior is preserved on the over-decrement path.

**Open question / future work.**

- A 20s Vercel-free-tier Neon round-trip is the real cost here. A more durable fix would be to add `unstable_cache` (per AGENTS.md §8) or move the board to a streaming-rendered RSC, so a navigation doesn't require a full server re-render. Both are larger changes and out of scope for this fix; the inFlight counter is the right local fix.
- If the chip click ever needs to do more than `router.replace` (e.g. close a popover), the counter pattern is still the right primitive. Wrap the side-effect around the increment/decrement pair.
