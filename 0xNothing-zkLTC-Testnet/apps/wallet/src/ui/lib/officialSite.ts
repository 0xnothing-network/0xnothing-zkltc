import { OFFICIAL_SITE_DOMAINS, OFFICIAL_SITE_HOSTS } from "../../config/dapps.ts";
import { damerauLevenshtein, foldConfusables, punycodeToUnicode } from "../../core/lib/confusables.ts";

/**
 * "official": one of the exact 0xNothing hosts over https.
 * "lookalike": a host a person could read as one of them (a near spelling, other
 * scripts' letters, the name used as a label of another domain, or the real host
 * without https). The approval window warns and never blocks.
 * "none": anything else, including the owner's own subdomains.
 */
export type SiteMark = "official" | "lookalike" | "none";

const BRAND = foldConfusables("0xnothing");

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":");
}

function labelLooksLikeBrand(label: string): boolean {
  const decoded = punycodeToUnicode(label) ?? label;
  const joined = decoded.replace(/-/g, "");
  const parts = [decoded, joined, ...decoded.split("-")];
  if (parts.some((part) => foldConfusables(part).includes(BRAND))) return true;
  const folded = foldConfusables(joined);
  if (folded.length < 6) return false;
  const distance = damerauLevenshtein(folded, BRAND, 2);
  // "nothing" is two edits away at seven letters: unrelated brands with that
  // word are not flagged, while one-letter slips of the full name are.
  return distance <= 1 || (distance <= 2 && folded.length >= 9);
}

/** Total: reads only the browser-reported origin, never page text, and never throws. */
export function siteMark(origin: string): SiteMark {
  try {
    if (typeof origin !== "string" || origin.length > 2048) return "none";
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "none";
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host === "" || host === "localhost" || isIpLiteral(host)) return "none";
    if (OFFICIAL_SITE_HOSTS.includes(host)) {
      return url.protocol === "https:" && url.port === "" ? "official" : "lookalike";
    }
    if (OFFICIAL_SITE_DOMAINS.some((domain) => host.endsWith(`.${domain}`))) return "none";
    return host.split(".").some(labelLooksLikeBrand) ? "lookalike" : "none";
  } catch {
    return "none";
  }
}
