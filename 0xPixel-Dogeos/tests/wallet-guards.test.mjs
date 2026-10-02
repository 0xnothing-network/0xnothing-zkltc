import {test} from 'node:test';
import assert from 'node:assert/strict';
import {walletAccount, walletChain, assertReceiptSuccess, walletErrorMessage, WalletSessionError} from '../src/lib/wallet-guards.mjs';

test('Wallet responses reject malformed accounts and network identifiers', () => {
  for (const response of [null, {}, [], ['wrong'], [42], ['0x123']]) assert.equal(walletAccount(response), null);
  assert.equal(walletAccount(['0x1111111111111111111111111111111111111111']), '0x1111111111111111111111111111111111111111');
  for (const response of [null, {}, '', '6281971', '0xno', '0x0', -1, NaN, Infinity, 1.5, '0xffffffffffffffffffff']) assert.equal(walletChain(response), null);
  assert.equal(walletChain('0x5fdaf3'), 6281971);
  assert.equal(walletChain(6281971), 6281971);
});

test('Successful cancellation/replacement receipts cannot claim the NFT action succeeded', () => {
  assert.throws(() => assertReceiptSuccess({status: 'success'}, 'cancelled'), /cancelled/);
  assert.throws(() => assertReceiptSuccess({status: 'success'}, 'replaced'), /replaced/);
  assert.throws(() => assertReceiptSuccess({status: 'reverted'}, null), /reverted/);
  assert.doesNotThrow(() => assertReceiptSuccess({status: 'success'}, 'repriced'));
  assert.doesNotThrow(() => assertReceiptSuccess({status: 'success'}, null));
});

test('Error reporting survives non-Error rejections and nested/cyclic causes', () => {
  for (const value of [undefined, null, 3, true, {message: 123}, {shortMessage: {}}]) assert.equal(walletErrorMessage(value), 'Something went wrong. Please retry.');
  assert.equal(walletErrorMessage('Network offline'), 'Network offline');
  assert.equal(walletErrorMessage({cause: {cause: {code: '4001'}}}), 'You declined the wallet request.');
  const cyclic = {message: 'RPC unavailable'}; cyclic.cause = cyclic;
  assert.equal(walletErrorMessage(cyclic), 'RPC unavailable');
  assert.equal(walletErrorMessage({message: 'x'.repeat(1000)}).length, 240);
  assert.equal(walletErrorMessage({shortMessage:'An unknown RPC error occurred.',cause:{cause:new WalletSessionError('Wallet account or connection changed. Please try again.')}}), 'Wallet account or connection changed. Please try again.');
});
