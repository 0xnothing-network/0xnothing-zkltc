import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { csvCell, historyCsv, historyFileName } from "../../src/ui/lib/historyCsv.ts";

/** F13: History as CSV, safe to open in a spreadsheet. */

test("a cell that starts like a formula is defused with an apostrophe", () => {
  for (const start of ["=", "+", "-", "@", "\t", "\r"]) {
    assert.equal(csvCell(`${start}HYPERLINK("x")`), `"'${start}HYPERLINK(""x"")"`);
  }
  // Only the first character matters; a minus inside a cell stays as it is.
  assert.equal(csvCell("Sent 1-2 NUSD"), '"Sent 1-2 NUSD"');
  assert.equal(csvCell(""), '""');
});

test("quotes are doubled and commas or line breaks stay inside one quoted cell", () => {
  assert.equal(csvCell('say "hi", then\nleave'), '"say ""hi"", then\nleave"');
  assert.equal(
    historyCsv(["Date", "Kind"], [["2026-11-15T00:00:00.000Z", "Send, fast"], ["x", "=1+1"]]),
    '"Date","Kind"\r\n"2026-11-15T00:00:00.000Z","Send, fast"\r\n"x","\'=1+1"\r\n',
  );
});

test("the file is named by chain and UTC day", () => {
  assert.equal(historyFileName(4441, Date.UTC(2026, 10, 5, 23, 59)), "0xwallet-history-4441-20261105.csv");
});

test("History offers the export in the extension only, from the rows on screen", () => {
  const source = readFileSync(new URL("../../src/ui/screens/History.tsx", import.meta.url), "utf8");
  assert.match(source, /\{isExtension \? \(\s*<Button[^>]*onClick=\{exportCsv\}/u);
  assert.match(source, /rows\.map\(\(row\) => \{/u);
  assert.match(source, /downloadCsv\(historyFileName\(network\.chainId, now\), text\)/u);
});
