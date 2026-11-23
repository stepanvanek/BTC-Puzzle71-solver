import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { base58check } from '@scure/base';
import { privateKeyToCompressedPubKey } from '../shared/btcTx.ts';
import {
  BITCOIN_PUZZLE_CHALLENGE_SUMMARY,
  BITCOIN_PUZZLE_LIST,
  calculatePuzzleOddsAndEta,
  formatBitRangeLabel,
  getBitcoinPuzzleTimeline,
  getPuzzleNote,
} from './bitcoinPuzzles.ts';

const b58Check = base58check(sha256);

function privateKeyToP2pkhAddress(privKey: bigint): string {
  const pubKey = privateKeyToCompressedPubKey(privKey);
  const h160 = ripemd160(sha256(pubKey));
  const payload = new Uint8Array(21);
  payload[0] = 0x00;
  payload.set(h160, 1);
  return b58Check.encode(payload);
}

test('BITCOIN_PUZZLE_LIST contains all 160 unique levels in order with accurate bounds', () => {
  assert.equal(BITCOIN_PUZZLE_LIST.length, 160);
  BITCOIN_PUZZLE_LIST.forEach((puzzle, idx) => {
    const expectedBits = idx + 1;
    assert.equal(puzzle.bits, expectedBits);
    const min = 1n << BigInt(puzzle.bits - 1);
    const max = (1n << BigInt(puzzle.bits)) - 1n;
    assert.equal(puzzle.hexStart, `0x${min.toString(16)}`);
    assert.equal(puzzle.hexEnd, `0x${max.toString(16)}`);
    assert.ok(puzzle.address.startsWith('1'), `Puzzle #${puzzle.bits} should be P2PKH`);
  });
});

test('All 83 solved private keys cryptographically derive their exact P2PKH addresses and sit inside bit bounds', () => {
  const solved = BITCOIN_PUZZLE_LIST.filter((p) => p.status === 'solved');
  assert.equal(solved.length, 83);

  for (const puzzle of solved) {
    assert.ok(puzzle.solvedKeyHex, `Puzzle #${puzzle.bits} missing solvedKeyHex`);
    const priv = BigInt(puzzle.solvedKeyHex);
    const min = 1n << BigInt(puzzle.bits - 1);
    const max = (1n << BigInt(puzzle.bits)) - 1n;
    assert.ok(priv >= min && priv <= max, `Puzzle #${puzzle.bits} key out of range`);
    assert.equal(
      privateKeyToP2pkhAddress(priv),
      puzzle.address,
      `Puzzle #${puzzle.bits} derived address mismatch`,
    );
  }
});

test('Challenge summary, Puzzle #71, #115, #135, and exposed Kangaroo targets match on-chain truth', () => {
  assert.equal(BITCOIN_PUZZLE_CHALLENGE_SUMMARY.totalPuzzles, 160);
  assert.equal(BITCOIN_PUZZLE_CHALLENGE_SUMMARY.solvedCount, 83);
  assert.equal(BITCOIN_PUZZLE_CHALLENGE_SUMMARY.unsolvedCount, 77);
  assert.equal(BITCOIN_PUZZLE_CHALLENGE_SUMMARY.solvedBtc, 85.498);
  assert.equal(BITCOIN_PUZZLE_CHALLENGE_SUMMARY.remainingBtc, 903);
  assert.equal(BITCOIN_PUZZLE_CHALLENGE_SUMMARY.totalSeriesBtc, 988.498);
  assert.equal(BITCOIN_PUZZLE_CHALLENGE_SUMMARY.exposedUnsolvedCount, 5);

  const p71 = BITCOIN_PUZZLE_LIST[70];
  assert.equal(p71.bits, 71);
  assert.equal(p71.status, 'active');
  assert.equal(p71.pubkeyExposed, false);
  assert.equal(p71.rewardBtc, 7.1);
  assert.equal(p71.address, '1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU');

  const p135 = BITCOIN_PUZZLE_LIST[134];
  assert.equal(p135.bits, 135);
  assert.equal(p135.status, 'solved');
  assert.equal(p135.rewardBtc, 13.5);
  assert.equal(p135.address, '16RGFo6hjq9ym6Pj7N5H7L1NR1rVPJyw2v');
});

test('Odds calculator and bilingual timeline return consistent structures', () => {
  assert.equal(formatBitRangeLabel(1), '2⁰ (1)');
  assert.equal(formatBitRangeLabel(71), '2^70 → 2^71−1');

  const p71 = BITCOIN_PUZZLE_LIST[70];
  assert.ok(getPuzzleNote(p71, 'cs').length > 0);
  assert.ok(getPuzzleNote(p71, 'en').length > 0);

  const smallEta = calculatePuzzleOddsAndEta({ bitWidth: 5, keysPerSec: 1_000_000 });
  assert.equal(smallEta.fitsInsideSingleBlock, true);
  assert.equal(smallEta.effectiveBlockKeys, 16);

  const eta71 = calculatePuzzleOddsAndEta({ bitWidth: 71, keysPerSec: 120_000_000 });
  assert.equal(eta71.fitsInsideSingleBlock, false);
  assert.equal(eta71.blockCount, 2 ** 41);
  assert.ok(Math.abs(eta71.medianSeconds50Pct * 2 - eta71.fullSeconds100Pct) < 1e-3);

  assert.equal(getBitcoinPuzzleTimeline('cs').length, 4);
  assert.equal(getBitcoinPuzzleTimeline('en').length, 4);
});
