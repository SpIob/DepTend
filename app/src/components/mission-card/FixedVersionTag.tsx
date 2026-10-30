"use client";

export function FixedVersionTag({ version }: { version: string }): React.JSX.Element {
  return (
    <span className="shrink-0 rounded-sm border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] text-ink">
      Fix: {version}
    </span>
  );
}
