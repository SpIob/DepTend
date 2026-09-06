"use client";

import type { MissionWithScore } from "@deptend/core";
import { osvUrl } from "./utils";
import { ScoreInputsList } from "./ScoreInputsList";
import {
  CONFIDENCE_TEXT,
  CONFIDENCE_NOTES_BLOCK,
  CONFIDENCE_NOTES_HEADING,
  CONFIDENCE_NOTES_HEADING_DEFAULT,
} from "./constants";

interface MissionScoreDetailsProps {
  score: MissionWithScore["score"];
  isLowConfidence: boolean;
  advisory: MissionWithScore["advisory"];
  dependency: MissionWithScore["dependency"];
}

export function MissionScoreDetails({
  score,
  isLowConfidence,
  advisory,
  dependency,
}: MissionScoreDetailsProps): React.JSX.Element {
  const cvss =
    score.impactInputs.cvss_score !== null ? score.impactInputs.cvss_score.toFixed(1) : "unknown";
  const advisoryAge =
    score.impactInputs.days_since_advisory !== null
      ? `${score.impactInputs.days_since_advisory.toString()}d`
      : "unknown";

  return (
    <details className="group/score -mx-4 -mb-4 mt-1">
      <summary className="text-ink-muted hover:text-ink hover:bg-bg border-border/60 flex items-center gap-1.5 border-t px-4 py-3 font-mono text-xs font-medium focus-visible:outline-offset-[-2px]">
        <span className="transition-transform group-open/score:rotate-90">▸</span>
        Why this score?
      </summary>
      <div className="bg-bg border-border/60 flex flex-col gap-4 border-t px-4 py-4 font-mono text-xs">
        <div>
          <p className="text-ink-muted mb-1 uppercase">Formula</p>
          <p className="text-ink">
            0.60 × impact ({score.impactScore.toFixed(1)}) + 0.40 × ecosystem value (
            {score.ecosystemValueScore.toFixed(1)}) = {score.compositeScore.toFixed(1)}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <ScoreInputsList
            label="Impact inputs"
            items={[
              { key: "CVSS", value: cvss },
              { key: "Severity", value: score.impactInputs.severity },
              { key: "Dependency type", value: score.impactInputs.dep_type },
              { key: "Advisory age", value: advisoryAge },
            ]}
          />
          <ScoreInputsList
            label="Ecosystem value inputs"
            items={[
              { key: "Repo stars", value: score.ecosystemValueInputs.repo_stars.toLocaleString() },
              { key: "Open issues", value: String(score.ecosystemValueInputs.open_issues_count) },
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
              { key: "Semver bump", value: score.effortInputs.semver_bump },
              {
                key: "Migration guide",
                value: score.effortInputs.has_migration_guide ? "available" : "not tracked yet",
              },
            ]}
          />
        </div>

        {score.confidenceNotes !== null && score.confidenceNotes.length > 0 && (
          <div className={isLowConfidence ? CONFIDENCE_NOTES_BLOCK : ""}>
            <p
              className={
                isLowConfidence ? CONFIDENCE_NOTES_HEADING : CONFIDENCE_NOTES_HEADING_DEFAULT
              }
            >
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
  );
}
