/**
 * Shared visual shape for every small metadata label on a mission card —
 * severity, ecosystem, effort. Previously three inconsistent treatments
 * (a dot, a bordered box, and plain text); this is the one shape all of
 * them render through now. Color is passed in as a literal Tailwind class
 * string by each caller (SeverityMark, EcosystemBadge, and mission-card's
 * claimed tag) rather
 * than parameterized here, since Tailwind's JIT scanner needs to see each
 * class name as-written — a generic `color` prop that builds class names
 * at runtime would silently fail to compile in.
 */
export function Tag({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide ${className}`}
    >
      {children}
    </span>
  );
}
