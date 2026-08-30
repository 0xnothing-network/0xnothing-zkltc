export const PUBLIC_APP_URL = "https://0xnothing.xyz";
/** Public indexers used by the web app; the wallet falls back to them on API throttling. */
export const PUMP_SUBGRAPH_URL =
  "https://api.goldsky.com/api/public/project_cmqmpust19i8v01t595z8hpq4/subgraphs/zeroxpump-testnet/staging/gn";
export const FI_SUBGRAPH_URL =
  "https://api.goldsky.com/api/public/project_cms8vgtcn6a6z01r5fo87d6im/subgraphs/zeroxfi-testnet/staging/gn";

export interface DappEntry {
  id: string;
  /** Shown as the card title — kept identical to the site's own naming. */
  title: string;
  subtitle: string;
  url: string;
  /** Two-letter mark drawn in the card badge when there is no image. */
  mark: string;
}

/**
 * The DAPP tab is a launcher onto the live site.
 *
 * On the extension the pages get a real injected provider (EIP-1193 +
 * EIP-6963), so they connect to this wallet like any other. On Android the
 * links open in the system browser, where the site uses its own connectors —
 * a cross-origin WebView cannot receive an injected provider without a native
 * plugin, so the wallet does not pretend otherwise.
 */
export const DAPPS: readonly DappEntry[] = [
  {
    id: "fi-swap",
    title: "0xFi Swap",
    subtitle: "NUSD-hub AMM + oracle mint",
    url: `${PUBLIC_APP_URL}/0xFi/swap`,
    mark: "FI",
  },
  {
    id: "fi-pools",
    title: "0xFi Pools",
    subtitle: "Liquidity & LP positions",
    url: `${PUBLIC_APP_URL}/0xFi/pools`,
    mark: "LP",
  },
  {
    id: "fi-lend",
    title: "0xFi Lend",
    subtitle: "Supply NUSD, earn interest",
    url: `${PUBLIC_APP_URL}/0xFi/lend`,
    mark: "LD",
  },
  {
    id: "fi-borrow",
    title: "0xFi Borrow",
    subtitle: "Collateralised NUSD debt",
    url: `${PUBLIC_APP_URL}/0xFi/borrow`,
    mark: "BR",
  },
  {
    id: "pump",
    title: "0xPump",
    subtitle: "Bonding-curve token launches",
    url: `${PUBLIC_APP_URL}/0xPump`,
    mark: "PM",
  },
  {
    id: "pixel",
    title: "0xPixel",
    subtitle: "On-chain pixel art & market",
    url: `${PUBLIC_APP_URL}/0xpixel`,
    mark: "PX",
  },
  {
    id: "docs",
    title: "Docs",
    subtitle: "Addresses, ABIs, integration",
    url: `${PUBLIC_APP_URL}/docs`,
    mark: "DX",
  },
];
