import type {
  AdvisorySource,
  DepType,
  EffortLabel,
  ScoreConfidence,
  Severity,
} from "@deptend/core/db/schema.js";
import type { EcosystemValueInputs, EffortInputs, ImpactInputs } from "@deptend/core";

export interface AnalyzeOptions {
  /** Local filesystem path to the repo root (containing package.json). */
  repoPath: string;
  githubOwner: string;
  githubName: string;
  /** null for unauthenticated GitHub API calls (60 req/hr instead of 5,000). */
  githubToken: string | null;
}

/**
 * One scored, explainable mission — mirrors what the web dashboard shows
 * (title/description/action_hint, every scoring input, source references)
 * per the project's explainability standard: no score without the data
 * that produced it being immediately accessible.
 */
export interface AnalyzedMission {
  title: string;
  description: string;
  action_hint: string | null;
  composite_score: number;
  impact_score: number;
  ecosystem_value_score: number;
  effort_label: EffortLabel;
  confidence: ScoreConfidence;
  confidence_notes: string[];
  scoring_version: string;
  scoring_inputs: {
    impact: ImpactInputs;
    effort: EffortInputs;
    ecosystem_value: EcosystemValueInputs;
  };
  dependency: {
    package_name: string;
    version_spec: string;
    dep_type: DepType;
    latest_version: string | null;
    is_deprecated: boolean;
  };
  advisory: {
    osv_id: string;
    source: AdvisorySource;
    severity: Severity;
    cvss_score: number | null;
    fixed_version: string | null;
    summary: string;
    url: string;
  };
}

export interface AnalyzeResult {
  generated_at: string;
  repo: {
    github_url: string;
    owner: string;
    name: string;
    default_branch: string;
    stars: number;
    open_issues_count: number;
  };
  dependencies_scanned: number;
  lock_file_present: boolean;
  missions: AnalyzedMission[];
  /** Data-quality warnings aggregated across the whole pipeline. */
  warnings: string[];
}
