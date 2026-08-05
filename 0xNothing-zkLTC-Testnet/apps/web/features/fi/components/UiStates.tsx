import Link from "next/link";
import {
  ArrowSquareOut,
  ChartLineDown,
  Warning,
} from "@phosphor-icons/react/dist/ssr";
import type { Address, Hash } from "viem";
import { explorerAddressUrl, explorerTransactionUrl } from "@fi/config/deployment";
import { fiPath } from "@fi/config/paths";
import { shortAddress } from "@fi/lib/format";

export function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="fi-page-heading">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="fi-heading-action">{action}</div> : null}
    </header>
  );
}

export function PanelHeading({
  title,
  label,
  trailing,
}: {
  title: string;
  label?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="fi-panel-heading">
      <div>
        {label ? <span className="fi-label">{label}</span> : null}
        <h2>{title}</h2>
      </div>
      {trailing}
    </div>
  );
}

export function MetricStrip({
  metrics,
}: {
  metrics: Array<{ label: string; value: React.ReactNode; tone?: "default" | "positive" | "warning" | "danger" }>;
}) {
  return (
    <dl className="fi-metric-strip">
      {metrics.map((metric) => (
        <div key={metric.label}>
          <dt>{metric.label}</dt>
          <dd data-tone={metric.tone ?? "default"}>{metric.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function NotDeployed({ feature }: { feature: string }) {
  return (
    <div className="fi-inline-state fi-inline-warning" role="status">
      <Warning size={17} weight="bold" aria-hidden="true" />
      <div>
        <strong>Not deployed</strong>
        <p>{feature}</p>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="fi-empty-state">
      <ChartLineDown size={26} aria-hidden="true" />
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="fi-empty-state fi-error-state" role="alert">
      <Warning size={26} weight="bold" aria-hidden="true" />
      <h2>Data unavailable</h2>
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="fi-button fi-button-muted" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function SkeletonRows({ count = 4, label = "Loading data" }: { count?: number; label?: string }) {
  return (
    <div className="fi-skeleton-list" role="status" aria-label={label}>
      {Array.from({ length: count }).map((_, index) => (
        <div className="fi-skeleton-row" aria-hidden="true" key={index}>
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

export function AddressLink({ address }: { address: Address }) {
  return (
    <a className="fi-address-link" href={explorerAddressUrl(address)} target="_blank" rel="noreferrer">
      {shortAddress(address)}
      <ArrowSquareOut size={13} aria-hidden="true" />
    </a>
  );
}

export function TransactionStatus({
  phase,
  message,
  hash,
}: {
  phase: string;
  message: string;
  hash?: Hash;
}) {
  if (phase === "idle" || !message) return null;
  return (
    <div
      className="fi-transaction-status"
      data-state={phase}
      role={phase === "error" ? "alert" : "status"}
      aria-live={phase === "error" ? "assertive" : "polite"}
    >
      <span>{message}</span>
      {hash ? (
        <a href={explorerTransactionUrl(hash)} target="_blank" rel="noreferrer">
          View transaction <ArrowSquareOut size={13} aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}

export function RouteLink({ href, children }: { href: `/${string}`; children: React.ReactNode }) {
  return (
    <Link className="fi-text-link" href={fiPath(href)}>
      {children}
    </Link>
  );
}
