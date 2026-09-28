import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Wraps a live value; when `value` goes up or down the content gets a brief positive / negative tint that
 * fades out (the `flash--up` / `flash--down` animations in styles.css; none with reduced motion). The first
 * value and unchanged values render without a tint, and the text itself is never altered.
 */
export function Flash({ value, children }: { value: number | null | undefined; children: ReactNode }) {
  const previous = useRef(value);
  const [flash, setFlash] = useState<{ dir: 'up' | 'down'; n: number } | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (before === null || before === undefined || value === null || value === undefined || before === value)
      return;
    setFlash((f) => ({ dir: value > before ? 'up' : 'down', n: (f?.n ?? 0) + 1 }));
  }, [value]);

  // A new key per change restarts the animation, also for two changes in the same direction.
  return (
    <span key={flash?.n ?? 0} className={flash ? `flash flash--${flash.dir}` : undefined}>
      {children}
    </span>
  );
}
