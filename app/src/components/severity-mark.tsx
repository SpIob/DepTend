import type { Severity } from "@deptend/core/db/schema.js";

// Full literal class strings, not interpolated — Tailwind's JIT scanner
// needs to see each class name as-written to include it in the build.
const SEVERITY_STYLES: Record<Severity, { dot: string; text: string; label: string }> = {
  critical: { dot: "bg-severity-critical", text: "text-severity-critical", label: "Critical" },
  high: { dot: "bg-severity-high", text: "text-severity-high", label: "High" },
  medium: { dot: "bg-severity-medium", text: "text-severity-medium", label: "Medium" },
  low: { dot: "bg-severity-low", text: "text-severity-low", label: "Low" },
  unknown: { dot: "bg-severity-unknown", text: "text-severity-unknown", label: "Unknown" },
};

export function severityBorderClass(severity: Severity): string {
  const map: Record<Severity, string> = {
    critical: "border-l-severity-critical",
    high: "border-l-severity-high",
    medium: "border-l-severity-medium",
    low: "border-l-severity-low",
    unknown: "border-l-severity-unknown",
  };
  return map[severity];
}

export function SeverityMark({ severity }: { severity: Severity }): React.JSX.Element {
  const style = SEVERITY_STYLES[severity];
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold uppercase tracking-wide">
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden="true" />
      <span className={style.text}>{style.label}</span>
    </span>
  );
}
