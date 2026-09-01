import assert from "node:assert/strict";
import { test } from "node:test";
import { findApprovalWindowId } from "../../src/extension/approvalWindow.ts";

const route = "chrome-extension://wallet-id/index.html#/approve";

test("an approval popup survives service-worker restarts without being duplicated", () => {
  assert.equal(findApprovalWindowId([
    { id: 7, tabs: [{ url: `${route}?id=request-1` }] },
  ], route), 7);
  assert.equal(findApprovalWindowId([
    { id: 8, tabs: [{ pendingUrl: `${route}?id=request-2` }] },
  ], route), 8);
  assert.equal(findApprovalWindowId([
    {
      id: 10,
      tabs: [{ url: "about:blank", pendingUrl: `${route}?id=request-loading` }],
    },
  ], route), 10);
  assert.equal(findApprovalWindowId([
    { id: 9, tabs: [{ url: `${route}-lookalike?id=request-3` }] },
  ], route), undefined);
});
