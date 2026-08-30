import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The design kit: the handful of primitives every screen is built from.
 *
 * Variants are expressed as data attributes rather than class lists so the
 * stylesheet keeps one selector per state and the markup stays readable —
 * the same convention the site's own panels use.
 */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "danger";
  size?: "md" | "sm";
  block?: boolean;
}

export function Button({
  variant = "default",
  size = "md",
  block = false,
  type = "button",
  children,
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      type={type}
      className="w-btn"
      data-variant={variant}
      data-size={size}
      data-block={block ? "true" : "false"}
      {...rest}
    >
      {children}
    </button>
  );
}

export type Tone = "ok" | "warn" | "bad" | "dim";

export function Pill({ tone, children }: { tone?: Tone; children: ReactNode }): ReactNode {
  return (
    <span className="w-pill" data-tone={tone}>
      {tone === "ok" || tone === "bad" || tone === "warn" ? <i className="w-dot" /> : null}
      {children}
    </span>
  );
}

export function Panel({
  title,
  aside,
  children,
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="w-panel">
      {title === undefined ? null : (
        <header className="w-panel-head">
          <span>{title}</span>
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

export function PanelBody({ children }: { children: ReactNode }): ReactNode {
  return <div className="w-panel-body">{children}</div>;
}

export function Rows({ children }: { children: ReactNode }): ReactNode {
  return <dl className="w-rows">{children}</dl>;
}

export function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: "green" | "red" | "dim";
}): ReactNode {
  return (
    <div className="w-row">
      <dt>{label}</dt>
      <dd data-tone={tone}>{value}</dd>
    </div>
  );
}

export function Note({
  tone,
  children,
}: {
  tone?: "error" | "warn" | "ok";
  children: ReactNode;
}): ReactNode {
  return (
    <p className="w-hint" data-tone={tone}>
      {children}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="w-empty">{children}</div>;
}

export function Label({ children }: { children: ReactNode }): ReactNode {
  return <span className="w-label">{children}</span>;
}
