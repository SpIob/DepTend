/**
 * Next 15 can hand a single search param multiple values
 * (`?severity=high&severity=low`). Both mission-board pages only ever
 * write a single comma-joined value, so the first element is the only
 * shape either reader needs to understand. The previous version lived
 * inline in each page.tsx; lifting it here keeps the contract in one
 * place and lets the test suite poke at the edge cases without needing
 * a full request context.
 */
export function firstSearchParamValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
