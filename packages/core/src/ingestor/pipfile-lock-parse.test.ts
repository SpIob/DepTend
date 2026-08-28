import { describe, it, expect } from "vitest";
import { parsePipfileLockContent } from "./pipfile-lock-parse.js";

const SAMPLE_PIPFILE_LOCK = `{
    "default": {
        "requests": {
            "hashes": [
                "sha256:1234567890abcdef",
                "sha256:fedcba0987654321"
            ],
            "version": "==2.31.0"
        },
        "certifi": {
            "hashes": [
                "sha256:abcdef1234567890"
            ],
            "version": "==2023.7.22"
        },
        "urllib3": {
            "hashes": [
                "sha256:1111111111111111"
            ],
            "version": "==2.0.4"
        }
    },
    "develop": {
        "pytest": {
            "hashes": [
                "sha256:2222222222222222"
            ],
            "version": "==7.4.0"
        }
    }
}`;

describe("parsePipfileLockContent", () => {
  it("parses a basic Pipfile.lock and extracts resolved versions from default and develop", () => {
    const result = parsePipfileLockContent(SAMPLE_PIPFILE_LOCK);

    expect(result.format).toBe("Pipfile.lock");
    expect(result.resolvedVersions.get("requests")).toBe("==2.31.0");
    expect(result.resolvedVersions.get("certifi")).toBe("==2023.7.22");
    expect(result.resolvedVersions.get("urllib3")).toBe("==2.0.4");
    expect(result.resolvedVersions.get("pytest")).toBe("==7.4.0");
  });

  it("returns empty result for invalid JSON", () => {
    const result = parsePipfileLockContent("not valid json {{{");
    expect(result.resolvedVersions.size).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.format).toBe("Pipfile.lock");
  });

  it("handles missing default and develop sections", () => {
    const result = parsePipfileLockContent("{}");
    expect(result.resolvedVersions.size).toBe(0);
    expect(result.transitivePackages.size).toBe(0);
  });

  it("handles packages with missing version", () => {
    const content = `{
        "default": {
            "valid": { "version": "==1.0.0" },
            "invalid": { "hashes": ["sha256:abc"] }
        }
    }`;
    const result = parsePipfileLockContent(content);
    expect(result.resolvedVersions.get("valid")).toBe("==1.0.0");
    expect(result.resolvedVersions.has("invalid")).toBe(false);
  });

  it("handles non-object root", () => {
    const result = parsePipfileLockContent("[]");
    expect(result.resolvedVersions.size).toBe(0);
    expect(result.warnings.some((w) => w.includes("Pipfile.lock root is not an object"))).toBe(
      true,
    );
  });
});
