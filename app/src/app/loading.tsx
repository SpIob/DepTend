// Skeleton for the repo directory while its Neon reads are in flight —
// mirrors page.tsx's container so the swap doesn't jump the layout.
export default function Loading(): React.JSX.Element {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex flex-col gap-5 border-b border-border pb-6">
        <div className="flex items-center justify-between">
          <div className="h-6 w-40 animate-pulse rounded-md bg-surface" />
          <div className="h-4 w-48 animate-pulse rounded-md bg-surface" />
        </div>
        <div className="h-10 w-full max-w-xl animate-pulse rounded-md bg-surface" />
      </div>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {(["skeleton-0", "skeleton-1", "skeleton-2", "skeleton-3"] as const).map((key) => (
          <li key={key} className="h-36 animate-pulse rounded-md border border-border bg-surface" />
        ))}
      </ul>
    </main>
  );
}
