// Skeleton for the all-missions board while its Neon reads are in flight.
//
// Round 3 of the 2026-09-05 perf series (reports/perf/2026-09-05/round-3)
// moved the LCP <p> in the page header outside the <Suspense> boundary, so
// it streams in with the initial HTML payload and no longer needs a
// skeleton placeholder. This file's skeleton is what Next.js shows for the
// page-segment fallback when the page itself is suspended; since the LCP
// text is now part of the unsuspended render, the LCP-area placeholder
// would cause a layout jump as it gets replaced. The skeleton here covers
// only the data-dependent area (the board) so the LCP paints stably and
// the rest streams in.
export default function Loading(): React.JSX.Element {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      {/* Header chrome skeleton only (brand + h1 on the left, AuthStatus on
          the right). The LCP <p> is rendered by the page directly with
          the initial HTML; the page-level loading skeleton shown while the
          whole page is suspended from the segment boundary no longer needs
          to cover it. */}
      <div className="border-border flex flex-col gap-5 border-b pb-6">
        <div className="flex items-center justify-between">
          <div className="bg-surface h-6 w-40 animate-pulse rounded-md" />
          <div className="bg-surface h-4 w-48 animate-pulse rounded-md" />
        </div>
      </div>
      <ul className="flex flex-col gap-3">
        {(["mission-0", "mission-1", "mission-2", "mission-3"] as const).map((key) => (
          <li key={key} className="border-border bg-surface h-24 animate-pulse rounded-md border" />
        ))}
      </ul>
    </main>
  );
}
