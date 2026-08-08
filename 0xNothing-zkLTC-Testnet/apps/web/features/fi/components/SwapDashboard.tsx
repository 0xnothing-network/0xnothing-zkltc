import Link from "next/link";
import { GraduationExplainer } from "@fi/components/GraduationExplainer";
import { OracleFeedTable } from "@fi/components/OracleFeedTable";
import { SwapWorkspace } from "@fi/components/SwapWorkspace";
import { PageHeading } from "@fi/components/UiStates";
import { fiPath } from "@fi/config/paths";

export function SwapDashboard() {
  return (
    <div className="fi-page">
      <PageHeading
        title="SWAP"
        description="Mint or redeem NUSD against zkLTC at the DIA price, or route trades through live 0xFi liquidity."
        action={<Link className="fi-button fi-button-muted" href={fiPath("/pools")}>Browse pools</Link>}
      />
      <div className="fi-workspace-grid">
        <div className="fi-main-stack">
          <OracleFeedTable />
          <GraduationExplainer />
        </div>
        <SwapWorkspace />
      </div>
    </div>
  );
}
