/**
 * History as a CSV file. Summaries and details come from labels the
 * wallet wrote, but a detail can hold text a token contract chose (a symbol),
 * so every cell is treated as hostile to a spreadsheet: one that starts like a
 * formula is defused with a leading apostrophe (the OWASP CSV-injection rule),
 * and every cell is quoted so commas, quotes and line breaks stay inside it.
 */
const FORMULA_START = /^[=+\-@\t\r]/u;

export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/gu, '""')}"`;
}

/** RFC 4180 lines (CRLF), the header first. */
export function historyCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** `0xwallet-history-<chainId>-<yyyymmdd>.csv`, the date in UTC. */
export function historyFileName(chainId: number, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10).replace(/-/gu, "");
  return `0xwallet-history-${chainId}-${day}.csv`;
}

/**
 * Hands the file to the browser. The BOM makes spreadsheet apps read the
 * non-ASCII summaries as UTF-8; the object URL is released after the click.
 */
export function downloadCsv(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob(["\uFEFF", text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
