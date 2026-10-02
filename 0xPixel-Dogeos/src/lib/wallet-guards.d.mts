import type {Address} from 'viem';
export class WalletSessionError extends Error { constructor(message: string); }
export function walletAccount(accounts: unknown): Address | null;
export function walletChain(value: unknown): number | null;
export function assertReceiptSuccess(receipt: {status: string}, replacementReason: string | null): void;
export function walletErrorMessage(value: unknown): string;
