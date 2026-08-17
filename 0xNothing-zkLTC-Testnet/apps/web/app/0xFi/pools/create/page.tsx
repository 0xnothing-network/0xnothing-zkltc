import { CreatePoolForm } from "@fi/components/CreatePoolForm";
import { PageHeading, RouteLink } from "@fi/components/UiStates";

export default function CreatePoolPage() {
  return (
    <div className="fi-page fi-trade-page">
      <PageHeading
        title="Create Pool"
        action={<RouteLink href="/pools">Back to pools</RouteLink>}
      />
      <CreatePoolForm />
    </div>
  );
}
