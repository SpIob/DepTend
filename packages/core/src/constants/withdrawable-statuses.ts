/**
 * Withdrawable ingestion statuses — single source of truth shared between
 * server (withdrawOwnRepo) and client (WithdrawButton).
 *
 * Only "pending" and "skipped" repos can be self-withdrawn by the submitter.
 * "running" is excluded to avoid deleting a row out from under an in-flight
 * ingestion job. "failed" is left to resolvePending()'s automatic retry.
 * "complete" is permanently indexed.
 */
import type { IngestionStatus } from "../db/schema.js";

export const WITHDRAWABLE_INGESTION_STATUSES: readonly IngestionStatus[] = ["pending", "skipped"];
