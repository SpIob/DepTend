import { describe, it, expect } from "vitest";
import { parsePdmLockContent } from "./pdm-lock-parse.js";

const SAMPLE_PDM_LOCK = `
[[package]]
name = "requests"
version = "2.31.0"
dependencies = { certifi = ">=2017.4.17", "charset-normalizer" = "<4,>=2", idna = "<4,>=2.5", urllib3 = "<3,>=1.21.1" }

[[package]]
name = "certifi"
version = "2023.7.22"
dependencies = {}

[[package]]
name = "charset-normalizer"
version = "3.2.0"
dependencies = {}

[[package]]
name = "idna"
version = "3.4"
dependencies = {}

[[package]]
name = "urllib3"
version = "2.0.4"
dependencies = {}
`;

const PDM_LOCK_WITH_DEV = `
[[package]]
name = "requests"
version = "2.31.0"
dependencies = { certifi = ">=2017.4.17" }

[[package]]
name = "pytest"
version = "7.4.0"
dependencies = { pluggy = "<2.0,>=1.0" }

[[package]]
name = "certifi"
version = "2023.7.22"
dependencies = {}

[[package]]
name = "pluggy"
version = "1.3.0"
dependencies = {}
`;

describe("parsePdmLockContent", () => {
  it("parses a basic pdm.lock and extracts resolved versions", () => {
    const result = parsePdmLockContent(SAMPLE_PDM_LOCK);

    expect(result.format).toBe("pdm.lock");
    expect(result.resolvedVersions.get("requests")).toBe("2.31.0");
    expect(result.resolvedVersions.get("certifi")).toBe("2023.7.22");
    expect(result.resolvedVersions.get("charset-normalizer")).toBe("3.2.0");
    expect(result.resolvedVersions.get("idna")).toBe("3.4");
    expect(result.resolvedVersions.get("urllib3")).toBe("2.0.4");
  });

  it("returns empty transitivePackages (detection requires manifest)", () => {
    const result = parsePdmLockContent(PDM_LOCK_WITH_DEV);

    expect(result.resolvedVersions.get("requests")).toBe("2.31.0");
    expect(result.resolvedVersions.get("pytest")).toBe("7.4.0");
    expect(result.resolvedVersions.get("certifi")).toBe("2023.7.22");
    expect(result.resolvedVersions.get("pluggy")).toBe("1.3.0");
    expect(result.transitivePackages.size).toBe(0);
  });

  it("returns empty result for invalid TOML", () => {
    const result = parsePdmLockContent("not valid toml [[[");
    expect(result.resolvedVersions.size).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.format).toBe("pdm.lock");
  });

  it("handles missing [[package]] array", () => {
    const result = parsePdmLockContent("[metadata]\nversion = 1");
    expect(result.resolvedVersions.size).toBe(0);
    expect(result.warnings.some((w) => w.includes("[[package]]"))).toBe(true);
  });

  it("handles packages with missing name or version", () => {
    const content = `
[[package]]
name = "valid"
version = "1.0.0"

[[package]]
version = "2.0.0"

[[package]]
name = "no-version"
`;
    const result = parsePdmLockContent(content);
    expect(result.resolvedVersions.get("valid")).toBe("1.0.0");
    expect(result.resolvedVersions.has("no-version")).toBe(false);
  });
});
