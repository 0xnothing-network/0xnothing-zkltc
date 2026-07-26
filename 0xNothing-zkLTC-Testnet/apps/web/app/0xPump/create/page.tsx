import type { Metadata } from "next";
import { CreateTokenForm } from "@/features/pump/components/CreateTokenForm";

export const metadata: Metadata = {
  title: "Create token | 0xPump",
  description: "Create a NUSD bonding-curve token market on 0xPump.",
};

export default function CreatePumpTokenPage() {
  return (
    <main className="pump-page pump-create-page">
      <section className="pump-page-heading">
        <div><span className="pump-eyebrow">Permissionless launch</span><h1>Create a token</h1></div>
      </section>
      <CreateTokenForm />
    </main>
  );
}
