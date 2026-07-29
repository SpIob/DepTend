import type { Severity } from "@deptend/core/db/schema.js";
import { Tag } from "./tag";

// Full literal class strings, not interpolated — Tailwind's JIT scanner
// needs to see each class name as-written to include it in the build.
const SEVERITY_STYLES: Record<Severity, { className: string; label: string }> = {
  critical: { className: "bg-severity-critical/10 text-severity-critical", label: "Critical" },
  high: { className: "bg-severity-high/10 text-severity-high", label: "High" },
  medium: { className: "bg-severity-medium/10 text-severity-medium", label: "Medium" },
  low: { className: "bg-severity-low/10 text-severity-low", label: "Low" },
  unknown: { className: "bg-severity-unknown/10 text-severity-unknown", label: "Unknown" },
};

// Renamed from severityBorderClass: the card's severity accent moves from a
// `border-l-4` (which visibly notches at the corner once the card radius
// goes above ~2px — border-radius rounds every side, including a solid
// single-side border color) to a full-height flex-child bar clipped by the
// card's own `overflow: hidden`. Same lookup, different property.
export function severityBarClass(severity: Severity): string {
  const map: Record<Severity, string> = {
    critical: "bg-severity-critical",
    high: "bg-severity-high",
    medium: "bg-severity-medium",
    low: "bg-severity-low",
    unknown: "bg-severity-unknown",
  };
  return map[severity];
}

export function SeverityMark({ severity }: { severity: Severity }): React.JSX.Element {
  const style = SEVERITY_STYLES[severity];
  return <Tag className={style.className}>{style.label}</Tag>;
}
