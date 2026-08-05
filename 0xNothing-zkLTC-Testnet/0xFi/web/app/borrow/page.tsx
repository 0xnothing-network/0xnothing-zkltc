import { BorrowWorkspace } from "@/components/BorrowWorkspace";
import { OracleFeedTable } from "@/components/OracleFeedTable";
import { PageHeading } from "@/components/UiStates";

export default function BorrowPage() {
  return <div className="fi-page"><PageHeading title="BORROW" /><BorrowWorkspace /><OracleFeedTable /></div>;
}
