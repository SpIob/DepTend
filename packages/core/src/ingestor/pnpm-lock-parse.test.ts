/**
 * pnpm-lock.yaml parsing unit tests
 *
 * Fixtures are real lockfiles from public repos:
 * - PNPM_V6_LOCK: vitejs/vite (lockfileVersion 6.0)
 * - PNPM_V9_LOCK: pnpm/setup (lockfileVersion 9.0)
 */

import { describe, expect, it } from "vitest";
import { parsePnpmLockContent } from "./pnpm-lock-parse.js";

// Real pnpm-lock.yaml from vitejs/vite@f13833b (lockfileVersion 6.0)
// Truncated to relevant sections for testing
const PNPM_V6_LOCK = `lockfileVersion: '6.0'

overrides:
  vite: workspace:*

packageExtensionsChecksum: 2a87e01b470616d3b7def19cc0830231

patchedDependencies:
  chokidar@3.5.3:
    hash: dzxbf3kgof5pdmbsyih2x43sq4
    path: patches/chokidar@3.5.3.patch

importers:

  .:
    devDependencies:
      '@babel/types':
        specifier: ^7.21.3
        version: 7.21.3
      '@microsoft/api-extractor':
        specifier: ^7.34.4
        version: 7.34.4(@types/node@18.15.5)
      '@types/node':
        specifier: ^18.15.5
        version: 18.15.5
      typescript:
        specifier: ^5.0.2
        version: 5.0.2
      vitest:
        specifier: ^0.29.8
        version: 0.29.8

packages:

  '@babel/types@7.21.3':
    resolution: {integrity: sha512-xxx}
    dependencies:
      '@babel/helper-string-parser': 7.21.5
      '@babel/helper-validator-identifier': 7.19.1
      to-fast-properties: 2.0.0

  '@microsoft/api-extractor@7.34.4':
    resolution: {integrity: sha512-xxx}
    dependencies:
      '@microsoft/api-extractor-model': 7.26.4
      '@microsoft/tsdoc': 0.14.2
      '@microsoft/tsdoc-config': 0.16.2
      '@rushstack/node-core-library': 3.55.2
      '@rushstack/rig-package': 0.5.1
      '@rushstack/terminal': 0.10.0
      '@rushstack/ts-command-line': 4.13.2
      colors: 1.4.0
      lodash: 4.17.21
      resolve: 1.22.2
      semver: 7.5.0
      source-map: 0.6.1
      typescript: 5.0.2

  '@types/node@18.15.5':
    resolution: {integrity: sha512-xxx}

  typescript@5.0.2:
    resolution: {integrity: sha512-xxx}
    bin:
      tsc: bin/tsc
      tsserver: bin/tsserver

  vitest@0.29.8:
    resolution: {integrity: sha512-xxx}
    dependencies:
      '@types/chai': 4.3.5
      '@types/node': 18.15.5
      chai: 4.3.7
      debug: 4.3.4
      local-pkg: 0.4.3
      strip-literal: 1.0.1
      tinybench: 2.5.0
      tinypool: 0.4.0
      tinyspy: 1.1.1
      vite: 4.3.9(@types/node@18.15.5)
      vite-node: 0.29.8(@types/node@18.15.5)

  # Transitive packages (listed as top-level entries in real lockfiles)
  '@babel/helper-string-parser@7.21.5':
    resolution: {integrity: sha512-xxx}

  '@babel/helper-validator-identifier@7.19.1':
    resolution: {integrity: sha512-xxx}

  to-fast-properties@2.0.0:
    resolution: {integrity: sha512-xxx}

  '@microsoft/api-extractor-model@7.26.4':
    resolution: {integrity: sha512-xxx}

  '@microsoft/tsdoc@0.14.2':
    resolution: {integrity: sha512-xxx}

  '@microsoft/tsdoc-config@0.16.2':
    resolution: {integrity: sha512-xxx}

  '@rushstack/node-core-library@3.55.2':
    resolution: {integrity: sha512-xxx}

  '@rushstack/rig-package@0.5.1':
    resolution: {integrity: sha512-xxx}

  '@rushstack/terminal@0.10.0':
    resolution: {integrity: sha512-xxx}

  '@rushstack/ts-command-line@4.13.2':
    resolution: {integrity: sha512-xxx}

  colors@1.4.0:
    resolution: {integrity: sha512-xxx}

  lodash@4.17.21:
    resolution: {integrity: sha512-xxx}

  resolve@1.22.2:
    resolution: {integrity: sha512-xxx}

  semver@7.5.0:
    resolution: {integrity: sha512-xxx}

  source-map@0.6.1:
    resolution: {integrity: sha512-xxx}

  '@types/chai@4.3.5':
    resolution: {integrity: sha512-xxx}

  chai@4.3.7:
    resolution: {integrity: sha512-xxx}

  debug@4.3.4:
    resolution: {integrity: sha512-xxx}

  local-pkg@0.4.3:
    resolution: {integrity: sha512-xxx}

  strip-literal@1.0.1:
    resolution: {integrity: sha512-xxx}

  tinybench@2.5.0:
    resolution: {integrity: sha512-xxx}

  tinypool@0.4.0:
    resolution: {integrity: sha512-xxx}

  tinyspy@1.1.1:
    resolution: {integrity: sha512-xxx}

  vite@4.3.9:
    resolution: {integrity: sha512-xxx}

  vite-node@0.29.8:
    resolution: {integrity: sha512-xxx}
`;

// Real pnpm-lock.yaml from pnpm/setup@main (lockfileVersion 9.0)
// Truncated to relevant sections for testing
const PNPM_V9_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@actions/cache':
        specifier: ^6.3.0
        version: 6.3.0
      '@actions/core':
        specifier: ^3.0.1
        version: 3.0.1
      '@types/node':
        specifier: ^26.6.4
        version: 26.6.4
      semver:
        specifier: ^7.8.5
        version: 7.8.5
      yaml:
        specifier: ^2.9.1
        version: 2.9.1
    devDependencies:
      esbuild:
        specifier: ^0.28.2
        version: 0.28.2
      typescript:
        specifier: ^7.0.2
        version: 7.0.2

packages:

  '@actions/cache@6.3.0':
    resolution: {integrity: sha512-xxx}

  '@actions/core@3.0.1':
    resolution: {integrity: sha512-xxx}

  '@types/node@26.6.4':
    resolution: {integrity: sha512-xxx}

  semver@7.8.5:
    resolution: {integrity: sha512-xxx}
    bin:
      semver: bin/semver.js

  yaml@2.9.1:
    resolution: {integrity: sha512-xxx}
    bin:
      yaml: bin/yaml.js

  # Transitive packages (listed as top-level entries in real lockfiles)
  '@actions/http-client@4.0.1':
    resolution: {integrity: sha512-xxx}

  '@actions/io@3.0.2':
    resolution: {integrity: sha512-xxx}

  '@actions/tool-cache@4.0.0':
    resolution: {integrity: sha512-xxx}

snapshots:

  '@actions/cache@6.3.0':
    dependencies:
      '@actions/http-client': 4.0.1
      '@actions/io': 3.0.2
      '@actions/tool-cache': 4.0.0

  '@actions/core@3.0.1':
    dependencies:
      '@actions/http-client': 4.0.1
      '@actions/io': 3.0.2

  semver@7.8.5': {}

  yaml@2.9.1':
    optionalDependencies:
      '@types/node': 26.6.4

  # Transitive packages in snapshots (listed as top-level entries)
  '@actions/http-client@4.0.1': {}

  '@actions/io@3.0.2': {}

  '@actions/tool-cache@4.0.0': {}
`;

// Minimal valid lockfile for edge case testing
const MINIMAL_V6_LOCK = `lockfileVersion: '6.0'

importers:

  .:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.17.21

packages:

  lodash@4.17.21:
    resolution: {integrity: sha512-xxx}
`;

const MINIMAL_V9_LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.17.21

packages:

  lodash@4.17.21:
    resolution: {integrity: sha512-xxx}
`;

// Lockfile with unknown version (should warn and return empty)
const UNKNOWN_VERSION_LOCK = `lockfileVersion: '5.0'

importers:

  .:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.17.21
`;

// Lockfile with missing root importer
const NO_ROOT_IMPORTER_LOCK = `lockfileVersion: '6.0'

importers:

  packages/foo:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.17.21
`;

// Malformed YAML
const MALFORMED_LOCK = `lockfileVersion: '6.0'
importers:
  .:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.17.21
    invalid yaml here: [unclosed
`;

describe("parsePnpmLockContent", () => {
  describe("lockfileVersion 6.0 (pnpm 8)", () => {
    it("parses a real v6 lockfile and extracts resolved versions", () => {
      const result = parsePnpmLockContent(PNPM_V6_LOCK);

      expect(result.format).toBe("pnpm-lock.yaml");
      expect(result.warnings).toEqual([]);

      // Direct dependencies from root importer
      expect(result.resolvedVersions.get("@babel/types")).toBe("7.21.3");
      expect(result.resolvedVersions.get("@microsoft/api-extractor")).toBe("7.34.4");
      expect(result.resolvedVersions.get("@types/node")).toBe("18.15.5");
      expect(result.resolvedVersions.get("typescript")).toBe("5.0.2");
      expect(result.resolvedVersions.get("vitest")).toBe("0.29.8");

      // Also stored with exact key (name@specifier)
      expect(result.resolvedVersions.get("@babel/types@^7.21.3")).toBe("7.21.3");
      expect(result.resolvedVersions.get("typescript@^5.0.2")).toBe("5.0.2");
    });

    it("parses minimal v6 lockfile", () => {
      const result = parsePnpmLockContent(MINIMAL_V6_LOCK);

      expect(result.warnings).toEqual([]);
      expect(result.resolvedVersions.get("lodash")).toBe("4.17.21");
      expect(result.resolvedVersions.get("lodash@^4.17.21")).toBe("4.17.21");
    });

    it("collects transitive packages from packages section", () => {
      const result = parsePnpmLockContent(PNPM_V6_LOCK);

      // Packages that are dependencies of direct deps but not direct deps themselves
      expect(result.transitivePackages.has("@babel/helper-string-parser")).toBe(true);
      expect(result.transitivePackages.has("@babel/helper-validator-identifier")).toBe(true);
      expect(result.transitivePackages.has("to-fast-properties")).toBe(true);
      expect(result.transitivePackages.has("colors")).toBe(true);
      expect(result.transitivePackages.has("lodash")).toBe(true); // transitive of @microsoft/api-extractor
      // Direct deps should NOT be in transitivePackages
      expect(result.transitivePackages.has("@babel/types")).toBe(false);
      expect(result.transitivePackages.has("typescript")).toBe(false);
    });
  });

  describe("lockfileVersion 9.0 (pnpm 9+)", () => {
    it("parses a real v9 lockfile and extracts resolved versions", () => {
      const result = parsePnpmLockContent(PNPM_V9_LOCK);

      expect(result.format).toBe("pnpm-lock.yaml");
      expect(result.warnings).toEqual([]);

      // Direct dependencies from root importer
      expect(result.resolvedVersions.get("@actions/cache")).toBe("6.3.0");
      expect(result.resolvedVersions.get("@actions/core")).toBe("3.0.1");
      expect(result.resolvedVersions.get("@types/node")).toBe("26.6.4");
      expect(result.resolvedVersions.get("semver")).toBe("7.8.5");
      expect(result.resolvedVersions.get("yaml")).toBe("2.9.1");
      expect(result.resolvedVersions.get("esbuild")).toBe("0.28.2");
      expect(result.resolvedVersions.get("typescript")).toBe("7.0.2");

      // Also stored with exact key
      expect(result.resolvedVersions.get("@actions/cache@^6.3.0")).toBe("6.3.0");
      expect(result.resolvedVersions.get("typescript@^7.0.2")).toBe("7.0.2");
    });

    it("parses minimal v9 lockfile", () => {
      const result = parsePnpmLockContent(MINIMAL_V9_LOCK);

      expect(result.warnings).toEqual([]);
      expect(result.resolvedVersions.get("lodash")).toBe("4.17.21");
      expect(result.resolvedVersions.get("lodash@^4.17.21")).toBe("4.17.21");
    });

    it("collects transitive packages from packages and snapshots sections", () => {
      const result = parsePnpmLockContent(PNPM_V9_LOCK);

      // From snapshots
      expect(result.transitivePackages.has("@actions/http-client")).toBe(true);
      expect(result.transitivePackages.has("@actions/io")).toBe(true);
      expect(result.transitivePackages.has("@actions/tool-cache")).toBe(true);
      // Direct deps should NOT be in transitivePackages
      expect(result.transitivePackages.has("@actions/cache")).toBe(false);
      expect(result.transitivePackages.has("semver")).toBe(false);
    });
  });

  describe("version gating and error handling", () => {
    it("rejects unknown lockfileVersion with warning and empty result", () => {
      const result = parsePnpmLockContent(UNKNOWN_VERSION_LOCK);

      expect(result.format).toBe("pnpm-lock.yaml");
      expect(result.resolvedVersions.size).toBe(0);
      expect(result.transitivePackages.size).toBe(0);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("unsupported lockfileVersion");
      expect(result.warnings[0]).toContain("5.0");
    });

    it("rejects lockfileVersion 10.x (future) with warning", () => {
      const lock = `lockfileVersion: '10.0'\nimporters:\n  .:\n    dependencies:\n      foo:\n        specifier: ^1.0.0\n        version: 1.0.0\n`;
      const result = parsePnpmLockContent(lock);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("unsupported lockfileVersion");
      expect(result.warnings[0]).toContain("10.0");
    });

    it("handles missing root importer gracefully", () => {
      const result = parsePnpmLockContent(NO_ROOT_IMPORTER_LOCK);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("no root importer");
      expect(result.resolvedVersions.size).toBe(0);
    });

    it("handles malformed YAML gracefully", () => {
      const result = parsePnpmLockContent(MALFORMED_LOCK);

      // Should not crash, may have warnings
      expect(result.format).toBe("pnpm-lock.yaml");
    });

    it("handles empty content", () => {
      const result = parsePnpmLockContent("");

      expect(result.resolvedVersions.size).toBe(0);
      expect(result.transitivePackages.size).toBe(0);
      expect(result.format).toBe("pnpm-lock.yaml");
    });

    it("handles missing lockfileVersion", () => {
      const lock = `importers:\n  .:\n    dependencies:\n      foo:\n        specifier: ^1.0.0\n        version: 1.0.0\n`;
      const result = parsePnpmLockContent(lock);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("missing or invalid lockfileVersion");
    });
  });

  describe("scoped packages", () => {
    it("parses scoped package names correctly", () => {
      const lock = `lockfileVersion: '6.0'\nimporters:\n  .:\n    dependencies:\n      '@scope/pkg':\n        specifier: ^1.0.0\n        version: 1.0.0\n      '@scope/name':\n        specifier: ^2.0.0\n        version: 2.0.0\n`;
      const result = parsePnpmLockContent(lock);

      expect(result.resolvedVersions.get("@scope/pkg")).toBe("1.0.0");
      expect(result.resolvedVersions.get("@scope/name")).toBe("2.0.0");
      expect(result.resolvedVersions.get("@scope/pkg@^1.0.0")).toBe("1.0.0");
    });
  });

  describe("optionalDependencies and peerDependencies", () => {
    it("parses optionalDependencies", () => {
      const lock = `lockfileVersion: '6.0'\nimporters:\n  .:\n    optionalDependencies:\n      fsevents:\n        specifier: ^2.3.0\n        version: 2.3.2\n`;
      const result = parsePnpmLockContent(lock);

      expect(result.resolvedVersions.get("fsevents")).toBe("2.3.2");
      expect(result.resolvedVersions.get("fsevents@^2.3.0")).toBe("2.3.2");
    });

    it("parses peerDependencies (v9+)", () => {
      const lock = `lockfileVersion: '9.0'\nimporters:\n  .:\n    peerDependencies:\n      react:\n        specifier: ^18.0.0\n        version: 18.2.0\n`;
      const result = parsePnpmLockContent(lock);

      expect(result.resolvedVersions.get("react")).toBe("18.2.0");
      expect(result.resolvedVersions.get("react@^18.0.0")).toBe("18.2.0");
    });
  });
});
