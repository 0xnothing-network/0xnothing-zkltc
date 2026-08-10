import { BorrowWorkspace } from "@fi/components/BorrowWorkspace";
import { OracleFeedTable } from "@fi/components/OracleFeedTable";
import { PageHeading } from "@fi/components/UiStates";

export default function BorrowPage() {
  return (
    <div className="fi-page">
      <PageHeading title="Borrow" />
      <BorrowWorkspace />
      <OracleFeedTable />
    </div>
  );
}
