import type { EffortLabel, ScoreConfidence } from "@deptend/core/db/schema.js";
import type { MissionWithScore } from "@deptend/core";
import { SeverityMark, severityBorderClass } from "./severity-mark";

const EFFORT_LABEL_TEXT: Record<EffortLabel, string> = {
  trivial: "Trivial effort",
  low: "Low effort",
  medium: "Medium effort",
  high: "High effort",
};

const CONFIDENCE_TEXT: Record<ScoreConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

const CONFIDENCE_CLASS: Record<ScoreConfidence, string> = {
  high: "text-ink-muted",
  medium: "text-severity-medium",
  low: "text-severity-high",
};

function osvUrl(osvId: string): string {
  return `https://osv.dev/vulnerability/${encodeURIComponent(osvId)}`;
}

export function MissionCard({ mission }: { mission: MissionWithScore }): React.JSX.Element {
  const { score, advisory, dependency, repo } = mission;
  const severity = advisory?.severity ?? "unknown";
  const isLowConfidence = score.confidence === "low";

  return (
    <article
      className={`border-border bg-surface border border-l-4 ${severityBorderClass(severity)} rounded-sm`}
    >
      <div className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex flex-col gap-1.5">
            <SeverityMark severity={severity} />
            <h2 className="text-ink text-balance text-base font-semibold leading-snug">
              {mission.title}
            </h2>
          </div>
          <div className="flex shrink-0 items-baseline gap-2 font-mono">
            <span className="text-accent text-2xl font-bold" title="Composite score, out of 10">
              {score.compositeScore.toFixed(1)}
            </span>
            <span className="text-ink-muted text-xs">/10</span>
          </div>
        </div>

        <p className="text-ink-muted whitespace-pre-line text-sm leading-relaxed">
          {mission.description}
        </p>

        {mission.actionHint !== null && (
          <p className="text-ink border-border border-l-2 pl-3 text-sm font-medium">
            {mission.actionHint}
          </p>
        )}

        <div className="text-ink-muted flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs">
          <span>{EFFORT_LABEL_TEXT[score.effortLabel]}</span>
          <span aria-hidden="true">·</span>
          <span className={isLowConfidence ? "font-semibold" : ""}>
            <span className={CONFIDENCE_CLASS[score.confidence]}>
              {isLowConfidence && "⚠ "}
              {CONFIDENCE_TEXT[score.confidence]}
            </span>
          </span>
          <span aria-hidden="true">·</span>
          <a
            href={`https://github.com/${repo.owner}/${repo.name}`}
            className="hover:text-accent underline decoration-dotted underline-offset-2"
          >
            {repo.owner}/{repo.name}
          </a>
        </div>

        <details className="group -mx-5 -mb-5 mt-1">
          <summary className="text-ink-muted hover:text-ink hover:bg-bg border-border/60 flex items-center gap-1.5 border-t px-5 py-3 font-mono text-xs font-medium">
            <span className="transition-transform group-open:rotate-90">▸</span>
            Why this score?
          </summary>
          <div className="bg-bg border-border/60 flex flex-col gap-4 border-t px-5 py-4 font-mono text-xs">
            <div>
              <p className="text-ink-muted mb-1 uppercase">Formula</p>
              <p className="text-ink">
                0.60 × impact ({score.impactScore.toFixed(1)}) + 0.40 × ecosystem value (
                {score.ecosystemValueScore.toFixed(1)}) = {score.compositeScore.toFixed(1)}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <p className="text-ink-muted mb-1 uppercase">Impact inputs</p>
                <ul className="text-ink flex flex-col gap-0.5">
                  <li>
                    CVSS:{" "}
                    {score.impactInputs.cvss_score !== null
                      ? score.impactInputs.cvss_score.toFixed(1)
                      : "unknown"}
                  </li>
                  <li>Severity: {score.impactInputs.severity}</li>
                  <li>Dependency type: {score.impactInputs.dep_type}</li>
                  <li>
                    Advisory age:{" "}
                    {score.impactInputs.days_since_advisory !== null
                      ? `${score.impactInputs.days_since_advisory.toString()}d`
                      : "unknown"}
                  </li>
                </ul>
              </div>

              <div>
                <p className="text-ink-muted mb-1 uppercase">Ecosystem value inputs</p>
                <ul className="text-ink flex flex-col gap-0.5">
                  <li>Repo stars: {score.ecosystemValueInputs.repo_stars.toLocaleString()}</li>
                  <li>Open issues: {score.ecosystemValueInputs.open_issues_count}</li>
                  <li>
                    Downstream dependents:{" "}
                    {score.ecosystemValueInputs.downstream_dependents ?? "not tracked yet"}
                  </li>
                </ul>
              </div>

              <div>
                <p className="text-ink-muted mb-1 uppercase">Effort inputs</p>
                <ul className="text-ink flex flex-col gap-0.5">
                  <li>Semver bump: {score.effortInputs.semver_bump}</li>
                  <li>
                    Migration guide:{" "}
                    {score.effortInputs.has_migration_guide ? "available" : "not tracked yet"}
                  </li>
                </ul>
              </div>
            </div>

            {score.confidenceNotes !== null && score.confidenceNotes.length > 0 && (
              <div>
                <p className="text-ink-muted mb-1 uppercase">
                  Why {CONFIDENCE_TEXT[score.confidence].toLowerCase()}
                </p>
                <ul className="text-ink flex flex-col gap-0.5">
                  {score.confidenceNotes.map((note) => (
                    <li key={note}>· {note}</li>
                  ))}
                </ul>
              </div>
            )}

            {advisory !== null && (
              <div>
                <p className="text-ink-muted mb-1 uppercase">Source</p>
                <p className="text-ink">
                  {advisory.source.toUpperCase()} advisory{" "}
                  <a
                    href={osvUrl(advisory.osvId)}
                    className="text-accent underline decoration-dotted underline-offset-2"
                  >
                    {advisory.osvId}
                  </a>
                  {dependency !== null && <> for {dependency.packageName}</>}
                </p>
              </div>
            )}
          </div>
        </details>
      </div>
    </article>
  );
}
