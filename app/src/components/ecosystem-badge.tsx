import type { Ecosystem } from "@deptend/core/db/schema.js";

// Full literal class strings, not interpolated — same reasoning as
// severity-mark.tsx: Tailwind's JIT scanner needs to see each class name
// as-written to include it in the build.
const ECOSYSTEM_STYLES: Record<Ecosystem, { border: string; text: string; label: string }> = {
  npm: { border: "border-ecosystem-npm/40", text: "text-ecosystem-npm", label: "npm" },
  pypi: { border: "border-ecosystem-pypi/40", text: "text-ecosystem-pypi", label: "PyPI" },
  go: { border: "border-ecosystem-go/40", text: "text-ecosystem-go", label: "Go" },
};

export function EcosystemBadge({ ecosystem }: { ecosystem: Ecosystem }): React.JSX.Element {
  const style = ECOSYSTEM_STYLES[ecosystem];
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-sm border ${style.border} ${style.text} px-1.5 py-0.5 font-mono text-xs font-semibold uppercase tracking-wide`}
    >
      {style.label}
    </span>
  );
}
