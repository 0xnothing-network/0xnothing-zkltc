import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The design kit: the handful of primitives every screen is built from.
 *
 * Variants are expressed as data attributes rather than class lists so the
 * stylesheet keeps one selector per state and the markup stays readable —
 * the same convention the site's own panels use.
 */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `ghost` is a text-only action: "New phrase", "Forgotten the password?". */
  variant?: "default" | "primary" | "danger" | "ghost";
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
      {children}
    </span>
  );
}

export function Panel({
  title,
  aside,
  tone,
  children,
}: {
  title?: string;
  aside?: ReactNode;
  tone?: "danger";
  children: ReactNode;
}): ReactNode {
  return (
    <section className="w-panel" data-tone={tone}>
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
  boxed = false,
  children,
}: {
  tone?: "error" | "warn" | "ok";
  /** A neutral note on its own card, led by the info glyph. */
  boxed?: boolean;
  children: ReactNode;
}): ReactNode {
  if (boxed) {
    return (
      <p className="w-hint" data-tone={tone} data-boxed="true">
        <Icon name="info" size={16} />
        <span>{children}</span>
      </p>
    );
  }
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

/** The product name set in the brand face, the heading of the first-run and lock screens. */
export function Wordmark({ sub }: { sub?: ReactNode }): ReactNode {
  return (
    <div className="w-wordmark">
      <h1 className="w-wordmark-name">0xWallet</h1>
      {sub === undefined ? null : <p className="w-wordmark-sub">{sub}</p>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="w-empty">{children}</div>;
}

/** Stroke paths on a 24px grid, drawn in currentColor so every icon follows its text tone. */
const ICONS = {
  send: "M7 17L17 7M7 7h10v10",
  receive: "M17 7L7 17M17 17H7V7",
  history: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  stake: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  home: "M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4",
  trade: "M8 3L4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4",
  swap: "M7 4v16M7 4L3.5 7.5M7 4l3.5 3.5M17 20V4M17 20l-3.5-3.5M17 20l3.5-3.5",
  dapp: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18",
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  check: "M5 12.5l4.5 4.5L19 7.5",
  back: "M19 12H5M11 6l-6 6 6 6",
  close: "M6 6l12 12M18 6L6 18",
  caret: "M7 10l5 5 5-5",
  arrow: "M5 12h14M13 6l6 6-6 6",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  checkCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 12.5l2.5 2.5 4.5-5",
  trash: "M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6M10 11v6M14 11v6",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01",
  plus: "M12 5v14M5 12h14",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
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
