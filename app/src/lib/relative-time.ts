/**
 * Relative time formatting — small pure function for "X ago" strings.
 * No dependencies, no Intl.RelativeTimeFormat (not widely supported in
 * edge runtimes), just straightforward thresholds.
 */
export function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const then = date.getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);

  if (diffSec < 60) {
    return "just now";
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  if (diffHour < 24) {
    return `${diffHour}h ago`;
  }
  if (diffDay < 7) {
    return `${diffDay}d ago`;
  }
  if (diffWeek < 4) {
    return `${diffWeek}w ago`;
  }
  if (diffMonth < 12) {
    return `${diffMonth}mo ago`;
  }
  return `${diffYear}y ago`;
}
