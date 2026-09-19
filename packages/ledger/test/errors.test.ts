import { encodeErrorResult, stringToHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { isLedgerError, ledgerError, mapRevert, mapRpcError } from '../src/index.js';

const errorAbi = [{ type: 'error', name: 'Error', inputs: [{ name: 'reason', type: 'string' }] }] as const;
const panicAbi = [{ type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] }] as const;

describe('mapRevert', () => {
  it('maps Error(string) containing "blocklist"/"denylist"/"blacklist" to BLOCKLISTED', () => {
    for (const reason of [
      'USDC: address blocklisted',
      'Denylist: recipient denied',
      'account is blacklisted',
    ]) {
      const data = encodeErrorResult({ abi: errorAbi, errorName: 'Error', args: [reason] });
      expect(mapRevert(data, {}).code).toBe('BLOCKLISTED');
    }
  });
  it('maps insufficient balance/allowance reasons', () => {
    const data = encodeErrorResult({
      abi: errorAbi,
      errorName: 'Error',
      args: ['ERC20: transfer amount exceeds balance'],
    });
    expect(mapRevert(data, {}).code).toBe('INSUFFICIENT_BALANCE');
  });
  it('maps zero-address recipient before decoding', () => {
    expect(mapRevert(undefined, { recipient: '0x0000000000000000000000000000000000000000' }).code).toBe(
      'ZERO_ADDRESS',
    );
  });
  it('maps empty revert data with a blocklist hint to BLOCKLISTED, otherwise TX_REVERTED', () => {
    expect(mapRevert('0x', { blocklistedHint: true }).code).toBe('BLOCKLISTED');
    expect(mapRevert('0x', {}).code).toBe('TX_REVERTED');
    expect(mapRevert(undefined, {}).code).toBe('TX_REVERTED');
  });
  it('maps Panic(uint256) to TX_REVERTED with detail and never throws on garbage', () => {
    const data = encodeErrorResult({ abi: panicAbi, errorName: 'Panic', args: [0x11n] });
    expect(mapRevert(data, {}).code).toBe('TX_REVERTED');
    expect(mapRevert('0xdeadbeef', {}).code).toBe('TX_REVERTED');
    expect(mapRevert(stringToHex('junk'), {}).code).toBe('TX_REVERTED');
  });
  it('every error has a non-empty human message and nextStep', () => {
    const e = mapRevert('0x', {});
    expect(e.message.length).toBeGreaterThan(10);
    expect(e.nextStep.length).toBeGreaterThan(10);
  });
});

describe('mapRpcError', () => {
  it('maps HTTP 429 to RPC_RATE_LIMITED', () => {
    expect(mapRpcError({ status: 429, message: 'Too Many Requests' }).code).toBe('RPC_RATE_LIMITED');
    expect(mapRpcError(new Error('HTTP request failed. Status: 429')).code).toBe('RPC_RATE_LIMITED');
  });
  it('maps code 4444 pruned history', () => {
    expect(mapRpcError({ code: 4444, message: 'pruned history unavailable' }).code).toBe(
      'RPC_HISTORY_UNAVAILABLE',
    );
  });
  it('maps -32602 max range to RPC_RANGE_TOO_LARGE', () => {
    expect(mapRpcError({ code: -32602, message: 'request exceeded max allowed range' }).code).toBe(
      'RPC_RANGE_TOO_LARGE',
    );
  });
  it('maps -32003 with many rows to GAS_CAP_EXCEEDED, and with few rows to TX_REVERTED (false-positive guard)', () => {
    expect(mapRpcError({ code: -32003, message: 'out of gas' }, { chunkRows: 80 }).code).toBe(
      'GAS_CAP_EXCEEDED',
    );
    expect(mapRpcError({ code: -32003, message: 'out of gas' }, { chunkRows: 1 }).code).toBe('TX_REVERTED');
  });
  it('maps Cloudflare 1010 / 403 to RPC_FORBIDDEN', () => {
    expect(mapRpcError(new Error('HTTP request failed. Status: 403 error code: 1010')).code).toBe(
      'RPC_FORBIDDEN',
    );
  });
  it('unknown errors become UNKNOWN with the original message in detail', () => {
    const e = mapRpcError(new Error('weird'));
    expect(e.code).toBe('UNKNOWN');
    expect(String(e.detail)).toContain('weird');
  });
  it('isLedgerError recognises shape', () => {
    expect(isLedgerError(ledgerError('UNKNOWN'))).toBe(true);
    expect(isLedgerError({ code: 'X' })).toBe(false);
  });
});
