import { useEffect, useId, useRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Section header in the Swiss manner: index, title, rule, optional actions. */
export function SectionHead({ index, title, aside, id }: { index?: string; title: string; aside?: ReactNode; id?: string }) {
  return (
    <header className="sx-sechead">
      {index && <span className="sx-idx">{index}</span>}
      <h2 id={id}>{title}</h2>
      <span className="sx-rule" aria-hidden />
      {aside && <div className="sx-sechead-aside">{aside}</div>}
    </header>
  );
}

export function PageHead({ index, title, kicker, aside }: { index: string; title: string; kicker?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="sx-pagehead">
      <div className="sx-pagehead-idx" aria-hidden>
        {index}
      </div>
      <div className="sx-pagehead-main">
        <h1>{title}</h1>
        {kicker && <p className="sx-kicker">{kicker}</p>}
      </div>
      {aside && <div className="sx-pagehead-aside">{aside}</div>}
    </div>
  );
}

export function Btn({ variant = "ghost", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "quiet" }) {
  return <button type="button" className={`sx-btn sx-btn-${variant} ${className}`} {...rest} />;
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "accent";

/** Status chip: always an icon glyph plus a label, never color alone. */
export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  const glyph = { neutral: "○", good: "✓", warn: "!", bad: "✕", accent: "●" }[tone];
  return (
    <span className={`sx-chip sx-chip-${tone}`} title={title}>
      <span aria-hidden className="sx-chip-glyph">
        {glyph}
      </span>
      {children}
    </span>
  );
}

/** A figure that opens its definition and provenance. */
export function Figure({ label, value, sub, onExplain, size = "m" }: { label: string; value: ReactNode; sub?: ReactNode; onExplain?: () => void; size?: "s" | "m" | "l" | "xl" }) {
  const body = (
    <>
      <span className="sx-fig-label">{label}</span>
      <span className={`sx-fig-value sx-fig-${size}`}>{value}</span>
      {sub && <span className="sx-fig-sub">{sub}</span>}
    </>
  );
  return onExplain ? (
    <button type="button" className="sx-fig sx-fig-link" onClick={onExplain} title="Definition and provenance">
      {body}
    </button>
  ) : (
    <div className="sx-fig">{body}</div>
  );
}

/** Right-hand sliding panel; Esc or the scrim closes it. */
export function SlidePanel({ title, kicker, onClose, children, wide }: { title: string; kicker?: ReactNode; onClose(): void; children: ReactNode; wide?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sx-panel-root">
      <div className="sx-scrim" onClick={onClose} aria-hidden />
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={id} className={`sx-panel ${wide ? "sx-panel-wide" : ""}`}>
        <div className="sx-panel-head">
          <div>
            {kicker && <div className="sx-panel-kicker">{kicker}</div>}
            <h2 id={id}>{title}</h2>
          </div>
          <Btn variant="quiet" aria-label="Close panel" onClick={onClose}>
            Close ✕
          </Btn>
        </div>
        <div className="sx-panel-body">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="sx-field">
      <span className="sx-field-label">{label}</span>
      {children}
      {hint && <span className="sx-field-hint">{hint}</span>}
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="sx-empty">{children}</div>;
}

export function ErrorLine({ error }: { error: { message: string } | null }) {
  return error ? (
    <p className="sx-error" role="alert">
      {error.message}
    </p>
  ) : null;
}

/** Definition list in two columns, hairline-separated. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="sx-facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
