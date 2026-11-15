/**
 * One card slot under Home's balance: "What is new" wins over the
 * first-run card, so the two never show together. Import-free.
 */
export type HomeSlot = "news" | "first" | null;

/**
 * The first-run card: a loaded portfolio that holds nothing at all and a
 * history with no row. An unknown portfolio or history, or a balance that
 * could not be read (its zero is a placeholder), is not "empty".
 */
export function firstRunDue(
  portfolio: { totalWad: bigint; rows: readonly { balance: bigint; readError: string | null }[] } | null,
  failed: boolean,
  historyCount: number | null,
): boolean {
  if (portfolio === null || failed || historyCount !== 0) return false;
  return portfolio.totalWad === 0n && portfolio.rows.every((row) => row.balance === 0n && row.readError === null);
}

export function homeSlot(newsDue: boolean, firstRun: boolean): HomeSlot {
  if (newsDue) return "news";
  return firstRun ? "first" : null;
}
