import assert from "node:assert/strict";
import test from "node:test";
import { isNavItemActive, productById } from "../../config/nav.ts";

const item = (id: "pump" | "fi" | "pixel", label: string) => {
  const found = productById(id).items.find((candidate) => candidate.label === label);
  assert.ok(found, `${id}/${label}`);
  return found;
};

test("Pump Discover is active on the root and token pages only", () => {
  const discover = item("pump", "Discover");
  assert.equal(isNavItemActive("/0xPump", discover), true);
  assert.equal(isNavItemActive("/0xPump/", discover), true);
  assert.equal(isNavItemActive("/0xPump/token/0xabc", discover), true);
  assert.equal(isNavItemActive("/0xPump/nusd", discover), false);
  assert.equal(isNavItemActive("/0xPump/nusd", item("pump", "NUSD")), true);
});

test("Fi Swap covers /0xFi and /0xFi/swap; Pools covers detail pages; Earn covers farm", () => {
  assert.equal(isNavItemActive("/0xFi", item("fi", "Swap")), true);
  assert.equal(isNavItemActive("/0xFi/swap", item("fi", "Swap")), true);
  assert.equal(isNavItemActive("/0xFi/pools", item("fi", "Swap")), false);
  assert.equal(isNavItemActive("/0xFi/pools/0xa-0xb", item("fi", "Pools")), true);
  assert.equal(isNavItemActive("/0xFi/farm", item("fi", "Earn")), true);
  assert.equal(isNavItemActive("/0xFi/lending", item("fi", "Lend & Borrow")), false);
  assert.equal(isNavItemActive("/0xFi/lend", item("fi", "Lend & Borrow")), true);
  assert.equal(isNavItemActive("/0xFi/borrow", item("fi", "Lend & Borrow")), true);
});

test("Pixel Draw is exact; gallery and marketplace match their subtrees", () => {
  assert.equal(isNavItemActive("/0xpixel", item("pixel", "Draw")), true);
  assert.equal(isNavItemActive("/0xpixel/gallery", item("pixel", "Draw")), false);
  assert.equal(isNavItemActive("/0xpixel/marketplace/12", item("pixel", "Marketplace")), true);
  assert.equal(isNavItemActive(null, item("pixel", "Gallery")), false);
});
