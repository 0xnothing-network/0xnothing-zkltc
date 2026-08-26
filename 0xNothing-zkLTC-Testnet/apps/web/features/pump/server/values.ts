import "server-only";

import { getAddress, type Address, type Hex } from "viem";
import { ZERO_ADDRESS } from "@/features/pump/config";

/**
 * Coercion helpers shared by the subgraph and RPC readers. Every value that
 * reaches the UI passes through one of these, so a malformed indexer field or a
 * failed contract read degrades to a safe default instead of rendering NaN.
 */

export const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

export function successfulBigInt(result: { status: string; result?: unknown }): bigint {
  return result.status === "success" && typeof result.result === "bigint" ? result.result : 0n;
}

export function successfulString(
  result: { status: string; result?: unknown },
  fallback: string,
): string {
  return result.status === "success" && typeof result.result === "string"
    ? result.result
    : fallback;
}

export function safeAddress(value: string): Address {
  try {
    return getAddress(value);
  } catch {
    return ZERO_ADDRESS;
  }
}

export function safeNumber(value: string | number | bigint): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function safeBigInt(value: string | number | bigint | undefined): bigint {
  try {
    const number = BigInt(value ?? 0);
    return number >= 0n ? number : 0n;
  } catch {
    return 0n;
  }
}

export function integerString(value: string): string {
  return /^\d+$/.test(value || "") ? value : "0";
}

export function decimalString(value: string): string {
  return /^\d+(?:\.\d+)?$/.test(value || "") ? value : "0";
}

export function decimalMax(left: string, right: string): string {
  return Number(right) > Number(left) ? right : left;
}

export function decimalMin(left: string, right: string): string {
  return Number(right) < Number(left) ? right : left;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function warningMessage(error: unknown, fallback: string): string {
  console.warn("[pump/data]", error);
  return fallback;
}

/**
 * Run `mapper` over `items` with at most `concurrency` in flight, writing each
 * result to its own index so the output keeps the input order.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await mapper(items[index]);
      }
    }),
  );
  return results;
}
