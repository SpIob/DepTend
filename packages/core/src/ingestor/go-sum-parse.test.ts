import { describe, it, expect } from "vitest";
import { parseGoSumContent } from "./go-sum-parse.js";

const SAMPLE_GO_SUM = `github.com/gin-gonic/gin v1.9.1 h1:Xk7zDmzQQ1YHHaSYCix3O5M5+RPJ5q3G4V5Y5Y5Y5Y5=
github.com/gin-gonic/gin v1.9.1/go.mod h1:K4Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5=
github.com/go-playground/validator/v10 v10.14.0 h1:Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y=
github.com/go-playground/validator/v10 v10.14.0/go.mod h1:Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y=
github.com/json-iterator/go v1.1.12 h1:Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y=
github.com/json-iterator/go v1.1.12/go.mod h1:Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y=
github.com/modern-go/concurrent v0.0.0-20180306012644-bacd9c7ef1dd h1:Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y=
github.com/modern-go/concurrent v0.0.0-20180306012644-bacd9c7ef1dd/go.mod h1:Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y=
github.com/modern-go/reflect2 v1.0.2 h1:Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y=
github.com/modern-go/reflect2 v1.0.2/go.mod h1:Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y=
golang.org/x/sys v0.11.0 h1:Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y=
golang.org/x/sys v0.11.0/go.mod h1:Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y5Y=
`;

describe("parseGoSumContent", () => {
  it("parses a basic go.sum and extracts resolved versions", () => {
    const result = parseGoSumContent(SAMPLE_GO_SUM);

    expect(result.format).toBe("go.sum");
    expect(result.resolvedVersions.get("github.com/gin-gonic/gin")).toBe("v1.9.1");
    expect(result.resolvedVersions.get("github.com/go-playground/validator/v10")).toBe("v10.14.0");
    expect(result.resolvedVersions.get("github.com/json-iterator/go")).toBe("v1.1.12");
    expect(result.resolvedVersions.get("github.com/modern-go/concurrent")).toBe(
      "v0.0.0-20180306012644-bacd9c7ef1dd",
    );
    expect(result.resolvedVersions.get("github.com/modern-go/reflect2")).toBe("v1.0.2");
    expect(result.resolvedVersions.get("golang.org/x/sys")).toBe("v0.11.0");
  });

  it("handles duplicate entries for same module (keeps first)", () => {
    const content = `github.com/test/module v1.0.0 h1:abc
github.com/test/module v1.0.0/go.mod h1:def
github.com/test/module v2.0.0 h1:ghi
`;
    const result = parseGoSumContent(content);
    expect(result.resolvedVersions.get("github.com/test/module")).toBe("v1.0.0");
  });

  it("returns empty result for empty content", () => {
    const result = parseGoSumContent("");
    expect(result.resolvedVersions.size).toBe(0);
    expect(result.transitivePackages.size).toBe(0);
  });

  it("handles malformed lines gracefully", () => {
    const content = `github.com/valid/module v1.0.0 h1:abc
malformed line
github.com/another/module v2.0.0 h1:def
`;
    const result = parseGoSumContent(content);
    expect(result.resolvedVersions.get("github.com/valid/module")).toBe("v1.0.0");
    expect(result.resolvedVersions.get("github.com/another/module")).toBe("v2.0.0");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("skips comment lines", () => {
    const content = `# This is a comment
github.com/valid/module v1.0.0 h1:abc
# Another comment
github.com/another/module v2.0.0 h1:def
`;
    const result = parseGoSumContent(content);
    expect(result.resolvedVersions.get("github.com/valid/module")).toBe("v1.0.0");
    expect(result.resolvedVersions.get("github.com/another/module")).toBe("v2.0.0");
  });
});
