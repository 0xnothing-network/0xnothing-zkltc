import type { Address } from "viem";
import type { readNusdMarket } from "./nusdMarketplace";

type Listing = Awaited<ReturnType<typeof readNusdMarket>>["listings"][number];
type ArtworkToken = { collection: string; tokenId: bigint };
export type NusdArtwork = Record<string, { name: string } | null>;
export type NusdListingSort = "newest" | "price-asc" | "price-desc";

export function nusdArtworkKey(collection: string, tokenId: bigint | string): string {
  return `${collection.toLowerCase()}:${tokenId.toString()}`;
}

export function nusdArtworkRequests(tokens: readonly ArtworkToken[], limit = 48): { collection: string; ids: string[]; url: string }[] {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1024) throw new Error("Invalid artwork batch limit");
  const groups = new Map<string, Set<string>>();
  for (const token of tokens.slice(0, limit)) {
    const collection = token.collection.toLowerCase();
    const ids = groups.get(collection) ?? new Set<string>();
    ids.add(token.tokenId.toString());
    groups.set(collection, ids);
  }
  return Array.from(groups).sort(([first], [second]) => first.localeCompare(second)).flatMap(([collection, ids]) => {
    const sorted = Array.from(ids).sort((first, second) => BigInt(first) < BigInt(second) ? -1 : BigInt(first) > BigInt(second) ? 1 : 0);
    const requests = [];
    for (let offset = 0; offset < sorted.length; offset += 20) {
      const batch = sorted.slice(offset, offset + 20);
      requests.push({ collection, ids: batch, url: `/api/token-metadata?collection=${collection}&ids=${batch.join(",")}` });
    }
    return requests;
  });
}

export async function readNusdArtwork(
  requests: ReturnType<typeof nusdArtworkRequests>,
  request: (url: string) => Promise<{ tokens: Record<string, { name: string } | null> }>,
): Promise<{ tokens: NusdArtwork; failed: number }> {
  const results: PromiseSettledResult<NusdArtwork>[] = new Array(requests.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(4, requests.length) }, async () => {
    while (nextIndex < requests.length) {
      const index = nextIndex++;
      const batch = requests[index];
      try {
        const response = await request(batch.url);
        const tokens: NusdArtwork = {};
        for (const tokenId of batch.ids) {
          const metadata = response.tokens[tokenId];
          tokens[nusdArtworkKey(batch.collection, tokenId)] = metadata && typeof metadata.name === "string"
            ? { name: metadata.name.slice(0, 200) }
            : null;
        }
        results[index] = { status: "fulfilled", value: tokens };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));
  const tokens: NusdArtwork = {};
  let failed = 0;
  for (const result of results) {
    if (result.status === "fulfilled") Object.assign(tokens, result.value);
    else failed += 1;
  }
  return { tokens, failed };
}

export function filterNusdListings(
  listings: readonly Listing[],
  artwork: NusdArtwork,
  filters: { search: string; collection: string; ownOnly: boolean; address?: Address; sort: NusdListingSort },
): Listing[] {
  const search = filters.search.trim().toLowerCase().slice(0, 120);
  return listings.filter((listing) => {
    if (filters.collection && listing.collection.toLowerCase() !== filters.collection.toLowerCase()) return false;
    if (filters.ownOnly && (!filters.address || listing.seller.toLowerCase() !== filters.address.toLowerCase())) return false;
    const name = artwork[nusdArtworkKey(listing.collection, listing.tokenId)]?.name ?? "";
    return !search || [name, `#${listing.tokenId}`, listing.collection, listing.seller].some((value) => value.toLowerCase().includes(search));
  }).sort((first, second) => {
    if (filters.sort !== "newest" && first.price !== second.price) {
      const ascending = first.price < second.price ? -1 : 1;
      return filters.sort === "price-asc" ? ascending : -ascending;
    }
    return first.id > second.id ? -1 : first.id < second.id ? 1 : 0;
  });
}
