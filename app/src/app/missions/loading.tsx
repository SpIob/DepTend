// Skeleton for the all-missions board while its Neon reads are in flight —
// mirrors missions/page.tsx's container so the swap doesn't jump the layout.
export default function Loading(): React.JSX.Element {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <div className="border-border flex flex-col gap-5 border-b pb-6">
        <div className="flex items-center justify-between">
          <div className="bg-surface h-6 w-40 animate-pulse rounded-md" />
          <div className="bg-surface h-4 w-48 animate-pulse rounded-md" />
        </div>
        <div className="bg-surface h-10 w-full animate-pulse rounded-md" />
        <div className="flex flex-wrap gap-2">
          {(["chip-0", "chip-1", "chip-2", "chip-3", "chip-4"] as const).map((key) => (
            <div key={key} className="bg-surface h-6 w-20 animate-pulse rounded-sm" />
          ))}
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
