import assert from "node:assert/strict";
import { test } from "node:test";
import { actionShortcut, shortcutLabel } from "../../src/ui/lib/shortcut.ts";

test("the shortcut line shows the key Chrome reports and nothing else", () => {
  assert.equal(shortcutLabel("Alt+Shift+W"), "Alt+Shift+W");
  assert.equal(shortcutLabel("⌥⇧W"), "⌥⇧W");
  assert.equal(shortcutLabel("Ctrl+Shift+0"), "Ctrl+Shift+0");
  assert.equal(shortcutLabel("<b>Alt</b>+W"), "bAltb+W");
  assert.equal(shortcutLabel("x".repeat(60))?.length, 32);
});

test("an unset or odd shortcut reads as none", () => {
  assert.equal(shortcutLabel(""), null);
  assert.equal(shortcutLabel("   "), null);
  assert.equal(shortcutLabel("<>"), null);
  assert.equal(shortcutLabel(undefined), null);
  assert.equal(shortcutLabel(42), null);
});

test("only the action command's shortcut is taken", () => {
  assert.equal(actionShortcut([]), null);
  assert.equal(actionShortcut([{ name: "other", shortcut: "Alt+O" }]), null);
  assert.equal(actionShortcut([{ name: "_execute_action", shortcut: "" }]), null);
  assert.equal(actionShortcut([
    { name: "other", shortcut: "Alt+O" },
    { name: "_execute_action", shortcut: "Alt+Shift+W" },
  ]), "Alt+Shift+W");
});
