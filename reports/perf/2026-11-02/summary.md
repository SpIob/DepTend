# 2026-11-02 Production performance audit

Evidence trail for the audit Mico requested ("Do a performance check on the production side").
Sources: weekly Lighthouse run 41291155920 (2026-11-01 09:59 UTC, all four pages green), live
curl probes against `deptend.vercel.app`, Vercel MCP deployment metadata, Neon MCP production
reads. Outcome: read path healthy; one real defect found and fixed (ADR 0062, timing store).

## Live probes (curl, 2026-11-02, from sin1-adjacent vantage)

| Path | First hit TTFB | Warm TTFB (3 passes) | HTML bytes | Brotli wire |
| --- | --- | --- | --- | --- |
| `/` | 2.384 s (cold/suspend) | 0.165–0.195 s | 38,536 | 7,071 B |
| `/missions` | — | ~0.20 s | 433,024 | 22,091 B |
| `/org/SpIob` | — | ~0.23 s | 33,861 | — |
| `/repo/SpIob/deptend-go-test-fixture` | — | ~0.49 s | 552,055 | 20,914 B |
| `/repo/psf/requests` | — | ~0.21 s | 505,306 | 20,914 B |

- First-hit TTFB spikes are Hobby function suspend, not page cost: repeat passes settle at
  ~0.17–0.2 s. The `perf.yml` "Warm Vercel functions" step exists for exactly this.
- All responses `x-vercel-cache: MISS`, `cache-control: private, no-cache, no-store` — expected:
  every page is `force-dynamic` (ADR 0033 caches at the query layer, 60 s TTL, not the page).
- Brotli applied on HTML (`content-encoding: br`); 433 KB → 22 KB wire on `/missions`.
- `server-timing: total;dur≈0.4–1.0` (middleware phase only, ADR 0052).
- Static chunks: `cache-control: public,max-age=31536000,immutable` — correct.

## Lighthouse (run 41291155920, desktop, provided throttling)

| Page | Perf score | FCP | LCP | TBT | CLS | TTI | server-response-time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/` | 99 | 573 | 922 | 0 | 0 | 627 | 2 |
| `/missions` | 99 | 317 | 317 | 93 | 0 | 1034 | 2 |
| `/org/SpIob` | 100 | 388 | 388 | 0 | 0 | 388 | 2 |
| `/repo/…go-test-fixture` | 100 | 335 | 695 | 0 | 0 | 547 | 2 |

No render-blocking, no unused JS, no image/compression opportunities flagged. Total byte weight
~150–164 KB per page (score 1). Zero third-party scripts.

## Infrastructure facts verified

- Production serves commit `325eb3d` (dpl_4NwtQinhPNbCu9WuFoNmim7SB6BG, READY, aliased to
  `deptend.vercel.app`); the two prior ERROR deployments (`d112ec8` was fixed by `325eb3d`).
- Function region `sin1` — co-located with Neon `aws-ap-southeast-1`. No region move available.
- `pg_stat_statements` is NOT installed on prod Neon; `list_slow_queries` cannot run there
  (installing the extension is a decision point). DB-side latency evidence therefore comes from
  warm TTFB (~170 ms end-to-end incl. TLS) — no slow-query signal at current scale.
- Prod mission counts: FlowState 85, psf/requests 59, go-fixture 58, DepTend 25.

## Defect found and fixed

**Per-request timing store grew without bound** (`app/src/lib/timing/store.ts`):

- `withTiming()` records entries on every page render (via `lib/queries/missions.ts` +
  `cached-read.ts`).
- Production's only reader (`logTimingsForRequest`, `/missions` alone) early-returns before
  reading (`log.ts` production guard) — writes with no reads.
- Nothing deleted a request's store: one Map entry per request for the process lifetime.

Fix (ADR 0062, this pass): `deleteStore()` after the logger's final read in both terminal paths
+ `MAX_STORED_REQUESTS` (10,000) oldest-inserted eviction cap in `getOrCreateStore()`, mirroring
`rate-limit-redis.ts`'s `MAX_FALLBACK_KEYS`. 6 new tests in `store.eviction.test.ts`.

## Improvement backlog (status after the same-day follow-up pass)

1. **Per-repo page payload ceiling** — `/repo/[owner]/[name]` ships the repo's entire mission
   list (`getRepoBoardPage(repo.id, filters, { limit: 1000 })`, pagination deliberately
   suppressed per ADR 0031). Today ≤ 59 missions/repo so it's bounded in practice; if a repo
   with hundreds of missions is ever ingested, the HTML document scales linearly. Watch it; a
   per-repo pagination or "show top N" would be the fix when real data demands it.
   **Status: deliberately not built** (bounded at 59 vs 1000; changing ADR 0031/0042 design
   without a data driver would re-litigate a settled decision).
2. **`pg_stat_statements` on prod Neon** — **DONE 2026-11-02** (user-approved `CREATE
   EXTENSION` via Neon MCP; verified live: 83 statements tracked, `list_slow_queries` returns
   real data, top entries Neon-internal, no app-query red flags). Still absent on the dev
   branch; install there only if dev-side diagnostics ever need it.
3. **ADR 0052 per-segment timing** — **DONE 2026-11-02**: all four read pages now call
   `logRequestTimings()`; validated live with a production build + `DEPTEND_TIMING_LOG=1`
   against real Neon. Sample lines (full text in the CHANGELOG's 2026-11-02 entry):
   - `/repo/SpIob/deptend-go-test-fixture`: `repos:by-owner-name` 38.1 ms,
     `cache:missions:miss/db` 189.4 ms, `cache:missions:revive` 9.3 ms (totalMs 238)
   - `/` (Neon compute cold): `cache:repos:db` 5636.3 ms of totalMs 2849 — the first-hit cost
     the weekly warm-step exists for, now attributable per-segment
   - `/missions` warm: `cache:repos:hit` 2 ms (cache-hit path visible at last)
   Production keeps the default off; enabling telemetry is one Vercel env var
   (`DEPTEND_TIMING_LOG=1`) away.
