import assert from "node:assert/strict";
import { test } from "node:test";
import { LITVM_CHAIN_ID, LITVM_CHAIN_ID_HEX } from "../../src/config/chain.ts";
import {
  isBoundedRpcCall,
  isContentMessage,
  isPageMessage,
  MAX_PROVIDER_CALL_BYTES,
  newProviderUuid,
  PROVIDER_CHAIN_ID_HEX,
  PROVIDER_RDNS,
  readProviderState,
  sameAccounts,
  TO_CONTENT,
  TO_PAGE,
} from "../../src/extension/protocol.ts";

/**
 * The provider's chain id is a literal in protocol.ts because the page-world
 * bundle may not import config/chain.ts — viem would come with it. That makes
 * this the only thing standing between the two copies and a wallet that
 * announces the wrong chain to every dapp.
 */
test("provider chain id matches the configured chain", () => {
  assert.equal(PROVIDER_CHAIN_ID_HEX, LITVM_CHAIN_ID_HEX);
  assert.equal(Number.parseInt(PROVIDER_CHAIN_ID_HEX, 16), LITVM_CHAIN_ID);
});

test("rdns is a reversed domain, as EIP-6963 requires", () => {
  assert.match(PROVIDER_RDNS, /^[a-z]+(\.[a-z0-9-]+)+$/u);
});

test("page messages are only accepted with a channel, id and method", () => {
  assert.equal(
    isPageMessage({ channel: TO_CONTENT, id: "1", call: { method: "eth_chainId" } }),
    true,
  );
  assert.equal(isPageMessage({ channel: TO_PAGE, id: "1", call: { method: "eth_chainId" } }), false);
  assert.equal(isPageMessage({ channel: TO_CONTENT, call: { method: "eth_chainId" } }), false);
  assert.equal(isPageMessage({ channel: TO_CONTENT, id: "1" }), false);
  assert.equal(isPageMessage(null), false);
  assert.equal(isPageMessage("eth_chainId"), false);
  assert.equal(isPageMessage({ channel: TO_CONTENT, id: "", call: { method: "eth_chainId" } }), false);
  assert.equal(
    isPageMessage({ channel: TO_CONTENT, id: "x".repeat(129), call: { method: "eth_chainId" } }),
    false,
  );
  assert.equal(
    isPageMessage({ channel: TO_CONTENT, id: "1", call: { method: "eth_call", params: {} } }),
    false,
  );
});

test("provider calls are bounded before crossing into the worker", () => {
  assert.equal(isBoundedRpcCall({ method: "eth_call", params: [{ data: "0x1234" }, "latest"] }), true);
  assert.equal(isBoundedRpcCall({ method: "" }), false);
  assert.equal(isBoundedRpcCall({ method: "x".repeat(129), params: [] }), false);
  assert.equal(isBoundedRpcCall({ method: "eth_call", params: ["x".repeat(MAX_PROVIDER_CALL_BYTES)] }), false);

  let deep: unknown = null;
  for (let index = 0; index < 66; index += 1) deep = [deep];
  assert.equal(isBoundedRpcCall({ method: "eth_call", params: [deep] }), false);

  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  assert.equal(isBoundedRpcCall({ method: "eth_call", params: cyclic }), false);

  const hostile = Object.defineProperty({}, "method", {
    enumerable: true,
    get: () => {
      throw new Error("getter should fail closed");
    },
  });
  assert.doesNotThrow(() => isBoundedRpcCall(hostile));
  assert.equal(isBoundedRpcCall(hostile), false);
});

test("content messages carry results and events on their own channel", () => {
  assert.equal(isContentMessage({ channel: TO_PAGE, id: "1", result: "0x1159" }), true);
  assert.equal(
    isContentMessage({ channel: TO_PAGE, state: { chainId: "0x1159", accounts: [] } }),
    true,
  );
  assert.equal(isContentMessage({ channel: TO_CONTENT, id: "1" }), false);
  assert.equal(isContentMessage(undefined), false);
});

test("provider identity is a valid UUID", () => {
  const uuid = newProviderUuid();
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});

// The pulled state is all a page provider applies after a ping; anything that is
// not a chain id and a short list of addresses is dropped.
test("a pulled provider state is applied only in its exact shape", () => {
  const account = `0x${"aB".repeat(20)}`;
  assert.deepEqual(readProviderState({ chainId: "0x1159", accounts: [account] }), { chainId: "0x1159", accounts: [account] });
  assert.deepEqual(readProviderState({ chainId: "0x1159", accounts: [], origins: ["https://x.example"] }), { chainId: "0x1159", accounts: [] });
  assert.equal(readProviderState(null), null);
  assert.equal(readProviderState({ chainId: "4441", accounts: [] }), null);
  assert.equal(readProviderState({ chainId: "0x1159" }), null);
  // A site without a connection is sent its accounts only.
  assert.deepEqual(readProviderState({ accounts: [] }), { accounts: [] });
  assert.equal("chainId" in (readProviderState({ accounts: [] }) ?? {}), false);
  assert.equal(readProviderState({ chainId: 4441, accounts: [] }), null);
  assert.equal(readProviderState({ chainId: null, accounts: [] }), null);
  assert.equal(readProviderState({ chainId: "0x1159", accounts: ["0x12"] }), null);
  assert.equal(readProviderState({ chainId: "0x1159", accounts: Array(9).fill(account) }), null);
  assert.equal(sameAccounts([account], [account.toLowerCase()]), true);
  assert.equal(sameAccounts([account], []), false);
  assert.equal(sameAccounts([], []), true);
});
