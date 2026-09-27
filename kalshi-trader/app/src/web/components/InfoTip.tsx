import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const GAP = 6;
const MARGIN = 8;

/**
 * A small ⓘ button that explains the thing next to it: the text shows on hover, on keyboard focus and on
 * tap (a click pins it open until the next click, Escape or focus leaving). The explanation is rendered in a
 * portal only while open, so it never adds to the surrounding text (table cells, labels, headings) and is not
 * clipped by scrolling tables or drawers. The button's accessible name is neutral on purpose: a name that
 * repeated the label would also match queries for the labelled control.
 */
export function InfoTip({ children, className }: { children: ReactNode; className?: string }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const close = () => {
    pinned.current = false;
    setOpen(false);
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const b = button.current?.getBoundingClientRect();
    const t = tip.current?.getBoundingClientRect();
    if (!b || !t) return;
    const left = Math.min(
      Math.max(MARGIN, b.left + b.width / 2 - t.width / 2),
      window.innerWidth - t.width - MARGIN,
    );
    const below = b.bottom + GAP;
    const top = below + t.height > window.innerHeight - MARGIN ? b.top - GAP - t.height : below;
    setPos({ top: Math.max(MARGIN, top), left: Math.max(MARGIN, left) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    // A fixed-position tip would drift away from its button while the page scrolls.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`info-tip${className ? ` ${className}` : ''}`}
        aria-label="More information"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onPointerEnter={(e) => e.pointerType === 'mouse' && setOpen(true)}
        onPointerLeave={(e) => e.pointerType === 'mouse' && !pinned.current && setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          pinned.current = !pinned.current || !open;
          setOpen(pinned.current);
        }}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="8" cy="4.8" r="1" fill="currentColor" />
          <path d="M8 7.2v4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={tip}
            id={id}
            role="tooltip"
            className="info-tip-bubble"
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

type HeadingLevel = 'h1' | 'h2' | 'h3';

/** A heading followed by its ⓘ explanation (kept outside the heading, so the heading's name stays clean). */
export function TitleTip({
  as: H = 'h3',
  id,
  title,
  tip,
}: {
  as?: HeadingLevel;
  id?: string;
  title: ReactNode;
  tip: ReactNode;
}) {
  return (
    <div className={`title-row title-row--${H}`}>
      <H id={id}>{title}</H>
      <InfoTip>{tip}</InfoTip>
    </div>
  );
}

/** A form label followed by its ⓘ explanation (outside the `<label>`, so a tap on ⓘ never toggles the input). */
export function LabelTip({ htmlFor, label, tip }: { htmlFor: string; label: ReactNode; tip: ReactNode }) {
  return (
    <span className="label-row">
      <label htmlFor={htmlFor}>{label}</label>
      <InfoTip>{tip}</InfoTip>
    </span>
  );
}

/** Inline content (a check box label, a status label, a legend text) followed by its ⓘ explanation. */
export function WithTip({ children, tip }: { children: ReactNode; tip: ReactNode }) {
  return (
    <span className="with-tip">
      {children}
      <InfoTip>{tip}</InfoTip>
    </span>
  );
}
