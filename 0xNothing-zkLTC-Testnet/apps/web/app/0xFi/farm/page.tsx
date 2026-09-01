import { permanentRedirect } from "next/navigation";

export default async function LegacyFarmRoute({
  searchParams,
}: {
  searchParams: Promise<{ pair?: string | string[] }>;
}) {
  const query = await searchParams;
  const pair = typeof query.pair === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(query.pair)
    ? `?pair=${encodeURIComponent(query.pair)}`
    : "";
  permanentRedirect(`/0xFi/earn${pair}`);
}
