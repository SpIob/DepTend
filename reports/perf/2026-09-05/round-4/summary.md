# Round 4: extending the `<Suspense>` refactor to `/` and `/repo` — **NEGATIVE RESULT, refactor reverted**

**Date:** 2026-09-05
**Method:** Implement the round-3 `<Suspense>` pattern on `app/src/app/page.tsx` and `app/src/app/repo/[owner]/[name]/page.tsx`, measure LCP cold + warm × 3 on a `pnpm build` + `pnpm start` local prod build against the dev Neon (per ADR 0023's dev-prod split). The round-3 refactor on `/missions` already lives on this branch.

**Question this round answers:** round 3 verified the LCP `<Suspense>` refactor on `/missions` with a 57-83% LCP reduction. Does the same pattern deliver the same win on the home directory and the per-repo board?

**Headline: NO.** The refactor was implemented and reverted in the same session. The home and per-repo pages' outer render awaits network calls (`getServerSession`, `getRepoByOwnerAndName`) before any JSX is produced, so the `<Suspense>` boundary can't render the LCP text from the initial HTML — the page-segment loading skeleton still occupies the visible `<main>`. The refactor not only failed to improve LCP, it **regressed CLS by +0.027 on `/` and +0.029 on `/repo`** (from 0.002 / 0 to a stable 0.029), because the data fetch boundaries introduced new layout shifts. **No code changes from this round remain in the working tree** beyond a one-line re-apply of the user's WIP `BookmarkToggle` `repoFullName` prop that `git checkout HEAD` accidentally removed.

## Baseline (BEFORE the round-4 refactor)

Lighthouse 13.4.1 desktop preset, `throttling-method=provided`. Local prod build against dev Neon. The branch is `perf/suspense-lcp-missions` (off `a6cb2d2`); round-3's `/missions` refactor is already in place; the user's WIP changes (ADR 0053, ADR 0054, the audit-batch fixes) are in the working tree.

| Page | FCP | LCP | TBT | CLS | Render delay | Render delay % |
|---|---|---|---|---|---|---|
| `/` cold | 0.1 s | 0.1 s | 0 ms | 0.002 | 40 ms | 70% |
| `/` warm-1 | 0.0 s | 0.1 s | 0 ms | 0.051 | 75 ms | 91% |
| `/` warm-2 | 0.0 s | 0.0 s | 0 ms | 0.002 | 28 ms | 82% |
| `/` warm-3 | 0.0 s | 0.0 s | 0 ms | 0.002 | 26 ms | 76% |
| `/repo/SpIob/deptend-go-test-fixture` cold | 0.0 s | 0.4 s | 0 ms | 0 | 442 ms | 99% |
| `/repo/.../deptend-go-test-fixture` warm-1 | 0.0 s | 0.3 s | 0 ms | 0 | 323 ms | 98% |
| `/repo/.../deptend-go-test-fixture` warm-2 | 0.0 s | 0.3 s | 0 ms | 0 | 315 ms | 98% |
| `/repo/.../deptend-go-test-fixture` warm-3 | 0.0 s | 0.4 s | 0 ms | 0 | 391 ms | 99% |

The local baseline already shows `/` with very low LCP (0.0-0.1s) — the home page isn't actually slow on the local prod build. The render-delay is 26-75ms (small). **`/repo/.../deptend-go-test-fixture` has the same LCP render-delay pattern as round 1's deployed prod measurement**: 0.3-0.4s LCP, 98-99% from element render delay. **This is the only page where the refactor had potential to deliver a measurable LCP win.**

## The refactor that was applied (and reverted)

The same pattern as round 3: extract the data fetches and data-dependent render into Server Components, wrap in `<Suspense>`, render the LCP text outside the boundary.

For `app/src/app/page.tsx` (the home directory):
- LCP element: `<p class="text-ink-muted max-w-2xl text-sm leading-relaxed">Every indexed repo...</p>` (line 104 of the pre-refactor code)
- Outer render: `const session = await getServerSession(authOptions); const login = session?.user?.login;`
- Data fetches moved into `DataDrivenHeaderStats`, `DataDrivenSubmitForm`, `RepoDirectoryGrid`
- Suspense boundaries: 3 (header right, submit form, grid)

For `app/src/app/repo/[owner]/[name]/page.tsx`:
- LCP element: `<p class="text-ink-muted max-w-xl text-sm leading-relaxed">{repo.description ?? "Prioritized maintenance missions for this repo."}</p>` (line 198-200 of the pre-refactor code)
- Outer render: `const { owner, name } = await params; const repo = await getRepoByOwnerAndName(owner, name); if (repo === null) notFound(); const session = await getServerSession(authOptions); const login = session?.user?.login;`
- Data fetches: `getRepoByOwnerAndName` (already at top), `getRepoBoardPage`, `getBookmarkedRepoIds`, `getRepoEcosystems`, plus the optional `redirect()` for out-of-range `?page=`
- Suspense boundaries: 3 (bookmark toggle, ecosystem+stats+description, board)

The refactor was applied, typecheck/lint/tests/build all passed (190 app tests, 774 core tests, full build), and then I re-measured LCP.

## The result (AFTER the round-4 refactor, BEFORE revert)

| Page | Metric | Before | After | Delta |
|---|---|---|---|---|
| `/` cold | LCP | 0.1 s | 0.1 s | ~same |
| `/` cold | renderDelay | 40 ms | 80 ms | **+40 ms (regression)** |
| `/` cold | CLS | 0.002 | **0.029** | **+0.027 (regression!)** |
| `/` warm (med) | LCP | 0.0 s | 0.0 s | ~same |
| `/` warm (med) | renderDelay | 28 ms | 29 ms | ~same |
| `/` warm (med) | CLS | 0.002 | 0.003 | ~same |
| `/repo` cold | LCP | 0.4 s | 0.4 s | ~same |
| `/repo` warm (med) | LCP | 0.3 s | 0.4 s | ~same |
| `/repo` warm (med) | renderDelay | 323 ms | 370 ms | +47 ms (regression) |
| `/repo` warm (med) | CLS | 0 | **0.029** | **+0.029 (regression!)** |

**No LCP improvement, CLS regressed on both pages.** The refactor was reverted. (See "Why it didn't work" below.)

## Why the round-3 pattern didn't carry over

**The visible `<main>` is still the loading skeleton after the refactor.** Verified by curl + DOM inspection:

- `/` HTML: visible `<main>` (796 bytes, all `animate-pulse` placeholders) + a second `<main>` inside `<div hidden>` containing the real content (6 repo cards, the LCP `<p>`, the indexed count).
- `/repo/.../deptend-go-test-fixture` HTML: visible `<main>` (762 bytes, all `animate-pulse` placeholders) + a second `<main>` inside `<div hidden>` containing the real content.

The LCP element is in the second `<main>`, not the visible one. Same as before.

The structural reason: the round-3 pattern relies on Next.js's streaming model flushing the JSX of the page's outer render as soon as the outer awaits resolve. On `/missions`, the outer render only awaits `searchParams` (a Promise resolved from the route props, not a network call) and the optional `redirect()`. So the page's outer render returns JSX immediately, and the `<Suspense>` boundary can stream the LCP text in the initial HTML while the data fetch is in flight.

On `/` and `/repo/...`, the outer render awaits **network calls**:
- `/`: `await getServerSession(authOptions)` — next-auth's `/api/auth/session` fetch
- `/repo/...`: `await getRepoByOwnerAndName(owner, name)` — Neon DB read; `await getServerSession(...)`

These outer awaits suspend the entire page-segment. Next.js serves the page-segment `loading.tsx` (the loading skeleton) until the outer awaits resolve. The LCP `<p>` is not in the visible main because the page hasn't produced any JSX yet. **The `<Suspense>` boundary inside the page can only stream content that the outer render has produced**, but the outer render's JSX is gated on the network calls.

**The fundamental difference:**

| Page | Outer await | Network? | Round-3 pattern works? |
|---|---|---|---|
| `/missions` | `await searchParams` (then `redirect()`) | No (route prop) | **Yes** |
| `/` | `await getServerSession(authOptions)` | **Yes** | **No** |
| `/repo/...` | `await getRepoByOwnerAndName`, `await getServerSession` | **Yes** | **No** |

For the round-3 pattern to work, the page's outer render must produce JSX without awaiting a network call. The LCP text on `/missions` is fully static; the LCP text on `/` is also static ("Every indexed repo..."); the LCP text on `/repo/...` is `repo.description`, which **is** data-dependent (a single-row primary-key read).

## Why the CLS regressed

The CLS regression from 0.002/0 to 0.029 on both pages is the cost of having **layout-shifting skeletons** in the visible area. The `HeaderRightSkeleton` and `SubmitFormSkeleton` reserve a fixed-height area in the visible main, but the data that replaces them may have a different size. On `/repo/...`, the `EcosystemAndStatsSkeleton` (3 lines of placeholder for the ecosystem badge + stars/ingested row + description) is wider than the resolved data, so the visible main shifts when the data lands. CLS measures the cumulative sum of those shifts, and a 0.029 score is the upper edge of "good" (the threshold is 0.1).

The round-3 refactor on `/missions` didn't regress CLS because the LCP text in the header is static and the `<Suspense>` boundaries only wrap the board area (not part of the visible main at first paint). The home and repo pages put the LCP-bearing text inside the boundary (because the outer render is gated), so the LCP text is part of the swap-in and the swap causes a layout shift.

## What would actually fix this

The fix isn't a `<Suspense>` boundary inside the page. The fix is to **avoid awaiting network calls in the page's outer render**. Two paths:

1. **Move `getServerSession` into a boundary.** The page can render the static chrome (LCP text, brand, AuthStatus's outer shape) and let a separate Server Component fetch the session asynchronously. `AuthStatus` is already a client component that takes a session prop; if its parent Server Component fetches the session in a boundary, the rest of the page can render the LCP immediately. The `login` value would be a `Promise<string | undefined>` passed to `getReposWithMissionSummary`, which would await it internally.

2. **Cookie-based session check at request time.** `getServerSession` is a thin wrapper around reading the `next-auth.session-token` cookie. A direct cookie read (via `next/headers`) is synchronous and doesn't trigger a network roundtrip. The page can read the cookie once, pass `login` to the data fetches synchronously, and the data fetches' network cost is the only thing gating the render.

Both paths are non-trivial refactors that touch the auth flow and the data-fetch signatures. They're also higher-risk than the round-3 fix (which was a local restructure of one page). Per AGENTS.md §0.3, this is a **decision point** worth raising before any code change.

For `/repo/...`, the LCP text is `repo.description`, which is the result of a network call (`getRepoByOwnerAndName`). The same path-1 pattern applies: the page can render a "Loading..." placeholder for the description, and the LCP fires on a static header element (e.g., the repo's name in the `<h1>`, or a skeleton). The visible LCP would then be a placeholder, not the description — and the actual description paints in a separate non-shifting way. But this changes the visual LCP element, which Lighthouse measures as the largest paint.

## What this round did NOT find

- **No new error-boundary regressions** — both pages render real content.
- **No new bundle-size regressions** — the build output is identical to the round-3 build (`/missions` 122 KiB, `/repo/[owner]/[name]` 134 KiB, shared 103 KiB). The `<Suspense>` boundaries are server-side only.
- **The data fetches are unchanged** — same `getReposWithMissionSummary`, `getRepoDirectorySummary`, `getRepoByOwnerAndName`, `getRepoBoardPage`, etc. The `unstable_cache` 60s TTL on these reads is unchanged.

## Cross-round summary

| Page | Round 1 (deployed prod) | Round 4 baseline (local prod) | Round 4 after-attempted (local prod) | Local verdict |
|---|---|---|---|---|
| `/` cold LCP | 1.0 s | 0.1 s | 0.1 s | already fast locally; no change needed |
| `/` warm LCP (med) | 0.6 s | 0.0 s | 0.0 s | already fast locally |
| `/repo/...` cold LCP | 0.8 s | 0.4 s | 0.4 s | needs deeper restructure |
| `/repo/...` warm LCP (med) | 0.7 s | 0.3 s | 0.4 s | **regressed by the refactor; revert** |
| `/repo/...` CLS | 0 | 0 | 0.029 | **regressed by the refactor; revert** |
| `/missions` cold LCP | 0.7 s | 0.3 s (round 3) | 0.3 s | round-3 win verified |
| `/missions` warm LCP (med) | 0.6 s | 0.1 s (round 3) | 0.1 s | round-3 win verified |

The home page is already fast locally because (a) the data is small (3-6 repos in the directory), (b) the LCP text is static, and (c) the LCP element ends up in the streamed `<div hidden>` content that paints before the JS swap. The 1.0s LCP on deployed prod in round 1 was almost entirely Vercel edge + TLS + JS hydration overhead, not the data fetch.

The per-repo board is the only page with a meaningful render-delay to address, and the round-3 pattern doesn't apply. The fix needs to be a deeper restructure (decision point above).

## Decision points surfaced (none auto-resolved per AGENTS.md §0.3)

1. **Move `getServerSession` out of the page outer render.** The most general fix; touches the auth/data-fetch signatures and the auth flow. Touches: every page that uses `getServerSession` (all three: `/`, `/missions`, `/repo/...`). Effort: 1-2 days. Risk: medium (auth is a security boundary; any change here deserves a careful review).
2. **Cookie-based session check.** A faster, lighter-weight alternative to `getServerSession`. Touches: same as #1. Effort: half a day. Risk: medium (need to verify the cookie's `secure` / `httpOnly` / `sameSite` semantics match next-auth's wrapper).
3. **Accept the round-1 LCP on `/repo/...` as "good enough".** 0.3-0.4s warm LCP on local prod is well within the 2.5s "good" threshold; the deployed prod's 0.8-0.9s is the only number that's borderline. A 1-day LCP fix may not be worth the auth-flow risk.
4. **Profile on deployed prod before deciding.** The local numbers don't tell the deployed story. Round 1's deployed-prod LCP for `/repo/...` was 0.8-0.9s. The 0.3-0.4s local number is for a `pnpm start` build with no Vercel overhead. A Vercel preview deploy is the right artifact for the "good enough" decision.
5. **Apply the round-3 pattern more carefully to the home page.** The LCP text is fully static, so the page outer render could in principle produce the JSX without `await getServerSession`. The session is only used by `getReposWithMissionSummary(login)` for the per-user bookmark overlay. If the per-user overlay is moved into a separate component that doesn't gate the LCP, the LCP could stream in. Effort: 1-2 hours. Risk: low (it's the same fix as #1 in a smaller form).

## What the working tree looks like after this round

- `app/src/app/page.tsx` and `app/src/app/repo/[owner]/[name]/page.tsx` are **reverted to HEAD + a 5-line re-apply of the user's WIP `BookmarkToggle` `repoFullName` prop** (which `git checkout HEAD --` had removed; the user's WIP `bookmark-toggle.tsx` change makes `repoFullName` a required prop, and HEAD's `repo/[owner]/[name]/page.tsx` doesn't pass it).
- `app/src/app/missions/page.tsx` and `app/src/app/missions/loading.tsx` still have the **round-3 refactor** (unchanged).
- All other files: the user's WIP + HEAD, unchanged.
- `pnpm typecheck`, `pnpm test` (190 app tests), `pnpm lint --max-warnings 0`, `pnpm format:check`, `pnpm build` all pass.

## Artifacts in this round

- 8 baseline Lighthouse JSONs: `baseline-{home,repo}-{cold,warm-1,warm-2,warm-3}.json` (some from `home-cold-2.json` for the second cold pass)
- 8 after-attempted Lighthouse JSONs: `after-attempted-{home,repo}-{cold,warm-1,warm-2,warm-3}.json` (the LCP/CLS numbers from the refactored code, preserved for the report)
- This summary

## How to reproduce the local comparison

```bash
# On perf/suspense-lcp-missions branch:
pnpm install
pnpm --filter @deptend/core build
pnpm --filter app build
pnpm --filter app start

# Lighthouse (cold)
CHROME_PATH=/Users/spiob/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell \
npx --yes lighthouse "http://localhost:3000/" \
  --quiet --output json --output-path /tmp/lh.json \
  --only-categories=performance --form-factor=desktop \
  --screenEmulation.disabled --throttling-method=provided \
  --chrome-flags="--headless=new --no-sandbox --disable-gpu --user-data-dir=/tmp/lh-cold --disable-cache --disk-cache-size=1"
```

## See also

- `round-1/summary.md` — the LCP render-delay root cause analysis that this round was meant to extend
- `round-3/summary.md` — the verified `<Suspense>` refactor on `/missions`
- `round-2/summary.md` — the chip-click + cache hit/miss round
- `reports/perf/2026-08-30/round-3/summary.md` — the canonical 2026-08-30 cache-hit/miss round
- AGENTS.md §12 (learned pitfalls) — the streaming-RSC `redirect()` gotcha (relevant to the repo page's canonicalization, not the LCP refactor)
- AGENTS.md §0.3 — the "decision point" rule for any change that touches the auth flow
