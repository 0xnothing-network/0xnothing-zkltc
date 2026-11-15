import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionViewFor } from "../../src/core/platform/env.ts";

test("each extension page is told apart by its address", () => {
  assert.equal(extensionViewFor("", ""), "popup");
  assert.equal(extensionViewFor("", "#/"), "popup");
  assert.equal(extensionViewFor("", "#/settings"), "popup");
  assert.equal(extensionViewFor("?surface=panel", "#/"), "panel");
  assert.equal(extensionViewFor("?surface=panel", "#/dapps"), "panel");
  assert.equal(extensionViewFor("?surface=tab", ""), "tab");
  assert.equal(extensionViewFor("", "#/approve?id=abc"), "approval");
});

test("the approval route wins over any surface and an unknown surface is the popup", () => {
  assert.equal(extensionViewFor("?surface=panel", "#/approve?id=abc"), "approval");
  assert.equal(extensionViewFor("?surface=tab", "#/approve"), "approval");
  assert.equal(extensionViewFor("?surface=window", ""), "popup");
  assert.equal(extensionViewFor("?surface=", ""), "popup");
  assert.equal(extensionViewFor("?other=panel", ""), "popup");
});
