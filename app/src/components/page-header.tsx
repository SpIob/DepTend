/**
 * Shared page-header shell used by every public page (/, /missions,
 * /repo/[owner]/[name], /org/[org]). Renders the outer <header> + the
 * top "left | right" row; the page-specific middle content (descriptions,
 * submit forms, repo stats) goes in the `children` slot.
 *
 * Extracted from four near-identical inline headers that each had the
 * same `border-border flex flex-col gap-5 border-b pb-6` shell wrapping
 * a brand on the left and indexed-count + AuthStatus on the right.
 * Precedent: `BrandMark` was extracted the same way per its own
 * docstring ("the only way a designer changing its size or weight
 * actually changes it everywhere at once").
 */

export function PageHeader({
  left,
  right,
  children,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <header className="border-border flex flex-col gap-5 border-b pb-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">{left}</div>
        <div className="text-ink-muted flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
          {right}
        </div>
      </div>
      {children}
    </header>
  );
}
