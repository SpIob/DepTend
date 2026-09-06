"use client";

export function FixedVersionTag({ version }: { version: string }): React.JSX.Element {
  return (
    <span className="border-border bg-bg text-ink shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[11px]">
      Fix: {version}
    </span>
  );
}
