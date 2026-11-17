import type { IngestionStatus } from "@deptend/core/db/schema.js";

/**
 * Human note for a repo that isn't in a normal "complete, has missions or
 * doesn't" state — used by both repo-card.tsx (directory grid) and
 * /repo/[owner]/[name] (detail page header) so a repo that's still
 * ingesting, failed, or has no analyzable manifest reads the same way in
 * both places. Returns null for "complete", the only status where mission
 * counts are meaningful to show instead.
 */
export function ingestionStatusNote(status: IngestionStatus): string | null {
  switch (status) {
    case "pending":
      return "Pending ingestion";
    case "running":
      return "Ingesting…";
    case "failed":
      return "Ingestion failed";
    case "skipped":
      return "No manifest found";
    case "complete":
      return null;
  }
}

/**
 * Detailed status line for the repo page header when ingestionStatus is not "complete".
 * Maps each enum value to a plain-language explanation of what the submitter should do,
 * including the ingestionError text when present.
 */
export function ingestionStatusDetail(
  status: IngestionStatus,
  ingestionError: string | null,
): string {
  switch (status) {
    case "pending":
      return "This repo is queued for ingestion. It will be processed automatically.";
    case "running":
      return "Ingestion is currently in progress. Check back in a few minutes.";
    case "failed":
      return ingestionError
        ? `Ingestion failed: ${ingestionError}. It will be retried automatically.`
        : "Ingestion failed with no error details. It will be retried automatically.";
    case "skipped":
      return ingestionError
        ? `No analyzable manifest found: ${ingestionError}. Ensure a package.json, pyproject.toml, requirements.txt, go.mod, or Cargo.toml exists at the repository root.`
        : "No analyzable manifest found. Ensure a package.json, pyproject.toml, requirements.txt, go.mod, or Cargo.toml exists at the repository root.";
    case "complete":
      // Should not be called for complete status, but exhaustiveness requires a case.
      return "Indexed successfully.";
  }
}
