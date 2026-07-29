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
