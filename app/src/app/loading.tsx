// Skeleton for the repo directory while its Neon reads are in flight —
// mirrors page.tsx's container so the swap doesn't jump the layout.
export default function Loading(): React.JSX.Element {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <div className="border-border flex flex-col gap-5 border-b pb-6">
        <div className="flex items-center justify-between">
          <div className="bg-surface h-6 w-40 animate-pulse rounded-md" />
          <div className="bg-surface h-4 w-48 animate-pulse rounded-md" />
        </div>
        <div className="bg-surface h-10 w-full max-w-xl animate-pulse rounded-md" />
      </div>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="border-border bg-surface h-36 animate-pulse rounded-md border" />
        ))}
      </ul>
    </main>
  );
}
