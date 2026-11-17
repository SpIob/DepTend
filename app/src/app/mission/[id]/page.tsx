import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { getMissionById } from "@/lib/queries/missions";
import { MissionHeader } from "@/components/mission-card/MissionHeader";
import { MissionScoreDetails } from "@/components/mission-card/MissionScoreDetails";
import { ScoreInputsList } from "@/components/mission-card/ScoreInputsList";
import { osvUrl } from "@/components/mission-card/utils";
import {
  CONFIDENCE_TEXT,
  CONFIDENCE_CLASS,
  CONFIDENCE_NOTES_BLOCK,
  CONFIDENCE_NOTES_HEADING,
  CONFIDENCE_NOTES_HEADING_DEFAULT,
  MISSION_TYPE_CLASS,
} from "@/components/mission-card/constants";
import { logRequestTimings } from "@/lib/timing/log";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: `Mission ${id}` };
}

export default async function MissionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const pageStartedAt = Date.now();

  const mission = await getMissionById(id);
  if (mission === null) {
    notFound();
  }

  const { score, advisory, dependency, repo } = mission;
  const isLowConfidence = score.confidence === "low";

  await logRequestTimings(`/mission/${id}`, Date.now() - pageStartedAt);

  return (
    <main id="main" className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-2">
        <nav
          className="flex items-center gap-2 font-mono text-xs text-ink-muted"
          aria-label="Breadcrumb"
        >
          <Link href="/" className="hover:text-ink">
            DepTend
          </Link>
          <span aria-hidden="true">/</span>
          <Link href="/missions" className="hover:text-ink">
            Missions
          </Link>
          <span aria-hidden="true">/</span>
          <Link href={`/repo/${repo.owner}/${repo.name}`} className="hover:text-ink">
            {repo.owner}/{repo.name}
          </Link>
          <span aria-hidden="true">/</span>
          <span className="text-ink">{mission.title}</span>
        </nav>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-2.5">
          <MissionHeader mission={mission} />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-ink-muted">
          <span className={CONFIDENCE_CLASS[score.confidence]}>
            {isLowConfidence && "⚠ "}
            {CONFIDENCE_TEXT[score.confidence]}
          </span>
          <span aria-hidden="true">·</span>
          <span
            className={MISSION_TYPE_CLASS[mission.missionType]}
            aria-label={`Mission type: ${mission.missionType.replace("_", " ")}`}
          >
            {mission.missionType.replace("_", " ")}
          </span>
          <span aria-hidden="true">·</span>
          <span>Effort: {score.effortLabel}</span>
        </div>

        <Link
          href={`https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`}
          className="w-fit font-mono text-xs text-ink-muted underline decoration-dotted underline-offset-2 hover:text-accent"
        >
          View repo on GitHub
        </Link>
      </header>

      <div className="flex flex-col gap-3 border-t border-border/60 px-4 py-4">
        <section aria-labelledby="description-heading">
          <h2 id="description-heading" className="sr-only">
            Description
          </h2>
          <p className="whitespace-pre-line text-sm leading-relaxed text-ink-muted">
            {mission.description}
          </p>
        </section>

        {mission.actionHint !== null && (
          <section aria-labelledby="action-hint-heading">
            <h2 id="action-hint-heading" className="sr-only">
              Recommended action
            </h2>
            <p className="border-l-2 border-border pl-3 text-sm font-medium text-ink">
              {mission.actionHint}
            </p>
          </section>
        )}

        <MissionScoreDetails
          score={score}
          isLowConfidence={isLowConfidence}
          advisory={advisory}
          dependency={dependency}
        />

        {advisory !== null && (
          <section aria-labelledby="advisory-heading">
            <h2 id="advisory-heading" className="sr-only">
              Advisory details
            </h2>
            <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
              <p className="font-mono text-xs uppercase text-ink-muted">Advisory</p>
              <dl className="flex flex-col gap-1.5 font-mono text-xs text-ink">
                <div className="flex gap-2">
                  <dt className="shrink-0 text-ink-muted">Source</dt>
                  <dd>{advisory.source.toUpperCase()}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0 text-ink-muted">OSV ID</dt>
                  <dd>
                    <a
                      href={osvUrl(advisory.osvId)}
                      className="text-accent underline decoration-dotted underline-offset-2"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {advisory.osvId}
                    </a>
                  </dd>
                </div>
                {dependency !== null && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-ink-muted">Package</dt>
                    <dd>{dependency.packageName}</dd>
                  </div>
                )}
                <div className="flex gap-2">
                  <dt className="shrink-0 text-ink-muted">Severity</dt>
                  <dd>{advisory.severity}</dd>
                </div>
                {advisory.cvssScore !== null && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-ink-muted">CVSS</dt>
                    <dd>{advisory.cvssScore.toFixed(1)}</dd>
                  </div>
                )}
                {advisory.fixedVersion !== null && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-ink-muted">Fixed version</dt>
                    <dd className="font-mono">{advisory.fixedVersion}</dd>
                  </div>
                )}
                {advisory.publishedAt !== null && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-ink-muted">Published</dt>
                    <dd>{advisory.publishedAt.toLocaleDateString()}</dd>
                  </div>
                )}
              </dl>
            </div>
          </section>
        )}

        <section aria-labelledby="score-breakdown-heading">
          <h2 id="score-breakdown-heading" className="sr-only">
            Full score breakdown
          </h2>
          <div className="border-t border-border/60 pt-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <ScoreInputsList
                label="Impact inputs"
                items={[
                  {
                    key: "CVSS",
                    value:
                      score.impactInputs.cvss_score !== null
                        ? score.impactInputs.cvss_score.toFixed(1)
                        : "unknown",
                  },
                  {
                    key: "Severity",
                    value: score.impactInputs.severity,
                  },
                  {
                    key: "Dependency type",
                    value: score.impactInputs.dep_type,
                  },
                  {
                    key: "Advisory age",
                    value:
                      score.impactInputs.days_since_advisory !== null
                        ? `${score.impactInputs.days_since_advisory.toString()}d`
                        : "unknown",
                  },
                ]}
              />
              <ScoreInputsList
                label="Ecosystem value inputs"
                items={[
                  {
                    key: "Repo stars",
                    value: score.ecosystemValueInputs.repo_stars.toLocaleString(),
                  },
                  {
                    key: "Open issues",
                    value: String(score.ecosystemValueInputs.open_issues_count),
                  },
                  {
                    key: "Downstream dependents",
                    value:
                      score.ecosystemValueInputs.downstream_dependents !== null
                        ? score.ecosystemValueInputs.downstream_dependents.toLocaleString()
                        : "not tracked yet",
                  },
                ]}
              />
              <ScoreInputsList
                label="Effort inputs"
                items={[
                  {
                    key: "Semver bump",
                    value: score.effortInputs.semver_bump,
                  },
                  {
                    key: "Migration guide",
                    value: score.effortInputs.has_migration_guide ? "available" : "not tracked yet",
                  },
                ]}
              />
            </div>
          </div>
        </section>

        {score.confidenceNotes !== null && score.confidenceNotes.length > 0 && (
          <section
            aria-labelledby="confidence-notes-heading"
            className="border-t border-border/60 pt-4"
          >
            <h2 id="confidence-notes-heading" className="sr-only">
              Confidence notes
            </h2>
            <div className={isLowConfidence ? CONFIDENCE_NOTES_BLOCK : ""}>
              <p
                className={
                  isLowConfidence ? CONFIDENCE_NOTES_HEADING : CONFIDENCE_NOTES_HEADING_DEFAULT
                }
              >
                Why {CONFIDENCE_TEXT[score.confidence].toLowerCase()}
              </p>
              <ul className="flex flex-col gap-0.5 text-ink">
                {score.confidenceNotes.map((note) => (
                  <li key={note}>· {note}</li>
                ))}
              </ul>
            </div>
          </section>
        )}

        <section aria-labelledby="status-heading" className="border-t border-border/60 pt-4">
          <h2 id="status-heading" className="sr-only">
            Mission status
          </h2>
          <dl className="flex flex-col gap-1.5 font-mono text-xs text-ink">
            <div className="flex gap-2">
              <dt className="shrink-0 text-ink-muted">Status</dt>
              <dd className="capitalize">{mission.status}</dd>
            </div>
            {mission.claimedBy !== null && (
              <>
                <div className="flex gap-2">
                  <dt className="shrink-0 text-ink-muted">Claimed by</dt>
                  <dd>{mission.claimedBy}</dd>
                </div>
                {mission.claimedAt !== null && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-ink-muted">Claimed at</dt>
                    <dd>{mission.claimedAt.toLocaleDateString()}</dd>
                  </div>
                )}
              </>
            )}
            {mission.dismissedAt !== null && (
              <>
                <div className="flex gap-2">
                  <dt className="shrink-0 text-ink-muted">Dismissed at</dt>
                  <dd>{mission.dismissedAt.toLocaleDateString()}</dd>
                </div>
                {mission.dismissReason !== null && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-ink-muted">Reason</dt>
                    <dd>{mission.dismissReason}</dd>
                  </div>
                )}
              </>
            )}
          </dl>
        </section>
      </div>

      <nav className="flex flex-wrap gap-2 font-mono text-xs" aria-label="Back links">
        <Link
          href="/missions"
          className="text-ink-muted underline decoration-dotted underline-offset-2 hover:text-accent"
        >
          ← All missions
        </Link>
        <Link
          href={`/repo/${repo.owner}/${repo.name}`}
          className="text-ink-muted underline decoration-dotted underline-offset-2 hover:text-accent"
        >
          ← Repo board
        </Link>
      </nav>
    </main>
  );
}
