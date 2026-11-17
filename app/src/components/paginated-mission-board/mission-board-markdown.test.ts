import { describe, expect, it, vi } from "vitest";
import {
  missionsToMarkdown,
  missionsToMarkdownRows,
  copyToClipboard,
  type MissionMarkdownRow,
} from "./mission-board-markdown";
import type { MissionWithScore } from "@deptend/core";
import type { Severity, Ecosystem, EffortLabel, MissionType } from "@deptend/core/db/schema.js";

// Use jsdom for clipboard tests that need document
const isJsdom = typeof window !== "undefined";

function makeMission(
  overrides: {
    severity?: Severity;
    ecosystem?: Ecosystem;
    effortLabel?: EffortLabel;
    missionType?: MissionType;
    packageName?: string;
    repoOwner?: string;
    repoName?: string;
    advisoryId?: string;
    title?: string;
    compositeScore?: number;
    actionHint?: string | null;
  } = {},
): MissionWithScore {
  const baseMission: MissionWithScore = {
    id: crypto.randomUUID(),
    repoId: crypto.randomUUID(),
    title: overrides.title ?? "Test vulnerability",
    description: "Test description",
    actionHint: overrides.actionHint ?? "Upgrade to 1.1.0",
    missionType: overrides.missionType ?? "vulnerability_fix",
    status: "open",
    advisoryId: crypto.randomUUID(),
    dependencyId: crypto.randomUUID(),
    claimedBy: null,
    claimedAt: null,
    resolvedAt: null,
    dismissedAt: null,
    dismissReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    score: {
      id: crypto.randomUUID(),
      missionId: crypto.randomUUID(),
      impactScore: 5.0,
      ecosystemValueScore: 5.0,
      compositeScore: overrides.compositeScore ?? 5.0,
      effortLabel: overrides.effortLabel ?? "low",
      impactInputs: {
        cvss_score: 7.5,
        severity: overrides.severity ?? "high",
        is_transitive: false,
        dep_type: "production",
        days_since_advisory: 30,
        epss_score: 0.1,
      },
      ecosystemValueInputs: {
        repo_stars: 100,
        open_issues_count: 10,
        downstream_dependents: null,
      },
      effortInputs: {
        semver_bump: "minor",
        has_migration_guide: false,
        breaking_change_signals: [],
      },
      confidence: "medium",
      confidenceNotes: [],
      confidenceFlags: {},
      scoringVersion: "0.1.0",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    advisory: {
      id: crypto.randomUUID(),
      osvId: overrides.advisoryId ?? "GHSA-test123",
      source: "osv",
      ecosystem: overrides.ecosystem ?? "npm",
      severity: overrides.severity ?? "high",
      cvssScore: 7.5,
      epssScore: 0.1,
      fixedVersion: "1.1.0",
      publishedAt: new Date("2024-01-01"),
    },
    dependency: {
      id: crypto.randomUUID(),
      repoId: crypto.randomUUID(),
      ecosystem: overrides.ecosystem ?? "npm",
      packageName: overrides.packageName ?? "test-package",
      versionSpec: "^1.0.0",
      resolvedVersion: "1.0.0",
      depType: "production",
      latestVersion: "1.1.0",
      isDeprecated: false,
      deprecationNote: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    repo: {
      id: crypto.randomUUID(),
      githubUrl: "https://github.com/test-owner/test-repo",
      owner: overrides.repoOwner ?? "test-owner",
      name: overrides.repoName ?? "test-repo",
      defaultBranch: "main",
      description: "Test repo",
      stars: 100,
      openIssuesCount: 10,
      topics: [],
      homepageUrl: null,
      ingestionStatus: "complete",
      lastIngestedAt: new Date(),
      ingestionError: null,
      submittedBy: "test-user",
      orgId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };

  // Apply advisory overrides if provided
  if (
    overrides.advisoryId !== undefined ||
    overrides.severity !== undefined ||
    overrides.ecosystem !== undefined
  ) {
    baseMission.advisory = {
      id: baseMission.advisory?.id ?? crypto.randomUUID(),
      osvId: overrides.advisoryId ?? baseMission.advisory?.osvId ?? "GHSA-test123",
      source: baseMission.advisory?.source ?? "osv",
      ecosystem: overrides.ecosystem ?? baseMission.advisory?.ecosystem ?? "npm",
      severity: overrides.severity ?? baseMission.advisory?.severity ?? "high",
      cvssScore: baseMission.advisory?.cvssScore ?? 7.5,
      epssScore: baseMission.advisory?.epssScore ?? 0.1,
      fixedVersion: baseMission.advisory?.fixedVersion ?? "1.1.0",
      publishedAt: baseMission.advisory?.publishedAt ?? new Date("2024-01-01"),
    };
  }

  // Apply dependency overrides if provided
  if (overrides.packageName !== undefined || overrides.ecosystem !== undefined) {
    baseMission.dependency = {
      id: baseMission.dependency?.id ?? crypto.randomUUID(),
      repoId: baseMission.dependency?.repoId ?? crypto.randomUUID(),
      ecosystem: overrides.ecosystem ?? baseMission.dependency?.ecosystem ?? "npm",
      packageName: overrides.packageName ?? baseMission.dependency?.packageName ?? "test-package",
      versionSpec: baseMission.dependency?.versionSpec ?? "^1.0.0",
      resolvedVersion: baseMission.dependency?.resolvedVersion ?? "1.0.0",
      depType: baseMission.dependency?.depType ?? "production",
      latestVersion: baseMission.dependency?.latestVersion ?? "1.1.0",
      isDeprecated: baseMission.dependency?.isDeprecated ?? false,
      deprecationNote: baseMission.dependency?.deprecationNote ?? null,
      createdAt: baseMission.dependency?.createdAt ?? new Date(),
      updatedAt: baseMission.dependency?.updatedAt ?? new Date(),
    };
  }

  // Apply repo overrides if provided
  if (overrides.repoOwner !== undefined || overrides.repoName !== undefined) {
    baseMission.repo = {
      ...baseMission.repo,
      owner: overrides.repoOwner ?? baseMission.repo.owner,
      name: overrides.repoName ?? baseMission.repo.name,
    };
  }

  // Apply score overrides if provided
  if (overrides.compositeScore !== undefined || overrides.effortLabel !== undefined) {
    baseMission.score = {
      ...baseMission.score,
      compositeScore: overrides.compositeScore ?? baseMission.score.compositeScore,
      effortLabel: overrides.effortLabel ?? baseMission.score.effortLabel,
      impactInputs: {
        ...baseMission.score.impactInputs,
        severity: overrides.severity ?? baseMission.score.impactInputs.severity,
      },
    };
  }

  // Apply actionHint override if provided
  if (overrides.actionHint !== undefined) {
    baseMission.actionHint = overrides.actionHint;
  }

  return baseMission;
}

describe("mission-board-markdown", () => {
  describe("missionsToMarkdownRows", () => {
    it("returns empty array for empty missions", () => {
      const rows = missionsToMarkdownRows([], true);
      expect(rows).toHaveLength(0);
    });

    it("formats a single mission with repo column", () => {
      const missions = [
        makeMission({
          severity: "critical",
          packageName: "urllib3",
          repoOwner: "psf",
          repoName: "requests",
          advisoryId: "GHSA-abc123",
          compositeScore: 9.5,
          effortLabel: "trivial",
          actionHint: "Upgrade to 2.0.0",
        }),
      ];

      const rows = missionsToMarkdownRows(missions, true);
      expect(rows.length).toBe(1);
      const row = rows[0] as MissionMarkdownRow;
      expect(row.severity).toBe("critical");
      expect(row.score).toBe("9.5");
      expect(row.effort).toBe("trivial");
      expect(row.packageName).toBe("urllib3");
      expect(row.advisoryLink).toBe("[GHSA-abc123](https://osv.dev/vulnerability/GHSA-abc123)");
      expect(row.actionHint).toBe("Upgrade to 2.0.0");
      expect(row.repo).toBe("psf/requests");
    });

    it("formats a single mission without repo column", () => {
      const missions = [makeMission({ severity: "high", packageName: "crypto" })];

      const rows = missionsToMarkdownRows(missions, false);
      expect(rows.length).toBe(1);
      const row = rows[0] as MissionMarkdownRow;
      expect(row.severity).toBe("high");
      expect(row.repo).toBe("—");
    });

    it("handles missing advisory ID gracefully", () => {
      const missions = [makeMission({ advisoryId: "" })];

      const rows = missionsToMarkdownRows(missions, false);
      expect(rows.length).toBe(1);
      const row = rows[0] as MissionMarkdownRow;
      expect(row.advisoryLink).toBe("");
      expect(row.severity).toBe("high"); // Uses fallback from impactInputs
    });

    it("handles missing actionHint", () => {
      const missions = [makeMission({ actionHint: null })];
      const rows = missionsToMarkdownRows(missions, false);
      expect(rows.length).toBe(1);
      const row = rows[0] as MissionMarkdownRow;
      expect(row.actionHint).toBe("—");
    });

    it("escapes pipe characters in text", () => {
      const missions = [makeMission({ actionHint: "Run | command" })];
      const rows = missionsToMarkdownRows(missions, false);
      expect(rows.length).toBe(1);
      const row = rows[0] as MissionMarkdownRow;
      expect(row.actionHint).toBe("Run \\| command");
    });

    it("handles multiple missions", () => {
      const missions = [
        makeMission({ severity: "critical", packageName: "pkg1" }),
        makeMission({ severity: "high", packageName: "pkg2" }),
      ];

      const rows = missionsToMarkdownRows(missions, false);
      expect(rows.length).toBe(2);
      const row0 = rows[0] as MissionMarkdownRow;
      const row1 = rows[1] as MissionMarkdownRow;
      expect(row0.packageName).toBe("pkg1");
      expect(row1.packageName).toBe("pkg2");
    });
  });

  describe("missionsToMarkdown", () => {
    it("returns empty string for empty missions", () => {
      const markdown = missionsToMarkdown([], true);
      expect(markdown).toBe("");
    });

    it("generates markdown table with repo column", () => {
      const missions = [
        makeMission({
          severity: "critical",
          packageName: "urllib3",
          repoOwner: "psf",
          repoName: "requests",
          advisoryId: "GHSA-abc123",
          compositeScore: 9.5,
          effortLabel: "trivial",
        }),
      ];

      const markdown = missionsToMarkdown(missions, true);
      const lines = markdown.split("\n");

      expect(lines[0]).toBe("| Severity | Score | Effort | Package | Advisory | Action | Repo |");
      expect(lines[1]).toBe("|---|---|---|---|---|---|---|");
      expect(lines[2]).toContain("critical");
      expect(lines[2]).toContain("9.5");
      expect(lines[2]).toContain("trivial");
      expect(lines[2]).toContain("urllib3");
      expect(lines[2]).toContain("[GHSA-abc123](https://osv.dev/vulnerability/GHSA-abc123)");
      expect(lines[2]).toContain("psf/requests");
    });

    it("generates markdown table without repo column", () => {
      const missions = [makeMission({ severity: "high", packageName: "crypto" })];

      const markdown = missionsToMarkdown(missions, false);
      const lines = markdown.split("\n");

      expect(lines[0]).toBe("| Severity | Score | Effort | Package | Advisory | Action |");
      expect(lines[1]).toBe("|---|---|---|---|---|---|");
      expect(lines[2]).not.toContain("Repo");
    });

    it("includes advisory link with osv.dev URL", () => {
      const missions = [makeMission({ advisoryId: "GHSA-xyz789" })];
      const markdown = missionsToMarkdown(missions, false);
      expect(markdown).toContain("[GHSA-xyz789](https://osv.dev/vulnerability/GHSA-xyz789)");
    });

    it("escapes pipe characters in table cells", () => {
      const missions = [makeMission({ actionHint: "A | B" })];
      const markdown = missionsToMarkdown(missions, false);
      // The pipe in the cell should be escaped
      expect(markdown).toContain("A \\| B");
    });
  });

  describe("copyToClipboard", () => {
    if (!isJsdom) {
      it.skip("requires jsdom environment", () => {
        // skip
      });
      return;
    }

    it("resolves when navigator.clipboard.writeText succeeds", async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      const originalClipboard = navigator.clipboard;
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: writeTextMock },
        configurable: true,
      });

      await expect(copyToClipboard("test")).resolves.toBeUndefined();
      expect(writeTextMock).toHaveBeenCalledWith("test");

      Object.defineProperty(navigator, "clipboard", {
        value: originalClipboard,
        configurable: true,
      });
    });

    it("falls back to execCommand when clipboard API unavailable", async () => {
      const execCommandMock = vi.fn().mockReturnValue(true);
      const originalExecCommand = document.execCommand;
      const originalClipboard = navigator.clipboard;

      Object.defineProperty(navigator, "clipboard", {
        value: undefined,
        configurable: true,
      });
      document.execCommand = execCommandMock;

      await expect(copyToClipboard("fallback test")).resolves.toBeUndefined();
      expect(execCommandMock).toHaveBeenCalledWith("copy");

      document.execCommand = originalExecCommand;
      Object.defineProperty(navigator, "clipboard", {
        value: originalClipboard,
        configurable: true,
      });
    });

    it("rejects when execCommand fails", async () => {
      const execCommandMock = vi.fn().mockReturnValue(false);
      const originalExecCommand = document.execCommand;
      const originalClipboard = navigator.clipboard;

      Object.defineProperty(navigator, "clipboard", {
        value: undefined,
        configurable: true,
      });
      document.execCommand = execCommandMock;

      await expect(copyToClipboard("fail")).rejects.toThrow("execCommand('copy') failed");

      document.execCommand = originalExecCommand;
      Object.defineProperty(navigator, "clipboard", {
        value: originalClipboard,
        configurable: true,
      });
    });
  });
});
