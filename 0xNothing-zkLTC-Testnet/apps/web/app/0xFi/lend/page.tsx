import { Suspense } from "react";
import type { Metadata } from "next";
import { LendBorrowDashboard } from "@fi/components/LendBorrowDashboard";
import { OracleFeedTable } from "@fi/components/OracleFeedTable";
import { PageHeading } from "@fi/components/UiStates";

export const metadata: Metadata = { title: "Lend & Borrow" };

export default function LendPage() {
  return (
    <div className="fi-page">
      <PageHeading title="Lend & Borrow" />
      <Suspense fallback={null}>
        <LendBorrowDashboard />
      </Suspense>
      <OracleFeedTable />
    </div>
  );
}
