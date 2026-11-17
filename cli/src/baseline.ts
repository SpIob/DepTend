/**
 * Baseline diff utility
 *
 * Compares current analysis results against a previous baseline run
 * (the JSON output from --output). Matching key: osv_id + package_name + ecosystem.
 */

import type { AnalyzeResult, AnalyzedMission } from "./types.js";

export interface BaselineDiff {
  added: AnalyzedMission[];
  resolved: AnalyzedMission[];
  unchanged: AnalyzedMission[];
}

export interface BaselineFile {
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
  ecosystem: string;
  lock_file_present: boolean;
  missions: {
    composite_score: number;
    impact_score: number;
    ecosystem_value_score: number;
    effort_label: string;
    confidence: string;
    confidence_notes: string[];
    scoring_version: string;
    scoring_inputs: {
      impact: {
        cvss_score: number | null;
        severity: string;
        is_transitive: boolean;
        dep_type: string;
        days_since_advisory: number;
        epss_score: number | null;
      };
      effort: {
        semver_bump: string;
        has_migration_guide: boolean;
        breaking_change_signals: string[];
      };
      ecosystem_value: {
        repo_stars: number;
        open_issues_count: number;
        downstream_dependents: number | null;
      };
    };
    dependency: {
      package_name: string;
      version_spec: string;
      dep_type: string;
      latest_version: string | null;
      is_deprecated: boolean;
    };
    advisory: {
      osv_id: string;
      source: string;
      severity: string;
      cvss_score: number | null;
      fixed_version: string | null;
      summary: string;
      url: string;
    };
  }[];
  warnings: string[];
}

/**
 * Creates a stable matching key for a mission.
 * Key: osv_id + package_name + ecosystem
 */
function getMissionKey(
  mission: { advisory: { osv_id: string }; dependency: { package_name: string } },
  ecosystem: string,
): string {
  return `${mission.advisory.osv_id}|${mission.dependency.package_name}|${ecosystem}`;
}

/**
 * Validates that a baseline file has the expected structure.
 * Returns the parsed baseline or null if malformed.
 */
export function parseBaselineFile(content: string): BaselineFile | null {
  try {
    const parsed = JSON.parse(content) as BaselineFile;

    // Validate required fields
    if (
      typeof parsed.generated_at !== "string" ||
      !parsed.repo ||
      typeof parsed.repo.owner !== "string" ||
      typeof parsed.repo.name !== "string" ||
      typeof parsed.ecosystem !== "string" ||
      !Array.isArray(parsed.missions)
    ) {
      return null;
    }

    // Validate each mission has required fields
    for (const mission of parsed.missions) {
      if (
        !mission.advisory ||
        typeof mission.advisory.osv_id !== "string" ||
        mission.advisory.osv_id.length === 0 ||
        !mission.dependency ||
        typeof mission.dependency.package_name !== "string" ||
        mission.dependency.package_name.length === 0
      ) {
        return null;
      }
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Computes the diff between current missions and baseline missions.
 */
export function computeBaselineDiff(current: AnalyzeResult, baseline: BaselineFile): BaselineDiff {
  const added: AnalyzedMission[] = [];
  const resolved: AnalyzedMission[] = [];
  const unchanged: AnalyzedMission[] = [];

  // Build maps for O(1) lookup
  const currentMap = new Map<string, AnalyzedMission>();
  for (const mission of current.missions) {
    const key = getMissionKey(mission, current.ecosystem);
    currentMap.set(key, mission);
  }

  const baselineMap = new Map<string, BaselineFile["missions"][0]>();
  for (const mission of baseline.missions) {
    const key = getMissionKey(mission, baseline.ecosystem);
    baselineMap.set(key, mission);
  }

  // Find added and unchanged missions
  for (const [key, currentMission] of currentMap) {
    if (baselineMap.has(key)) {
      unchanged.push(currentMission);
    } else {
      added.push(currentMission);
    }
  }

  // Find resolved missions (in baseline but not in current)
  for (const [key, baselineMission] of baselineMap) {
    if (!currentMap.has(key)) {
      // Convert baseline mission to AnalyzedMission for consistency
      resolved.push(baselineMission as unknown as AnalyzedMission);
    }
  }

  return { added, resolved, unchanged };
}

/**
 * Generates a human-readable diff summary for the console output.
 */
export function formatDiffSummary(diff: BaselineDiff): string {
  const lines: string[] = [];

  if (diff.added.length === 0 && diff.resolved.length === 0) {
    lines.push("No changes since baseline.");
    return lines.join("\n");
  }

  lines.push("## Diff vs Baseline");
  lines.push("");

  if (diff.added.length > 0) {
    lines.push(`### ➕ Added (${diff.added.length})`);
    lines.push("");
    for (const mission of diff.added) {
      const severity = mission.advisory.severity.toUpperCase();
      const score = mission.composite_score.toFixed(1);
      const osvShort =
        mission.advisory.osv_id.length > 8
          ? mission.advisory.osv_id.slice(0, 8)
          : mission.advisory.osv_id;
      lines.push(`- [${severity}] ${score} — ${mission.dependency.package_name} (${osvShort})`);
    }
    lines.push("");
  }

  if (diff.resolved.length > 0) {
    lines.push(`### ✅ Resolved (${diff.resolved.length})`);
    lines.push("");
    for (const mission of diff.resolved) {
      const severity = mission.advisory.severity.toUpperCase();
      const osvShort =
        mission.advisory.osv_id.length > 8
          ? mission.advisory.osv_id.slice(0, 8)
          : mission.advisory.osv_id;
      lines.push(`- [${severity}] ${mission.dependency.package_name} (${osvShort})`);
    }
    lines.push("");
  }

  if (diff.unchanged.length > 0) {
    lines.push(`### ➡️ Unchanged (${diff.unchanged.length})`);
    lines.push("");
  }

  return lines.join("\n");
}
