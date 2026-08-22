// Skeleton for a repo page while its Neon reads are in flight — mirrors
// the page's max-w-3xl container and card stack so nothing jumps on swap.
export default function Loading(): React.JSX.Element {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <div className="border-border flex flex-col gap-5 border-b pb-6">
        <div className="flex items-center justify-between">
          <div className="bg-surface h-6 w-56 animate-pulse rounded-md" />
          <div className="bg-surface h-4 w-32 animate-pulse rounded-md" />
        </div>
        <div className="bg-surface h-4 w-full max-w-md animate-pulse rounded-md" />
      </div>
      <ul className="flex flex-col gap-3">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="border-border bg-surface h-44 animate-pulse rounded-md border" />
        ))}
      </ul>
    </main>
  );
}
