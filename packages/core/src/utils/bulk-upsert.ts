/**
 * Generic Bulk Upsert Helpers
 *
 * Reusable patterns for:
 *   - Bulk INSERT ... ON CONFLICT DO UPDATE (single round-trip)
 *   - Bulk UPDATE ... FROM (VALUES ...) (single round-trip)
 *
 * Used by scorer/writer.ts and ingestor/writer.ts to replace
 * per-row round-trip loops with constant round-trips.
 */

import { sql, type SQL } from "drizzle-orm";
import type { PgColumn, AnyPgTable } from "drizzle-orm/pg-core";

export interface BulkInsertConfig<TRow extends Record<string, unknown>, TTable extends AnyPgTable> {
  table: TTable;
  rows: TRow[];
  conflictTargets: PgColumn[];
  updateColumns: (keyof TRow)[];
  returningColumns?: PgColumn[];
}

export interface BulkUpdateConfig<TRow extends Record<string, unknown>, TTable extends AnyPgTable> {
  table: TTable;
  rows: TRow[];
  idColumn: PgColumn;
  updateColumns: (keyof TRow)[];
  whereColumn: PgColumn;
}

interface DrizzleDb {
  insert: (table: AnyPgTable) => {
    values: (rows: Record<string, unknown>[]) => {
      onConflictDoUpdate: (config: { target: PgColumn[]; set: Record<string, SQL> }) => {
        returning: (columns: SQL | PgColumn) => Promise<{ id: string }[]>;
      };
    };
  };
  execute: (query: SQL) => Promise<void>;
}

/**
 * Builds a parameterized VALUES clause for bulk operations.
 * Uses sql.param() to ensure proper parameter binding.
 */
export function buildValuesClause<TRow extends Record<string, unknown>>(
  rows: TRow[],
  columns: (keyof TRow)[],
): SQL[] {
  return rows.map((row) => {
    const params = columns.map((col) => sql.param(row[col]));
    return sql`(${sql.join(params, sql`, `)})`;
  });
}

/**
 * Executes a bulk INSERT ... ON CONFLICT DO UPDATE.
 * Returns the inserted row IDs in input order (null for rows that conflicted).
 */
export async function bulkInsertOnConflict<
  TRow extends Record<string, unknown>,
  TTable extends AnyPgTable,
>(
  db: DrizzleDb,
  config: BulkInsertConfig<TRow, TTable>,
): Promise<{ ids: (string | null)[]; created: number }> {
  const { table, rows, conflictTargets, updateColumns, returningColumns } = config;

  if (rows.length === 0) {
    return { ids: [], created: 0 };
  }

  // rows.length > 0 guaranteed by check above
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const firstRow = rows[0]!;
  const columns = Object.keys(firstRow) as (keyof TRow)[];
  buildValuesClause(rows, columns);

  // returningColumns.length > 0 guaranteed by check
  const returning: SQL | PgColumn = returningColumns?.length
    ? (returningColumns[0] as SQL | PgColumn)
    : sql`id`;
  const insertResult = await db
    .insert(table)
    .values(rows)
    .onConflictDoUpdate({
      target: conflictTargets,
      set: Object.fromEntries(updateColumns.map((col) => [col, sql`excluded.${String(col)}`])),
    })
    .returning(returning);

  const ids: (string | null)[] = rows.map(() => null);
  let created = 0;

  if (insertResult.length === rows.length) {
    for (let i = 0; i < insertResult.length; i++) {
      const id = insertResult[i]?.id;
      if (id) {
        ids[i] = id;
        created++;
      }
    }
  }

  return { ids, created };
}

/**
 * Executes a bulk UPDATE ... FROM (VALUES ...).
 * All rows updated in a single round-trip.
 */
export async function bulkUpdateFromValues<TRow extends Record<string, unknown>>(
  db: DrizzleDb,
  config: BulkUpdateConfig<TRow, AnyPgTable>,
): Promise<number> {
  const { table, rows, idColumn, updateColumns, whereColumn } = config;

  if (rows.length === 0) {
    return 0;
  }

  const valueClauses: SQL[] = [];
  for (const row of rows) {
    const params = [sql.param(row[idColumn.name as keyof TRow])];
    for (const col of updateColumns) {
      params.push(sql.param(row[col]));
    }
    valueClauses.push(sql`(${sql.join(params, sql`, `)})`);
  }

  const valuesUnion = sql.join(valueClauses, sql`, `);

  const columnNames = [idColumn.name, ...updateColumns.map(String)];
  const aliasColumns = sql.join(
    columnNames.map((name) => sql.identifier(name)),
    sql`, `,
  );

  await db.execute(
    sql`UPDATE ${table} SET ${sql.join(
      updateColumns.map(
        (col) => sql`${sql.identifier(String(col))} = v.${sql.identifier(String(col))}`,
      ),
      sql`, `,
    )} FROM (VALUES ${valuesUnion}) AS v(${aliasColumns}) WHERE ${table}.${whereColumn} = v.${sql.identifier(idColumn.name)}`,
  );

  return rows.length;
}

/**
 * Executes a bulk UPSERT (INSERT ... ON CONFLICT DO UPDATE) where the table
 * has a unique constraint on the ID column. Used for mission_scores.
 */
export function bulkUpsertById<TRow extends Record<string, unknown>>(
  db: DrizzleDb,
  table: AnyPgTable,
  rows: TRow[],
  idColumn: PgColumn[],
  updateColumns: (keyof TRow)[],
): void {
  if (rows.length === 0) return;

  db.insert(table)
    .values(rows)
    .onConflictDoUpdate({
      target: idColumn,
      set: Object.fromEntries(updateColumns.map((col) => [col, sql`excluded.${String(col)}`])),
    });
}
