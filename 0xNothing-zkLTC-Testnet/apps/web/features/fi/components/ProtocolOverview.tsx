"use client";

import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react";
import { deployment } from "@fi/config/deployment";
import { fiPath } from "@fi/config/paths";
import { PageHeading, PanelHeading } from "@fi/components/UiStates";

const SURFACES = [
  { href: "/swap", label: "Swap", keys: ["dexRouter", "nusd"] as const },
  { href: "/pools", label: "Pools", keys: ["dexFactory", "dexRouter"] as const },
  { href: "/farm", label: "Farm", keys: ["farmFactory"] as const },
  { href: "/lend", label: "Lend", keys: ["lendingPool", "nusd"] as const },
  { href: "/borrow", label: "Borrow", keys: ["lendingPool", "ltcOracle", "wzkltc"] as const },
  { href: "/synth", label: "Synth", keys: ["nbtcVault", "nethVault", "btcOracle", "ethOracle"] as const },
] as const;

export function ProtocolOverview() {
  return (
    <div className="fi-page">
      <PageHeading
        title="0xFi"
        action={<Link className="fi-button fi-button-primary" href={fiPath("/swap")}>Open swap <ArrowRight size={14} weight="bold" aria-hidden="true" /></Link>}
      />

      <section className="fi-panel fi-panel-flush">
        <PanelHeading title="MARKETS" />
        <div className="fi-protocol-list">
          {SURFACES.map((surface) => {
            const ready = surface.keys.every((key) => Boolean(deployment.contracts[key]));
            return (
              <Link className="fi-protocol-row" href={fiPath(surface.href)} key={surface.href}>
                <strong>{surface.label}</strong>
                <span className="fi-status" data-state={ready ? "live" : "warning"}>{ready ? "LIVE" : "SETUP"}</span>
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
