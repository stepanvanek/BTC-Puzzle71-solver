import { bech32m } from '@scure/base';
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePayoutSplit, validateBitcoinAddress } from './btcAddress.ts';
import { buildAndSignPuzzle71Tx, privateKeyToHash160Hex } from './btcTx.ts';
import {
  ADMIN_PAYOUT_ADDRESS,
  BLOCK_SIZE,
  PUZZLE_71_ADDRESS,
  PUZZLE_71_HASH160_HEX,
  PUZZLE_71_MAX_KEY,
  PUZZLE_71_MIN_KEY,
  TOTAL_BLOCKS,
  blockIndexToRange,
} from './puzzle71.ts';

test('Puzzle #71 address decodes to exact canonical Hash160', () => {
  const parsed = validateBitcoinAddress(PUZZLE_71_ADDRESS);
  assert.equal(parsed.valid, true);
  assert.ok(parsed.parsed);
  assert.equal(parsed.parsed.type, 'P2PKH (Legacy)');
  const hexProg = Buffer.from(parsed.parsed.program).toString('hex');
  assert.equal(hexProg, PUZZLE_71_HASH160_HEX);
});

test('Admin address validates as Bech32 SegWit v0 P2WSH', () => {
  const res = validateBitcoinAddress(ADMIN_PAYOUT_ADDRESS);
  assert.equal(res.valid, true);
  assert.ok(res.parsed);
  assert.equal(res.parsed.type, 'P2WSH (SegWit v0)');
  assert.equal(res.parsed.encoding, 'Bech32');
  assert.equal(res.parsed.witnessVersion, 0);
  assert.equal(res.parsed.program.length, 32);
  assert.equal(res.parsed.scriptPubKey.length, 34);
});

test('Validates ALL Bitcoin mainnet address versions (P2PKH, P2SH, P2WPKH, P2WSH, P2TR, future v2+)', () => {
  const futureV16Bech32m = bech32m.encode('bc', [16, ...bech32m.toWords(new Uint8Array([0x75, 0x1e]))]);
  const validAddresses = [
    // P2PKH
    { addr: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', expectedType: 'P2PKH (Legacy)' },
    // P2SH
    { addr: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', expectedType: 'P2SH (Script Hash)' },
    // P2WPKH (SegWit v0)
    { addr: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', expectedType: 'P2WPKH (SegWit v0)' },
    // P2WSH (SegWit v0)
    { addr: ADMIN_PAYOUT_ADDRESS, expectedType: 'P2WSH (SegWit v0)' },
    // P2TR (Taproot v1)
    {
      addr: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
      expectedType: 'P2TR (Taproot v1)',
    },
    // Future SegWit v2 Bech32m witness program (BIP-350 test vector)
    {
      addr: 'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs',
      expectedType: 'SegWit v2 (Bech32m)',
    },
    // Future SegWit v16 Bech32m witness program
    {
      addr: futureV16Bech32m,
      expectedType: 'SegWit v16 (Bech32m)',
    },
  ];

  for (const item of validAddresses) {
    const res = validateBitcoinAddress(item.addr);
    assert.equal(res.valid, true, `Expected valid for ${item.addr}: ${res.error}`);
    assert.equal(res.parsed?.type, item.expectedType);
  }
});

test('Rejects invalid checksums, testnet addresses, mixed case, and BIP-350 mismatches', () => {
  const invalidAddresses = [
    '',
    'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', // testnet bech32
    'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', // testnet p2pkh
    '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', // bad Base58 checksum
    'Bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', // mixed case Bech32
    'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrc0', // bad Bech32m checksum
    'bc1sw50qa3jx3s', // v16 encoded with deprecated Bech32 instead of Bech32m (BIP-350 forbids)
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7k', // invalid v0 length
  ];

  for (const addr of invalidAddresses) {
    const res = validateBitcoinAddress(addr);
    assert.equal(res.valid, false, `Expected invalid for "${addr}"`);
    assert.ok(res.error && res.error.length > 0);
  }
});

test('Fee-before-split 85% / 15% payout calculation conserves every satoshi', () => {
  const totalSats = 710_018_229n; // ~7.10 BTC
  const feeSats = 3_500n;
  const split = calculatePayoutSplit(totalSats, feeSats);

  assert.equal(split.netSats, totalSats - feeSats);
  assert.equal(split.userSats + split.adminSats + split.feeSats, totalSats);
  // 85% exact check
  assert.equal(split.userSats, (split.netSats * 85n) / 100n);
  assert.equal(split.adminSats, split.netSats - split.userSats);
});

test('Keyspace block math clamps strictly within [2^70, 2^71 - 1]', () => {
  const first = blockIndexToRange(0n);
  assert.equal(first.startKey, PUZZLE_71_MIN_KEY);
  assert.equal(first.endKey, PUZZLE_71_MIN_KEY + BLOCK_SIZE - 1n);

  const last = blockIndexToRange(TOTAL_BLOCKS - 1n);
  assert.equal(last.endKey, PUZZLE_71_MAX_KEY);
  assert.throws(() => blockIndexToRange(TOTAL_BLOCKS));
  assert.throws(() => blockIndexToRange(-1n));
});

test('Builds and signs real 85/15 P2PKH raw transaction for any user address version', () => {
  // Known deterministic test private key (within 2^70..2^71-1 for testing tx construction)
  const testPrivKey = 0x4123456789abcdef01n;
  const hash160Hex = privateKeyToHash160Hex(testPrivKey);
  assert.equal(hash160Hex.length, 40);

  const userTaprootAddr = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
  const result = buildAndSignPuzzle71Tx({
    privateKey: testPrivKey,
    utxo: {
      txid: 'a'.repeat(64),
      vout: 0,
      valueSats: 710_000_000n,
    },
    userAddress: userTaprootAddr,
    feeRateSatPerVb: 15,
  });

  assert.equal(result.signatureVerified, true);
  assert.equal(result.txid.length, 64);
  assert.ok(result.txHex.startsWith('0200000001'));
  assert.equal(result.userSats + result.adminSats + result.feeSats, 710_000_000n);
  assert.equal(result.userAddressType, 'P2TR (Taproot v1)');
});

test('Sweeps multiple economical Puzzle #71 UTXOs while skipping uneconomical dust', () => {
  const testPrivKey = 0x4123456789abcdef01n;
  const result = buildAndSignPuzzle71Tx({
    privateKey: testPrivKey,
    utxos: [
      { txid: '1'.repeat(64), vout: 5, valueSats: 639_000_000n },
      { txid: '2'.repeat(64), vout: 19, valueSats: 63_900_000n },
      { txid: '3'.repeat(64), vout: 70, valueSats: 7_100_000n },
      { txid: '4'.repeat(64), vout: 0, valueSats: 546n }, // dust at 24 sat/vB (148 * 24 = 3552)
    ],
    userAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    feeRateSatPerVb: 24,
  });

  assert.equal(result.signatureVerified, true);
  assert.equal(result.inputCount, 3);
  assert.equal(result.totalInputSats, 710_000_000n);
  assert.equal(result.userSats + result.adminSats + result.feeSats, 710_000_000n);
});
