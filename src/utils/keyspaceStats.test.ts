import assert from 'node:assert/strict';
import test from 'node:test';
import { maskBtcAddress } from '../shared/btcAddress.ts';
import { BLOCK_SIZE, PUZZLE_71_TOTAL_KEYS } from '../shared/puzzle71.ts';
import {
  calculateKeyspaceProgressPercent,
  estimateFullKeyspaceSeconds,
  formatCalculatorDuration,
  formatCzechDurationFromSeconds,
  formatDurationFromSeconds,
  formatKeyspaceProgressPercent,
} from './keyspaceStats.ts';

test('maskBtcAddress reveals only prefix and suffix and hides middle characters across all address types', () => {
  const segwit = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const maskedSegwit = maskBtcAddress(segwit);
  assert.equal(maskedSegwit, 'bc1qw5…v8f3t4');
  assert.ok(!maskedSegwit.includes('qejxtdg4y5r3zarvary0c5xw7k'));

  const legacy = '1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU';
  const maskedLegacy = maskBtcAddress(legacy);
  assert.equal(maskedLegacy, '1PWo3J…fsVzXU');
  assert.ok(!maskedLegacy.includes('jrGwfHDNpdGK54CRas7'));

  const taproot = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
  const maskedTaproot = maskBtcAddress(taproot);
  assert.equal(maskedTaproot, 'bc1p5c…kedrcr');
  assert.ok(!maskedTaproot.includes('xmeuwuvkwfem96lqzszd02n6xdcjrs20cac6'));
});

test('calculateKeyspaceProgressPercent and formatKeyspaceProgressPercent handle 0, 1 block, and bounds cleanly in EN and CS', () => {
  assert.equal(calculateKeyspaceProgressPercent(0), 0);
  assert.equal(formatKeyspaceProgressPercent(0), '0%');
  assert.equal(formatKeyspaceProgressPercent(0, 'cs'), '0 %');

  // 1 block of 2^29 out of 2^70 is exactly 2^-41 * 100 ≈ 4.54747e-11 %
  const oneBlockPct = calculateKeyspaceProgressPercent(Number(BLOCK_SIZE));
  assert.ok(Math.abs(oneBlockPct - 4.547473508864641e-11) < 1e-18);
  assert.equal(formatKeyspaceProgressPercent(Number(BLOCK_SIZE), 'en'), '0.000000000045%');
  assert.equal(formatKeyspaceProgressPercent(Number(BLOCK_SIZE), 'cs'), '0,000000000045 %');

  // 8 585 216 keys -> 0.00000000000073%
  assert.equal(formatKeyspaceProgressPercent(8_585_216, 'en'), '0.00000000000073%');
  assert.equal(formatKeyspaceProgressPercent(8_585_216, 'cs'), '0,00000000000073 %');

  // Over-range inputs clamp cleanly at 100%
  assert.equal(calculateKeyspaceProgressPercent(PUZZLE_71_TOTAL_KEYS * 2n), 100);
  assert.equal(formatKeyspaceProgressPercent(PUZZLE_71_TOTAL_KEYS, 'en'), '100.00%');
  assert.equal(formatKeyspaceProgressPercent(PUZZLE_71_TOTAL_KEYS, 'cs'), '100,00 %');
});

test('estimateFullKeyspaceSeconds and formatDurationFromSeconds produce accurate time estimates in EN and CS', () => {
  assert.equal(estimateFullKeyspaceSeconds(0), null);
  assert.equal(estimateFullKeyspaceSeconds(-500), null);
  assert.equal(formatDurationFromSeconds(null, 'en'), '—');
  assert.equal(formatCzechDurationFromSeconds(null), '—');

  // At 3 MKeys/s: 2^70 / 3e6 ≈ 3.9353e14 s ≈ 12.47 M yr
  const secAt3M = estimateFullKeyspaceSeconds(3_000_000, 0);
  assert.ok(secAt3M !== null && secAt3M > 3.9e14 && secAt3M < 4.0e14);
  assert.equal(formatDurationFromSeconds(secAt3M, 'en'), '12.47 M yr');
  assert.equal(formatCzechDurationFromSeconds(secAt3M), '12,47 mil. let');

  // Median 50% time at 3 MKeys/s ≈ 6.24 M yr
  assert.equal(formatDurationFromSeconds(secAt3M! / 2, 'en'), '6.24 M yr');
  assert.equal(formatCzechDurationFromSeconds(secAt3M! / 2), '6,24 mil. let');

  // Short durations format cleanly
  assert.equal(formatDurationFromSeconds(45, 'en'), '45 s');
  assert.equal(formatDurationFromSeconds(300, 'en'), '5.0 min');
  assert.equal(formatDurationFromSeconds(7200, 'en'), '2.0 hr');
  assert.equal(formatCzechDurationFromSeconds(7200), '2,0 hod');
});

test('formatCalculatorDuration avoids scientific notation for millions through trillions of years', () => {
  const secPerYear = 365.25 * 86_400;

  assert.equal(formatCalculatorDuration(0, 'cs'), '∞');
  assert.equal(formatCalculatorDuration(0.4, 'cs'), '< 1 s');
  assert.equal(formatCalculatorDuration(4.47, 'cs'), '4,5 s');
  assert.equal(formatCalculatorDuration(6.24e6 * secPerYear, 'cs'), '6,24 mil. let');
  assert.equal(formatCalculatorDuration(6.24e6 * secPerYear, 'en'), '6.24 M yrs');
  assert.equal(formatCalculatorDuration(12.34e9 * secPerYear, 'cs'), '12,34 mld. let');
  assert.equal(formatCalculatorDuration(8.5e12 * secPerYear, 'cs'), '8,50 bil. let');
  assert.equal(formatCalculatorDuration(4.2e15 * secPerYear, 'cs'), '4,20 bld. let');
  assert.equal(formatCalculatorDuration(7.1e18 * secPerYear, 'cs'), '7,10 tril. let');
  assert.equal(formatCalculatorDuration(1.23e22 * secPerYear, 'cs'), '1,23e+22 let');
});
