import {getAddress, isAddress} from 'viem';

export class WalletSessionError extends Error {
  constructor(message) { super(message); this.name = 'WalletSessionError'; }
}

export function walletAccount(accounts) {
  const account = Array.isArray(accounts) ? accounts[0] : null;
  return typeof account === 'string' && isAddress(account, {strict: false}) ? getAddress(account) : null;
}

export function walletChain(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !/^0x[\da-f]+$/i.test(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function assertReceiptSuccess(receipt, replacementReason) {
  if (replacementReason && replacementReason !== 'repriced') {
    throw new Error(replacementReason === 'cancelled' ? 'Transaction cancelled in your wallet. The original action did not complete.' : 'Transaction replaced in your wallet. Refresh before trying the original action again.');
  }
  if (receipt.status !== 'success') throw new Error('Transaction reverted. Refresh the item and try again.');
}

export function walletErrorMessage(value) {
  const error = value && typeof value === 'object' ? value : {};
  let cause = error;
  for (let depth = 0; depth < 10 && cause && typeof cause === 'object'; depth++) {
    if (cause.code === 4001 || cause.code === '4001' || cause.name === 'UserRejectedRequestError') return 'You declined the wallet request.';
    if (cause.name === 'WalletSessionError' && typeof cause.message === 'string') return cause.message.slice(0, 240);
    cause = cause.cause;
  }
  const message = [error.shortMessage, error.message, typeof value === 'string' ? value : null].find(item => typeof item === 'string' && item.length);
  return (message || 'Something went wrong. Please retry.').slice(0, 240);
}
