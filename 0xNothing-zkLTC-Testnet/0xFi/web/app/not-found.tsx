import Link from "next/link";
import { EmptyState } from "@/components/UiStates";

export default function NotFound() {
  return (
    <div className="fi-page">
      <EmptyState title="Market not found" description="This 0xFi route or pair does not exist." action={<Link className="fi-button fi-button-muted" href="/">Back to overview</Link>} />
    </div>
  );
}
