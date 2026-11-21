import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendSpeedSample,
  computeSpeedStats,
  formatKeysRate,
  selectRateScale,
} from './speedHistory.ts';

test('appendSpeedSample throttles rapid updates, ignores invalid rates, and caps rolling history length', () => {
  let history = appendSpeedSample([], -10, 1000);
  assert.equal(history.length, 0);

  history = appendSpeedSample(history, 2_500_000, 10_000, 5, 950);
  assert.equal(history.length, 1);

  // Within minIntervalMs -> skipped
  history = appendSpeedSample(history, 2_600_000, 10_500, 5, 950);
  assert.equal(history.length, 1);

  // Add 6 more samples spaced by 1s -> capped to 5 newest samples
  for (let i = 1; i <= 6; i++) {
    history = appendSpeedSample(history, 2_500_000 + i * 100_000, 10_000 + i * 1000, 5, 950);
  }
  assert.equal(history.length, 5);
  assert.equal(history[0].rateKps, 2_700_000);
  assert.equal(history[4].rateKps, 3_100_000);
});

test('selectRateScale and formatKeysRate pick clean Keys/s, kKeys/s, and MKeys/s tiers', () => {
  assert.deepEqual(selectRateScale(500), { divisor: 1, unitLabel: 'Keys/s', decimals: 0 });
  assert.deepEqual(selectRateScale(185_000), { divisor: 1_000, unitLabel: 'kKeys/s', decimals: 2 });
  assert.deepEqual(selectRateScale(3_450_000), { divisor: 1_000_000, unitLabel: 'MKeys/s', decimals: 2 });

  assert.equal(formatKeysRate(0), '0 Keys/s');
  assert.equal(formatKeysRate(420), '420 Keys/s');
  assert.equal(formatKeysRate(172_500), '172.50 kKeys/s');
  assert.equal(formatKeysRate(3_500_000), '3.50 MKeys/s');
});

test('computeSpeedStats calculates min, avg, max, and stability percentage accurately', () => {
  const emptyStats = computeSpeedStats([]);
  assert.equal(emptyStats.avgKps, 0);
  assert.equal(emptyStats.stabilityPct, null);

  // Perfectly steady stream -> 100% stability
  const steady = [
    { timestamp: 1000, timeLabel: '00:00:01', rateKps: 3_000_000 },
    { timestamp: 2000, timeLabel: '00:00:02', rateKps: 3_000_000 },
    { timestamp: 3000, timeLabel: '00:00:03', rateKps: 3_000_000 },
  ];
  const steadyStats = computeSpeedStats(steady);
  assert.equal(steadyStats.minKps, 3_000_000);
  assert.equal(steadyStats.avgKps, 3_000_000);
  assert.equal(steadyStats.maxKps, 3_000_000);
  assert.equal(steadyStats.stabilityPct, 100);

  // Fluctuating stream -> lower stability percentage
  const jittery = [
    { timestamp: 1000, timeLabel: '00:00:01', rateKps: 1_000_000 },
    { timestamp: 2000, timeLabel: '00:00:02', rateKps: 3_000_000 },
  ];
  const jitterStats = computeSpeedStats(jittery);
  assert.equal(jitterStats.avgKps, 2_000_000);
  assert.equal(jitterStats.stabilityPct, 50);
});
