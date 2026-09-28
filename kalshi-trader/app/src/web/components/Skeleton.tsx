/**
 * Loading placeholders shaped like the content they stand in for, so nothing jumps when the data arrives.
 * Screen readers hear the label ("Loading…") once; the grey shapes are decorative.
 */
export function SkeletonLines({ lines = 3, label = 'Loading…' }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton-lines" role="status" aria-busy="true">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton" aria-hidden="true" />
      ))}
    </div>
  );
}

/** Table-shaped placeholder: a header bar and `rows` row bars. */
export function SkeletonTable({ rows = 4, label = 'Loading…' }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton-lines" role="status" aria-busy="true">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows + 1 }, (_, i) => (
        <span key={i} className="skeleton skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}
