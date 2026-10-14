import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type * as LiveEvents from "../../lib/liveEvents.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const testnet = JSON.parse(readFileSync(new URL("../../features/fi/config/testnet.generated.json", import.meta.url), "utf8"));
const PIXEL_CLASSIC = "0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988";
const PIXEL = "0xd83cb7acef921f98b6b983cbb712a583869da9eb";
const ACCOUNT = "0x00000000000000000000000000000000000000Aa";
const TOKEN = "0x1111111111111111111111111111111111111111";

const live = evaluateModule<typeof LiveEvents>(new URL("../../lib/liveEvents.ts", import.meta.url), {
  "@fi/config/testnet.generated.json": { default: testnet },
  "./publicConfig": { PIXEL_CLASSIC_ADDRESS: PIXEL_CLASSIC, PIXEL_NFT_ADDRESS: PIXEL },
});

function fakeTimers() {
  let now = 0;
  let nextId = 0;
  const timeouts = new Map<number, { at: number; callback: () => void }>();
  const intervals = new Map<number, { every: number; callback: () => void }>();
  const timers: LiveEvents.Timers = {
    now: () => now,
    setTimeout: (callback, ms) => { timeouts.set(++nextId, { at: now + ms, callback }); return nextId; },
    clearTimeout: (id) => { timeouts.delete(id as number); },
    setInterval: (callback, every) => { intervals.set(++nextId, { every, callback }); return nextId; },
    clearInterval: (id) => { intervals.delete(id as number); },
  };
  return {
    timers,
    timeouts,
    intervals,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timeouts].filter(([, entry]) => entry.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timeouts.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the watch list covers every deployed protocol contract and both 0xPixel collections", () => {
  const watched = live.STATIC_LIVE_ADDRESSES;
  assert.ok(watched.includes(testnet.nusd.toLowerCase()));
  assert.ok(watched.includes(testnet.pump.toLowerCase()));
  assert.ok(watched.includes(testnet.rewardStaking.toLowerCase()));
  assert.ok(watched.includes(testnet.nusdMarketplace.toLowerCase()));
  assert.ok(watched.includes(PIXEL_CLASSIC.toLowerCase()));
  assert.ok(watched.includes(PIXEL));
  assert.equal(new Set(watched).size, watched.length);
  assert.ok(watched.every((address) => address === address.toLowerCase()));
});

test("views add the contracts they read; account balances are not contracts", () => {
  const keys = [
    ["readContract", { address: TOKEN, functionName: "balanceOf", args: [ACCOUNT] }],
    ["readContracts", { contracts: [{ address: TOKEN.replace("1111", "2222"), functionName: "getReserves" }] }],
    ["balance", { address: ACCOUNT, chainId: 4441 }],
    ["pump-market", TOKEN.replace("1111", "3333")],
  ];
  const watched = live.liveWatchAddresses(keys);
  assert.ok(watched.includes(TOKEN));
  assert.ok(watched.includes(TOKEN.replace("1111", "2222")));
  assert.equal(watched.includes(ACCOUNT.toLowerCase()), false);
  assert.equal(watched.includes(TOKEN.replace("1111", "3333")), false);
  assert.deepEqual([...watched], [...watched].sort());
});

test("the watch list is bounded however many contracts a page reads", () => {
  const keys = Array.from({ length: 1_000 }, (_, index) => ["readContract", { address: `0x${index.toString(16).padStart(40, "0")}`, functionName: "balanceOf" }]);
  assert.equal(live.liveWatchAddresses(keys).length, 256);
});

test("refresh waves fire at once, throttle bursts, and follow up after the last event", () => {
  const clock = fakeTimers();
  let runs = 0;
  const waves = live.createWaveScheduler(() => { runs += 1; }, { minGapMs: 1_500, followUpMs: 2_500 }, clock.timers);
  waves.trigger();
  assert.equal(runs, 1);
  clock.advance(100);
  waves.trigger();
  waves.trigger();
  assert.equal(runs, 1);
  clock.advance(1_400);
  assert.equal(runs, 2);
  clock.advance(1_099);
  assert.equal(runs, 2);
  clock.advance(1);
  assert.equal(runs, 3, "the follow-up runs 2.5 s after the last event");
  clock.advance(10_000);
  assert.equal(runs, 3);
  waves.trigger();
  waves.dispose();
  clock.advance(10_000);
  assert.equal(runs, 4);
});

function fakeSocket() {
  const listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  const sent: Array<{ id: number; method: string; params: unknown[] }> = [];
  let closed = false;
  const socket: LiveEvents.SocketLike = {
    send: (data) => { sent.push(JSON.parse(data)); },
    close: () => { closed = true; },
    addEventListener: (type, listener) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
  };
  const emit = (type: string, data?: unknown) => { for (const listener of listeners.get(type) ?? []) listener({ data }); };
  return {
    socket,
    sent,
    get closed() { return closed; },
    open: () => emit("open"),
    reply: (id: number, result: unknown) => emit("message", JSON.stringify({ jsonrpc: "2.0", id, result })),
    notify: (subscription: string, result: unknown) => emit("message", JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription, result } })),
    drop: () => emit("close"),
  };
}

test("the socket client subscribes after open, routes notifications, and fails subscriptions on close", async () => {
  const clock = fakeTimers();
  const fake = fakeSocket();
  const transport = live.openLiveTransport("wss://rpc.test", () => fake.socket, clock.timers);
  const received: unknown[] = [];
  const errors: unknown[] = [];
  const subscribing = transport.subscribe({ params: ["logs", { address: [TOKEN] }], onData: (data) => received.push(data), onError: (error) => errors.push(error) });
  await settle();
  assert.equal(fake.sent.length, 0);
  fake.open();
  await settle();
  assert.equal(fake.sent[0]?.method, "eth_subscribe");
  assert.deepEqual(fake.sent[0]?.params, ["logs", { address: [TOKEN] }]);
  fake.reply(fake.sent[0]!.id, "0xsub");
  await subscribing;
  fake.notify("0xsub", { address: TOKEN });
  fake.notify("0xother", { address: ACCOUNT });
  assert.equal(received.length, 1);
  fake.drop();
  assert.equal(errors.length, 1);
  assert.equal(fake.closed, true);
});

test("a socket that stops answering keep-alives fails instead of hanging", async () => {
  const clock = fakeTimers();
  const fake = fakeSocket();
  const transport = live.openLiveTransport("wss://rpc.test", () => fake.socket, clock.timers);
  const errors: unknown[] = [];
  const subscribing = transport.subscribe({ params: ["logs", { address: [TOKEN] }], onData: () => undefined, onError: (error) => errors.push(error) });
  fake.open();
  await settle();
  fake.reply(fake.sent[0]!.id, "0xsub");
  await subscribing;
  for (const interval of clock.intervals.values()) interval.callback();
  await settle();
  assert.equal(fake.sent.at(-1)?.method, "net_version");
  clock.advance(10_000);
  assert.equal(errors.length, 1);
  assert.equal(fake.closed, true);
});

function fakeTransports() {
  const opened: Array<{ url: string; filters: unknown[]; closed: boolean; fail: () => void; unsubscribed: number; reject?: boolean }> = [];
  const open = (url: string): LiveEvents.LiveTransport => {
    const handle = { url, filters: [] as unknown[], closed: false, unsubscribed: 0, errorHandlers: [] as Array<(error: unknown) => void>, fail: () => undefined as void };
    handle.fail = () => { for (const onError of handle.errorHandlers) onError(new Error("dropped")); };
    opened.push(handle);
    return {
      async subscribe({ params, onError }) {
        handle.filters.push(params[1]);
        handle.errorHandlers.push(onError);
        return { unsubscribe: async () => { handle.unsubscribed += 1; } };
      },
      close: () => { handle.closed = true; },
    };
  };
  return { opened, open };
}

test("the session subscribes to watched contracts and to transfers in and out of the account", async () => {
  const clock = fakeTimers();
  const { opened, open } = fakeTransports();
  const statuses: boolean[] = [];
  let events = 0;
  const session = live.startLiveSocket({ urls: ["wss://a", "wss://b"], onEvent: () => { events += 1; }, onStatus: (value) => statuses.push(value), open, timers: clock.timers });
  session.setAccount(ACCOUNT as `0x${string}`);
  await settle();
  await settle();
  assert.deepEqual(statuses, [true]);
  assert.equal(events, 1, "a (re)connect refreshes once because missed events are not replayed");
  const filters = opened[0]!.filters as Array<{ address?: string[]; topics?: unknown[] }>;
  assert.ok(filters.some((filter) => filter.address?.includes(testnet.pump.toLowerCase())));
  const topic = `0x${"0".repeat(24)}${ACCOUNT.slice(2).toLowerCase()}`;
  assert.ok(filters.some((filter) => JSON.stringify(filter.topics) === JSON.stringify([live.TRANSFER_TOPIC, topic])));
  assert.ok(filters.some((filter) => JSON.stringify(filter.topics) === JSON.stringify([live.TRANSFER_TOPIC, null, topic])));
  session.dispose();
  assert.equal(opened[0]!.closed, true);
  assert.deepEqual(statuses, [true, false]);
});

test("a dropped socket reconnects with backoff, alternating endpoints, and resubscribes", async () => {
  const clock = fakeTimers();
  const { opened, open } = fakeTransports();
  const statuses: boolean[] = [];
  const session = live.startLiveSocket({ urls: ["wss://a", "wss://b"], onEvent: () => undefined, onStatus: (value) => statuses.push(value), open, timers: clock.timers });
  await settle();
  opened[0]!.fail();
  assert.deepEqual(statuses, [true, false]);
  assert.equal(opened[0]!.closed, true);
  clock.advance(999);
  assert.equal(opened.length, 1);
  clock.advance(1);
  await settle();
  assert.equal(opened.length, 2);
  assert.equal(opened[1]!.url, "wss://b", "a dropped connection retries on the other endpoint");
  assert.deepEqual(statuses, [true, false, true]);
  session.setAddresses([TOKEN]);
  await settle();
  assert.equal(JSON.stringify(opened[1]!.filters.at(-1)), JSON.stringify({ address: [TOKEN] }));
  assert.equal(opened[1]!.unsubscribed, 1);
  session.dispose();
});

test("failed connects back off exponentially and wake() retries immediately", async () => {
  const clock = fakeTimers();
  const urls: string[] = [];
  const session = live.startLiveSocket({
    urls: ["wss://a", "wss://b"],
    onEvent: () => undefined,
    onStatus: () => undefined,
    open: (url) => {
      urls.push(url);
      return { subscribe: async () => { throw new Error("refused"); }, close: () => undefined };
    },
    timers: clock.timers,
  });
  await settle();
  clock.advance(1_000);
  await settle();
  clock.advance(2_000);
  await settle();
  assert.deepEqual(urls, ["wss://a", "wss://b", "wss://a"]);
  session.wake();
  await settle();
  assert.equal(urls.length, 4);
  session.dispose();
  clock.advance(60_000);
  await settle();
  assert.equal(urls.length, 4);
});
