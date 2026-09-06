/**
 * Ingestor factories — shared implementation for HTTP and filesystem-based ingestors.
 *
 * Eliminates near-identical duplication across npm.ts/pypi.ts/go.ts and
 * local-npm.ts/local-pypi.ts/local-go.ts. Each ecosystem provides a config
 * object; the factory returns a class implementing EcosystemIngestor.
 */

import type { EcosystemIngestor, IngestorResult } from "./interface.js";
import { fetchWithRetry, type FetchRetryOptions } from "./fetch-retry.js";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isNodeErrnoException } from "./parse-guards.js";

export interface ManifestResult {
  raw: string | null;
  source: string;
}

export interface HttpIngestorConfig {
  ecosystem: "npm" | "pypi" | "go";
  manifestFiles: string[];
  lockFileNames: readonly string[];
  /** Receives all manifest results (in manifestFiles order) + lock file info */
  parseManifest: (
    manifests: ManifestResult[],
    lockFilePresent: boolean,
    lockFileContent: string | null,
    lockFileName: string | null,
  ) => Promise<IngestorResult>;
  unsupportedLockFiles?: readonly string[];
}

export interface LocalIngestorConfig {
  ecosystem: "npm" | "pypi" | "go";
  manifestFiles: string[];
  lockFileNames: readonly string[];
  /** Receives all manifest results (in manifestFiles order) + lock file info */
  parseManifest: (
    manifests: ManifestResult[],
    lockFilePresent: boolean,
    lockFileContent: string | null,
    lockFileName: string | null,
  ) => Promise<IngestorResult>;
  unsupportedLockFiles?: readonly string[];
}

/** Shared lock-file fetch/read logic used by both HTTP and local factories. */
async function fetchLockFiles(
  base: string,
  lockFileNames: readonly string[],
  unsupportedLockFiles: readonly string[] | undefined,
  fetcher: (url: string) => Promise<Response | null | string>,
  checker: (path: string) => Promise<void>,
): Promise<{
  lockFileContent: string | null;
  lockFileName: string | null;
  lockFilePresent: boolean;
}> {
  // 1. Try parsable lock files first (in order, skipping unsupported)
  for (const name of lockFileNames) {
    if (unsupportedLockFiles?.includes(name)) continue;
    try {
      const result = await fetcher(`${base}/${name}`);
      // Handle both Response (HTTP) and string (local) return types
      if (result !== null && typeof result === "object" && "ok" in result) {
        // Response object — check ok (any 2xx)
        if (result.ok) {
          const content = await result.text();
          return { lockFileContent: content, lockFileName: name, lockFilePresent: true };
        }
      } else if (result !== null) {
        // String content (local) — any string (including empty) means file exists and is readable
        return { lockFileContent: result, lockFileName: name, lockFilePresent: true };
      }
    } catch {
      // Continue to next lock file
    }
  }

  // 2. HEAD/access check for unsupported lock files
  for (const name of unsupportedLockFiles ?? []) {
    try {
      await checker(`${base}/${name}`);
      return { lockFileContent: null, lockFileName: name, lockFilePresent: true };
    } catch {
      // Ignore
    }
  }

  return { lockFileContent: null, lockFileName: null, lockFilePresent: false };
}

export function createHttpIngestor(
  config: HttpIngestorConfig,
): new (fetchRetryOptions?: FetchRetryOptions) => EcosystemIngestor {
  return class HttpIngestor implements EcosystemIngestor {
    readonly ecosystem = config.ecosystem;
    private readonly fetchRetryOptions: FetchRetryOptions;

    constructor(fetchRetryOptions: FetchRetryOptions = {}) {
      this.fetchRetryOptions = fetchRetryOptions;
    }

    async parseDependencies(repoPath: string, signal?: AbortSignal): Promise<IngestorResult> {
      const base = repoPath.replace(/\/$/, "");

      // Fetch all manifest files in parallel
      const manifestUrls = config.manifestFiles.map((f) => `${base}/${f}`);
      const manifestRawResults = await Promise.all(
        manifestUrls.map((url, i) => this.fetchRaw(url, signal, config.manifestFiles[i])),
      );

      const manifests: ManifestResult[] = manifestRawResults.map((raw, i) => ({
        raw,
        source: manifestUrls[i] ?? "",
      }));

      // Optimization: skip lock-file fetch entirely when no manifest resolved
      // (mirrors original npm.ts/pypi.ts/go.ts behavior)
      const anyManifestResolved = manifests.some((m) => m.raw !== null);
      let lockResult: {
        lockFileContent: string | null;
        lockFileName: string | null;
        lockFilePresent: boolean;
      } = { lockFileContent: null, lockFileName: null, lockFilePresent: false };
      if (anyManifestResolved) {
        lockResult = await fetchLockFiles(
          base,
          config.lockFileNames,
          config.unsupportedLockFiles,
          (url) => this.fetchLockFileRaw(url, signal),
          (url) => this.fetchHead(url, signal),
        );
      }

      return config.parseManifest(
        manifests,
        lockResult.lockFilePresent,
        lockResult.lockFileContent,
        lockResult.lockFileName,
      );
    }

    private async fetchRaw(
      url: string,
      signal?: AbortSignal,
      manifestFile?: string,
    ): Promise<string | null> {
      const displayName = manifestFile ?? url;
      let response: Response;
      try {
        const init: RequestInit = { ...(signal !== undefined && { signal }) };
        response = await fetchWithRetry(url, init, this.fetchRetryOptions);
      } catch (err) {
        throw new Error(`Network error fetching ${displayName} from ${url}: ${String(err)}`);
      }

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(
          `Unexpected HTTP ${String(response.status)} fetching ${displayName} from ${url}`,
        );
      }

      try {
        return await response.text();
      } catch (err) {
        throw new Error(`Failed to read response body from ${url}: ${String(err)}`);
      }
    }

    /** Fetch for lock files — returns Response so caller can check res.ok (any 2xx = success). */
    private async fetchLockFileRaw(url: string, signal?: AbortSignal): Promise<Response | null> {
      let response: Response;
      try {
        const init: RequestInit = { ...(signal !== undefined && { signal }) };
        response = await fetchWithRetry(url, init, this.fetchRetryOptions);
      } catch {
        return null;
      }

      if (response.status === 404) {
        return null;
      }

      return response;
    }

    private async fetchHead(url: string, signal?: AbortSignal): Promise<void> {
      const init: RequestInit = { method: "HEAD", ...(signal !== undefined && { signal }) };
      const res = await fetchWithRetry(url, init, this.fetchRetryOptions);
      if (!res.ok) {
        throw new Error(`HEAD ${url} returned ${String(res.status)}`);
      }
    }
  };
}

export function createLocalIngestor(config: LocalIngestorConfig): new () => EcosystemIngestor {
  return class LocalIngestor implements EcosystemIngestor {
    readonly ecosystem = config.ecosystem;

    async parseDependencies(repoPath: string, _signal?: AbortSignal): Promise<IngestorResult> {
      // Read all manifest files in parallel
      const manifestPaths = config.manifestFiles.map((f) => join(repoPath, f));
      const manifestRawResults = await Promise.all(manifestPaths.map((p) => this.readRaw(p)));

      const manifests: ManifestResult[] = manifestRawResults.map((raw, i) => ({
        raw,
        source: manifestPaths[i] ?? "",
      }));

      // Optimization: skip lock-file read entirely when no manifest resolved
      const anyManifestResolved = manifests.some((m) => m.raw !== null);
      let lockResult: {
        lockFileContent: string | null;
        lockFileName: string | null;
        lockFilePresent: boolean;
      } = { lockFileContent: null, lockFileName: null, lockFilePresent: false };
      if (anyManifestResolved) {
        lockResult = await fetchLockFiles(
          repoPath,
          config.lockFileNames,
          config.unsupportedLockFiles,
          async (path) => {
            try {
              return await readFile(path, "utf-8");
            } catch {
              return null;
            }
          },
          async (path) => {
            await access(path);
          },
        );
      }

      return config.parseManifest(
        manifests,
        lockResult.lockFilePresent,
        lockResult.lockFileContent,
        lockResult.lockFileName,
      );
    }

    private async readRaw(path: string): Promise<string | null> {
      try {
        return await readFile(path, "utf-8");
      } catch (err) {
        if (isNodeErrnoException(err) && err.code === "ENOENT") {
          return null;
        }
        throw new Error(`Failed to read ${path}: ${String(err)}`);
      }
    }
  };
}
