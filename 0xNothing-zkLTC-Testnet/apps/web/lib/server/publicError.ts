/** An error whose message is intentionally safe to return to an API client. */
export class PublicRouteError extends Error {}

/** Never expose arbitrary RPC, indexer, explorer, or fetch error text. */
export function publicErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof PublicRouteError) {
    const message = error.message.trim();
    if (message) return message;
  }
  return fallback;
}
