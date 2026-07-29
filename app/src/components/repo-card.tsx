import Link from "next/link";
import type { Severity } from "@deptend/core/db/schema.js";
import type { RepoWithMissionSummary } from "@deptend/core";
import { EcosystemBadge } from "./ecosystem-badge";
import { BookmarkToggle } from "./bookmark-toggle";
import { ingestionStatusNote } from "@/lib/ingestion-status";

const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "unknown"];

// Text-color reuse of severity-mark.tsx's own palette, not a new one —
// a compact per-repo count row doesn't need the full Tag treatment every
// mission card uses, just the same color language.
const SEVERITY_TEXT_CLASS: Record<Severity, string> = {
  critical: "text-severity-critical",
  high: "text-severity-high",
  medium: "text-severity-medium",
  low: "text-severity-low",
  unknown: "text-severity-unknown",
};

function MissionCounts({
  counts,
}: {
  counts: RepoWithMissionSummary["missionCounts"];
}): React.JSX.Element {
  if (counts.total === 0) {
    return <span className="text-ink-muted font-mono text-xs">No open missions</span>;
  }
  const present = SEVERITY_ORDER.filter((severity) => counts[severity] > 0);
  return (
    <span className="flex flex-wrap items-center gap-x-2 font-mono text-xs">
      {present.map((severity) => (
        <span key={severity} className={SEVERITY_TEXT_CLASS[severity]}>
          {counts[severity]} {severity}
        </span>
      ))}
    </span>
  );
}

export function RepoCard({ repo }: { repo: RepoWithMissionSummary }): React.JSX.Element {
  const statusNote = ingestionStatusNote(repo.ingestionStatus);

  return (
    <article className="border-border bg-surface hover:border-ink-muted/50 flex flex-col gap-3 rounded-md border p-4 transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/repo/${repo.owner}/${repo.name}`}
          className="text-ink hover:text-accent min-w-0 truncate text-sm font-semibold"
        >
          {repo.owner}/{repo.name}
        </Link>
        <BookmarkToggle repoId={repo.id} initialBookmarked={repo.isBookmarked} />
      </div>

      {repo.description !== null && repo.description !== "" && (
        <p className="text-ink-muted line-clamp-2 text-xs leading-relaxed">{repo.description}</p>
      )}

      {repo.ecosystems.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {repo.ecosystems.map((ecosystem) => (
            <EcosystemBadge key={ecosystem} ecosystem={ecosystem} />
          ))}
        </div>
      )}

      {statusNote !== null ? (
        <span className="text-ink-muted font-mono text-xs">{statusNote}</span>
      ) : (
        <MissionCounts counts={repo.missionCounts} />
      )}

      <div className="text-ink-muted border-border/60 flex items-center justify-between border-t pt-2 font-mono text-[11px]">
        <span>★ {repo.stars.toLocaleString()}</span>
        {repo.lastIngestedAt !== null && (
          <span>Ingested {repo.lastIngestedAt.toLocaleDateString()}</span>
        )}
      </div>
    </article>
  );
}
