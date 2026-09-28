/** Shared TanStack Table column options: numeric columns are right-aligned (header and cells). */
import type { RowData } from '@tanstack/react-table';

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- must match the library's declaration
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Numbers: the header and cells are right-aligned (`.num`). */
    numeric?: boolean;
  }
}

/** Spread into a column definition whose values are numbers. */
export const NUMERIC = { meta: { numeric: true } };

/** The class of a header / cell of a column with `meta`. */
export const cellClass = (meta: { numeric?: boolean } | undefined): string | undefined =>
  meta?.numeric ? 'num' : undefined;
