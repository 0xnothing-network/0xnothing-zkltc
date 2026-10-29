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

/** The wallet mark over a screen's opening line; the same image the extension icon uses. */
export function Brand(): ReactNode {
  return (
    <div className="w-brand" aria-hidden="true">
      <img src="./icons/icon-128.png" alt="" width={64} height={64} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="w-empty">{children}</div>;
}

/** Stroke paths on a 24px grid, drawn in currentColor so every icon follows its text tone. */
const ICONS = {
  send: "M12 19V5M5 12l7-7 7 7",
  receive: "M12 5v14M5 12l7 7 7-7",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  stake: "M12 3l8 4.5-8 4.5-8-4.5L12 3zM4 12l8 4.5 8-4.5M4 16.5L12 21l8-4.5",
  home: "M4 10.5L12 4l8 6.5V20h-5.5v-6h-5v6H4z",
  swap: "M7 4v16M7 4L3.5 7.5M7 4l3.5 3.5M17 20V4M17 20l-3.5-3.5M17 20l3.5-3.5",
  dapp: "M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  check: "M5 12.5l4.5 4.5L19 7.5",
  back: "M19 12H5M11 6l-6 6 6 6",
  close: "M6 6l12 12M18 6L6 18",
  caret: "M7 10l5 5 5-5",
  arrow: "M5 12h14M13 6l6 6-6 6",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }): ReactNode {
  return (
    <svg
      className="w-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}
