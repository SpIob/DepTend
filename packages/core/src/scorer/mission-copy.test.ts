/**
 * generateMissionCopy unit tests
 */

import { describe, expect, it } from "vitest";
import { generateMissionCopy } from "./mission-copy.js";
import { computeMissionScore, type MissionScoringContext } from "./mission-scorer.js";
import type { Advisory, Dependency, Repo } from "../db/types.js";

function makeDependency(overrides: Partial<Dependency> = {}): Dependency {
  return {
    id: "dep-1",
    repo_id: "repo-1",
    ecosystem: "npm",
    package_name: "left-pad",
    version_spec: "^1.2.3",
    resolved_version: null,
    dep_type: "production",
    latest_version: "1.4.0",
    is_deprecated: false,
    deprecation_note: null,
    created_at: new Date("2026-06-01"),
    updated_at: new Date("2026-06-01"),
    ...overrides,
  };
}

function makeAdvisory(overrides: Partial<Advisory> = {}): Advisory {
  return {
    id: "adv-1",
    osv_id: "GHSA-xxxx-xxxx-xxxx",
    source: "osv",
    ecosystem: "npm",
    package_name: "left-pad",
    severity: "high",
    cvss_score: 7.5,
    summary: "A padding function allows prototype pollution.",
    details: null,
    affected_versions: [],
    fixed_version: "1.2.4",
    published_at: new Date("2026-06-01"),
    modified_at: null,
    raw_data: {},
    created_at: new Date("2026-06-01"),
    updated_at: new Date("2026-06-01"),
    ...overrides,
  };
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo-1",
    github_url: "https://github.com/example/example",
    owner: "example",
    name: "example",
    default_branch: "main",
    description: null,
    stars: 1000,
    open_issues_count: 100,
    topics: [],
    homepage_url: null,
    ingestion_status: "complete",
    last_ingested_at: new Date("2026-07-01"),
    ingestion_error: null,
    submitted_by: null,
    created_at: new Date("2026-06-01"),
    updated_at: new Date("2026-07-01"),
    ...overrides,
  };
}

function makeContext(overrides: Partial<MissionScoringContext> = {}): MissionScoringContext {
  return { dependency: makeDependency(), advisory: makeAdvisory(), repo: makeRepo(), ...overrides };
}

describe("generateMissionCopy", () => {
  it("includes the package name and severity in the title when a fix exists", () => {
    const ctx = makeContext();
    const copy = generateMissionCopy(ctx, computeMissionScore(ctx));
    expect(copy.title).toContain("left-pad");
    expect(copy.title).toContain("high");
  });

  it("uses a no-fix-yet title when fixed_version is null", () => {
    const ctx = makeContext({ advisory: makeAdvisory({ fixed_version: null }) });
    const copy = generateMissionCopy(ctx, computeMissionScore(ctx));
    expect(copy.title).toMatch(/no fix yet/i);
    // capitalized severity at the start of the sentence
    expect(copy.title.startsWith("High")).toBe(true);
  });

  it("includes the advisory summary, dep_type, severity, CVSS, and source in the description", () => {
    const ctx = makeContext();
    const copy = generateMissionCopy(ctx, computeMissionScore(ctx));
    expect(copy.description).toContain("A padding function allows prototype pollution.");
    expect(copy.description).toContain("production");
    expect(copy.description).toContain("high");
    expect(copy.description).toContain("7.5");
    expect(copy.description).toContain("GHSA-xxxx-xxxx-xxxx");
    expect(copy.description).toContain("OSV");
  });

  it("omits the CVSS parenthetical when cvss_score is null", () => {
    const ctx = makeContext({ advisory: makeAdvisory({ cvss_score: null }) });
    const copy = generateMissionCopy(ctx, computeMissionScore(ctx));
    expect(copy.description).not.toContain("CVSS");
  });

  it("gives an upgrade action_hint including the fixed version when available", () => {
    const ctx = makeContext({ advisory: makeAdvisory({ fixed_version: "1.2.4" }) });
    const copy = generateMissionCopy(ctx, computeMissionScore(ctx));
    expect(copy.action_hint).toContain("1.2.4");
    expect(copy.action_hint).toMatch(/upgrade/i);
  });

  it("gives a tracking action_hint when no fix is available yet", () => {
    const ctx = makeContext({ advisory: makeAdvisory({ fixed_version: null }) });
    const copy = generateMissionCopy(ctx, computeMissionScore(ctx));
    expect(copy.action_hint).toMatch(/no fixed version/i);
    expect(copy.action_hint).toContain("GHSA-xxxx-xxxx-xxxx");
  });

  it("action_hint is never null (there is always something to say)", () => {
    const withFix = generateMissionCopy(makeContext(), computeMissionScore(makeContext()));
    const withoutFix = generateMissionCopy(
      makeContext({ advisory: makeAdvisory({ fixed_version: null }) }),
      computeMissionScore(makeContext({ advisory: makeAdvisory({ fixed_version: null }) })),
    );
    expect(withFix.action_hint).not.toBeNull();
    expect(withoutFix.action_hint).not.toBeNull();
  });
});
