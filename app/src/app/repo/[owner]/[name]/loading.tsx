// Skeleton for a repo page while its Neon reads are in flight — mirrors
// the page's max-w-3xl container and card stack so nothing jumps on swap.
export default function Loading(): React.JSX.Element {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex flex-col gap-5 border-b border-border pb-6">
        <div className="flex items-center justify-between">
          <div className="h-6 w-56 animate-pulse rounded-md bg-surface" />
          <div className="h-4 w-32 animate-pulse rounded-md bg-surface" />
        </div>
        <div className="h-4 w-full max-w-md animate-pulse rounded-md bg-surface" />
      </div>
      <ul className="flex flex-col gap-3">
        {(["mission-0", "mission-1", "mission-2", "mission-3"] as const).map((key) => (
          <li key={key} className="h-44 animate-pulse rounded-md border border-border bg-surface" />
        ))}
      </ul>
    </main>
  );
}
