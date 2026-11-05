import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const PAGE = read("../../app/docs/page.tsx");

/** Each prompt the docs page embeds, and the repository prompts file it is copied from. */
const PROMPT_SOURCES = {
  FI_SWAP_PROMPT: "0xfi.md",
  PUMP_TRADE_PROMPT: "0xpump.md",
  NUSD_MINT_PROMPT: "nusd.md",
  PIXEL_MINT_PROMPT: "0xpixel.md",
} as const;

/** Top-level `const NAME_PROMPT = `...`;` template literals, unescaped to the text the page shows. */
function embeddedPrompts(source: string) {
  const prompts = new Map<string, string>();
  for (const [, name, raw] of source.matchAll(/^const (\w+_PROMPT) = `((?:\\[\s\S]|[^`\\])*)`;$/gm)) {
    assert.doesNotMatch(raw, /(?<!\\)\$\{/, `${name} must be plain text, not an interpolated template`);
    prompts.set(name, raw.replace(/\\([\s\S])/g, "$1"));
  }
  return prompts;
}

/** Bodies of the ```text fences in a prompts file. */
function fencedPrompts(markdown: string) {
  return [...markdown.matchAll(/^```text\n([\s\S]*?)\n```$/gm)].map(([, body]) => body);
}

const prompts = embeddedPrompts(PAGE);

test("the docs page embeds exactly one prompt per product", () => {
  assert.deepEqual([...prompts.keys()].sort(), Object.keys(PROMPT_SOURCES).sort());
});

for (const [name, file] of Object.entries(PROMPT_SOURCES)) {
  test(`${name} is copied verbatim from docs/developers/prompts/${file}`, () => {
    const prompt = prompts.get(name);
    assert.ok(prompt, `${name} is missing from app/docs/page.tsx`);
    const markdown = read(`../../../../docs/developers/prompts/${file}`);
    const firstLine = prompt.split("\n")[0];
    const source = fencedPrompts(markdown).find((body) => body.split("\n")[0] === firstLine);
    assert.ok(source, `no prompt in prompts/${file} starts with: ${firstLine}`);
    assert.equal(prompt, source);
    assert.ok(markdown.includes(prompt));
  });

  test(`${name} is rendered as a prompt code block`, () => {
    assert.match(PAGE, new RegExp(`prompt: ${name} \\}`));
  });
}

test("vibe-code prompts render with the prompt language", () => {
  assert.match(PAGE, /<DocsCodeBlock code=\{entry\.prompt\} label=\{entry\.label\} language="prompt" \/>/);
});
