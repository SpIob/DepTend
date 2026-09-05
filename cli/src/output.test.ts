/**
 * writeOutput unit tests
 *
 * Pins the four branches that the live-network audit (2026-09-05) showed
 * the mocked suite missed (B1, B2, B6, B7, B8, B9, B10). Each test pins
 * one observable: the file contents, the stdout/stderr streams, the
 * written summary shape. Stubs process.stderr.isTTY to false to keep
 * output deterministic in CI (no ANSI escape codes leaking into stdout).
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeOutput } from "./output.js";
import type { AnalyzeResult, AnalyzedMission } from "./types.js";

const EMPTY_RESULT: AnalyzeResult = {
  generated_at: "2026-01-01T00:00:00.000Z",
  repo: {
    github_url: "https://github.com/owner/repo",
    owner: "owner",
    name: "repo",
    default_branch: "main",
    stars: 0,
    open_issues_count: 0,
  },
  dependencies_scanned: 0,
  ecosystem: "npm",
  lock_file_present: false,
  missions: [],
  warnings: [],
};

const sampleMission: AnalyzedMission = {
  title: "Update semver to fix a high vulnerability",
  description: "semver is vulnerable to ReDoS",
  action_hint: "Upgrade semver to 7.5.2 or later — low effort (minor version bump).",
  composite_score: 5.0,
  impact_score: 7.5,
  ecosystem_value_score: 1.28,
  effort_label: "low",
  confidence: "low",
  confidence_notes: [
    "The currently-installed version is estimated from this dependency's declared range rather than confirmed from a lock file (lock-file parsing is not implemented; ADR 0007 §3).",
  ],
  scoring_version: "1.1.0",
  scoring_inputs: {
    impact: {
      cvss_score: 7.5,
      severity: "high",
      is_transitive: false,
      dep_type: "production",
      days_since_advisory: 100,
      epss_score: null,
    },
    effort: {
      semver_bump: "minor",
      has_migration_guide: false,
      breaking_change_signals: [],
    },
    ecosystem_value: { repo_stars: 1, open_issues_count: 0, downstream_dependents: null },
  },
  dependency: {
    package_name: "semver",
    version_spec: "^7.8.5",
    dep_type: "production",
    latest_version: "7.8.5",
    is_deprecated: false,
  },
  advisory: {
    osv_id: "GHSA-c2qf-rxjj-qqgw",
    source: "ghsa",
    severity: "high",
    cvss_score: 7.5,
    fixed_version: "7.5.2",
    summary: "semver vulnerable to ReDoS",
    url: "https://github.com/advisories/GHSA-c2qf-rxjj-qqgw",
  },
};

const ONE_MISSION_RESULT: AnalyzeResult = {
  ...EMPTY_RESULT,
  dependencies_scanned: 1,
  ecosystem: "npm",
  lock_file_present: true,
  missions: [sampleMission],
};

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "deptend-output-"));
  // Force deterministic output: not a TTY → no ANSI codes, no NO_COLOR check.
  Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
  delete process.env.NO_COLOR;
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function printedOf(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
}

function parseFrom(payload: string): { missions: { advisory: { osv_id: string } }[] } {
  return JSON.parse(payload) as { missions: { advisory: { osv_id: string } }[] };
}

describe("writeOutput", () => {
  it("writes full JSON to file and prints a confirmation to stdout (outputPath !== null)", async () => {
    const outFile = join(workDir, "result.json");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await writeOutput(ONE_MISSION_RESULT, { outputPath: outFile, json: false });

    const written = await readFile(outFile, "utf-8");
    const parsed = parseFrom(written);
    expect(parsed.missions).toHaveLength(1);
    expect(parsed.missions[0]?.advisory.osv_id).toBe("GHSA-c2qf-rxjj-qqgw");
    // Confirmation message; non-zero mission count visible to the user.
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Wrote 1 mission(s)"));
  });

  it("prints full JSON to stdout when --json is set and no --output (I-14 branch 2)", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await writeOutput(ONE_MISSION_RESULT, { outputPath: null, json: true });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const payload = String(stdoutSpy.mock.calls[0]?.[0] ?? "");
    const parsed = parseFrom(payload);
    expect(parsed.missions).toHaveLength(1);
  });

  it("prints the 'No open vulnerability missions' summary when missions is empty", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await writeOutput(EMPTY_RESULT, { outputPath: null, json: false });

    const printed = printedOf(logSpy);
    expect(printed).toContain("owner/repo");
    expect(printed).toContain("0 npm dependencies scanned");
    expect(printed).toContain("No open vulnerability missions found.");
  });

  it("renders warnings at the bottom of the human summary (I-14 branch 4)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const resultWithWarnings: AnalyzeResult = {
      ...EMPTY_RESULT,
      warnings: ["Warning A", "Warning B"],
    };

    await writeOutput(resultWithWarnings, { outputPath: null, json: false });

    const printed = printedOf(logSpy);
    expect(printed).toContain("2 warning(s):");
    expect(printed).toContain("- Warning A");
    expect(printed).toContain("- Warning B");
  });

  it("does not claim a /10 scale (I-13)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await writeOutput(ONE_MISSION_RESULT, { outputPath: null, json: false });

    const printed = printedOf(logSpy);
    expect(printed).not.toContain("/10");
    // The score is still printed, just without the misleading scale suffix.
    expect(printed).toMatch(/5\.0/);
  });

  it("appends the short OSV prefix to disambiguate identical titles (I-5 / B8)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // Two missions with the same title, different OSV ids.
    const first: AnalyzedMission = {
      ...sampleMission,
      advisory: { ...sampleMission.advisory, osv_id: "GHSA-aaaa-bbbb-cccc" },
    };
    const second: AnalyzedMission = {
      ...sampleMission,
      advisory: { ...sampleMission.advisory, osv_id: "GHSA-dddd-eeee-ffff" },
    };
    const result: AnalyzeResult = { ...ONE_MISSION_RESULT, missions: [first, second] };

    await writeOutput(result, { outputPath: null, json: false });

    const printed = printedOf(logSpy);
    expect(printed).toContain("(GHSA-aaaa)");
    expect(printed).toContain("(GHSA-dddd)");
  });

  it("renders effort_label with a distinguishing prefix glyph (I-10 / B9)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const trivial: AnalyzedMission = { ...sampleMission, effort_label: "trivial" };
    const low: AnalyzedMission = { ...sampleMission, effort_label: "low" };
    const result: AnalyzeResult = { ...ONE_MISSION_RESULT, missions: [trivial, low] };

    await writeOutput(result, { outputPath: null, json: false });

    const printed = printedOf(logSpy);
    expect(printed).toMatch(/·\s+trivial/);
    expect(printed).toMatch(/\+\s+low/);
  });

  it("omits ANSI codes when stderr is not a TTY (I-9 / B7)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // stderr.isTTY is false from beforeEach — verify no escape codes leak.
    await writeOutput(ONE_MISSION_RESULT, { outputPath: null, json: false });

    const printed = printedOf(logSpy);
    expect(printed).not.toContain("\x1b[");
  });

  it("omits ANSI codes when NO_COLOR is set, even on a TTY (I-9)", async () => {
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    process.env.NO_COLOR = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await writeOutput(ONE_MISSION_RESULT, { outputPath: null, json: false });

    const printed = printedOf(logSpy);
    expect(printed).not.toContain("\x1b[");
  });
});
