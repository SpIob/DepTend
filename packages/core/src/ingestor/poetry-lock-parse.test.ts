import { describe, it, expect } from "vitest";
import { parsePoetryLockContent } from "./poetry-lock-parse.js";

const SAMPLE_POETRY_LOCK = `
[[package]]
name = "requests"
version = "2.31.0"
description = "Python HTTP for Humans."
optional = false
python-versions = ">=3.7"
dependencies = [
  "certifi>=2017.4.17",
  "charset-normalizer<4,>=2",
  "idna<4,>=2.5",
  "urllib3<3,>=1.21.1",
]

[[package]]
name = "certifi"
version = "2023.7.22"
description = "Python package for providing Mozilla's CA Bundle."
optional = false
python-versions = ">=3.6"

[[package]]
name = "charset-normalizer"
version = "3.2.0"
description = "The Real First Universal Charset Detector."
optional = false
python-versions = ">=3.7"

[[package]]
name = "idna"
version = "3.4"
description = "Internationalized Domain Names in Applications (IDNA)."
optional = false
python-versions = ">=3.6"

[[package]]
name = "urllib3"
version = "2.0.4"
description = "HTTP library with thread-safe connection pooling, file post, and more."
optional = false
python-versions = ">=3.7"
`;

const POETRY_LOCK_WITH_OPTIONAL = `
[[package]]
name = "requests"
version = "2.31.0"
description = "Python HTTP for Humans."
optional = false
python-versions = ">=3.7"
dependencies = ["certifi>=2017.4.17"]

[[package]]
name = "pytest"
version = "7.4.0"
description = "pytest: simple powerful testing with Python"
optional = true
python-versions = ">=3.7"
dependencies = ["pluggy<2.0,>=1.0"]

[[package]]
name = "certifi"
version = "2023.7.22"
optional = false

[[package]]
name = "pluggy"
version = "1.3.0"
optional = false
`;

describe("parsePoetryLockContent", () => {
  it("parses a basic poetry.lock and extracts resolved versions", () => {
    const result = parsePoetryLockContent(SAMPLE_POETRY_LOCK);

    expect(result.format).toBe("poetry.lock");
    expect(result.resolvedVersions.get("requests")).toBe("2.31.0");
    expect(result.resolvedVersions.get("certifi")).toBe("2023.7.22");
    expect(result.resolvedVersions.get("charset-normalizer")).toBe("3.2.0");
    expect(result.resolvedVersions.get("idna")).toBe("3.4");
    expect(result.resolvedVersions.get("urllib3")).toBe("2.0.4");
  });

  it("identifies root packages (optional=false) vs transitive", () => {
    const result = parsePoetryLockContent(POETRY_LOCK_WITH_OPTIONAL);

    expect(result.resolvedVersions.get("requests")).toBe("2.31.0");
    expect(result.resolvedVersions.get("pytest")).toBe("7.4.0");
    expect(result.resolvedVersions.get("certifi")).toBe("2023.7.22");
    expect(result.resolvedVersions.get("pluggy")).toBe("1.3.0");

    // certifi and pluggy have optional=false, so they are root packages
    // only pytest has optional=true, so it's marked as transitive
    expect(result.transitivePackages.has("pytest")).toBe(true);
    expect(result.transitivePackages.has("certifi")).toBe(false);
    expect(result.transitivePackages.has("pluggy")).toBe(false);
    expect(result.transitivePackages.has("requests")).toBe(false);
  });

  it("returns empty result for invalid TOML", () => {
    const result = parsePoetryLockContent("not valid toml [[[");
    expect(result.resolvedVersions.size).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.format).toBe("poetry.lock");
  });

  it("handles missing [[package]] array", () => {
    const result = parsePoetryLockContent('[metadata]\ncontent_hash = "abc"');
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
    const result = parsePoetryLockContent(content);
    expect(result.resolvedVersions.get("valid")).toBe("1.0.0");
    expect(result.resolvedVersions.has("no-version")).toBe(false);
  });
});
