import assert from "node:assert/strict";
import test from "node:test";
import {
  cooldownRemaining,
  dailyRemaining,
  formatCooldown,
  resolveFaucetClaim,
  utcDay,
} from "../../features/faucet/claimState.ts";

const funded = {
  configured: true,
  connected: true,
  wrongChain: false,
  submitting: false,
  pending: false,
  paused: false,
  now: 1_700_000_000,
  readyAt: 0,
  nativeDrip: 5n * 10n ** 16n,
  nusdDrip: 25n * 10n ** 18n,
  faucetNativeBalance: 10n ** 18n,
  faucetNusdBalance: 1_000n * 10n ** 18n,
  dailyNativeRemaining: 2n * 10n ** 18n,
  dailyNusdRemaining: 1_000n * 10n ** 18n,
};

test("utc day and remaining helpers reset at the unix day boundary", () => {
  assert.equal(utcDay(86_399), 0);
  assert.equal(utcDay(86_400), 1);
  assert.equal(dailyRemaining(5n, 10n, 1n, 1n), 5n);
  assert.equal(dailyRemaining(5n, 10n, 1n, 2n), 10n);
  assert.equal(dailyRemaining(10n, 10n, 1n, 1n), 0n);
  assert.equal(cooldownRemaining(100, 90), 10);
  assert.equal(cooldownRemaining(100, 100), 0);
  assert.equal(formatCooldown(3_661), "1h 1m");
  assert.equal(formatCooldown(65), "1m 5s");
  assert.equal(formatCooldown(9), "9s");
});

test("claim button stays gated until the wallet, cooldown, and inventory are ready", () => {
  assert.equal(resolveFaucetClaim({ ...funded, configured: false }).reason, "offline");
  assert.equal(resolveFaucetClaim({ ...funded, connected: false }).reason, "connect");
  assert.equal(resolveFaucetClaim({ ...funded, wrongChain: true }).reason, "wrong-chain");
  assert.equal(resolveFaucetClaim({ ...funded, pending: true }).reason, "loading");
  assert.equal(resolveFaucetClaim({ ...funded, paused: true }).reason, "paused");
  assert.deepEqual(resolveFaucetClaim({ ...funded, readyAt: funded.now + 65 }), {
    disabled: true,
    label: "Wait 1m 5s",
    reason: "cooldown",
    cooldownRemaining: 65,
  });
  assert.equal(resolveFaucetClaim({ ...funded, faucetNativeBalance: 0n }).reason, "empty");
  assert.equal(resolveFaucetClaim({ ...funded, dailyNusdRemaining: 0n }).reason, "daily-cap");
  assert.deepEqual(resolveFaucetClaim(funded), {
    disabled: false,
    label: "Claim testnet tokens",
    reason: "ready",
    cooldownRemaining: 0,
  });
});
