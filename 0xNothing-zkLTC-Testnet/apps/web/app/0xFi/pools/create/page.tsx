import { CreatePoolForm } from "@fi/components/CreatePoolForm";
import { PageHeading, RouteLink } from "@fi/components/UiStates";

export default function CreatePoolPage() {
  return (
    <div className="fi-page fi-trade-page fi-create-page">
      <RouteLink href="/pools" back>Back to pools</RouteLink>
      <PageHeading title="Create Pool" />
      <CreatePoolForm />
    </div>
  );
}
