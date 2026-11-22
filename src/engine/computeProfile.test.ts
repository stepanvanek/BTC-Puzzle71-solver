import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  canChangeComputeProfile,
  computeNextDispatchKeys,
  createIncrementalBasePointCursor,
  getComputeProfileConfig,
  getCpuThreadsForProfile,
  packFieldCoordinateLE,
} from './computeProfile.ts';

test('Max profile preserves full dual-slot WebGPU timing and 100% CPU thread allocation', () => {
  const cfg = getComputeProfileConfig('max', 8);
  assert.equal(cfg.profile, 'max');
  assert.equal(cfg.pipelineDepth, 2);
  assert.equal(cfg.minDispatchMs, 40);
  assert.equal(cfg.targetDispatchMs, 160);
  assert.equal(cfg.maxDispatchMs, 380);
  assert.equal(cfg.cpuThreads, 8);
  assert.equal(cfg.cpuSliceKeysPerWorker, 8_192);
  assert.equal(cfg.yieldEveryDispatch, false);
  assert.equal(getCpuThreadsForProfile('max', 16), 16);
});

test('Smooth profile preserves near-Max throughput with single-slot ~75ms GPU budget and minimal CPU trim', () => {
  const cfg = getComputeProfileConfig('smooth', 8);
  assert.equal(cfg.profile, 'smooth');
  assert.equal(cfg.pipelineDepth, 1);
  assert.equal(cfg.minDispatchMs, 25);
  assert.equal(cfg.targetDispatchMs, 75);
  assert.equal(cfg.maxDispatchMs, 120);
  assert.equal(cfg.cpuThreads, 7);
  assert.equal(cfg.cpuSliceKeysPerWorker, 6_144);
  assert.equal(cfg.yieldEveryDispatch, true);

  assert.equal(getCpuThreadsForProfile('smooth', 1), 1);
  assert.equal(getCpuThreadsForProfile('smooth', 2), 2);
  assert.equal(getCpuThreadsForProfile('smooth', 4), 4);
  assert.equal(getCpuThreadsForProfile('smooth', 7), 7);
  assert.equal(getCpuThreadsForProfile('smooth', 8), 7);
  assert.equal(getCpuThreadsForProfile('smooth', 16), 15);
});

test('canChangeComputeProfile locks switching while scanning or starting and unlocks when paused', () => {
  assert.equal(canChangeComputeProfile(false, false), true);
  assert.equal(canChangeComputeProfile(true, false), false);
  assert.equal(canChangeComputeProfile(false, true), false);
  assert.equal(canChangeComputeProfile(true, true), false);
});

test('computeNextDispatchKeys scales smoothly including sub-unit mobile slices without overshooting', () => {
  const smoothCfg = getComputeProfileConfig('smooth', 8);

  // Slow phone GPU takes 150ms (> 120ms) on 32,896 keys -> must halve below unitSlice (32,896)
  const shrunk = computeNextDispatchKeys({
    currentKeys: 32_896,
    lastChecked: 32_896,
    unsubmittedKeys: 1_000_000,
    gpuSpanMs: 150,
    minSlice: 64,
    unitSlice: 32_896,
    maxSlice: 16_777_216,
    config: smoothCfg,
  });
  assert.equal(shrunk, 16_448);

  // When sub-unit slice (8,192 keys) runs faster than target (40ms < 75ms), grow gradually, not by +32,896
  const gentlyGrown = computeNextDispatchKeys({
    currentKeys: 8_192,
    lastChecked: 8_192,
    unsubmittedKeys: 1_000_000,
    gpuSpanMs: 40,
    minSlice: 64,
    unitSlice: 32_896,
    maxSlice: 16_777_216,
    config: smoothCfg,
  });
  assert.equal(gentlyGrown, 10_240);

  // Max mode scales fast when GPU is well below minDispatchMs (20ms < 40ms)
  const maxCfg = getComputeProfileConfig('max', 8);
  const maxFastGrow = computeNextDispatchKeys({
    currentKeys: 526_336,
    lastChecked: 526_336,
    unsubmittedKeys: 10_000_000,
    gpuSpanMs: 20,
    minSlice: 64,
    unitSlice: 32_896,
    maxSlice: 16_777_216,
    config: maxCfg,
  });
  assert.equal(maxFastGrow, 1_052_672);
});

test('Incremental EC point cursor matches direct secp256k1 scalar multiplication across steps and jumps', () => {
  const cursor = createIncrementalBasePointCursor();
  const base = 0x400000000000123400n;
  const keysToTest = [
    base,
    base + 526_336n,
    base + 526_336n * 2n,
    base + 526_336n * 3n + 32_896n,
    base + 1_000_000_000n, // jump to new block
    base + 1_000_000_000n + 65_792n,
  ];

  for (const k of keysToTest) {
    const derived = cursor.deriveAffine(k);
    const expected = secp256k1.Point.BASE.multiply(k).toAffine();
    assert.deepEqual(derived.xBytes, packFieldCoordinateLE(expected.x));
    assert.deepEqual(derived.yBytes, packFieldCoordinateLE(expected.y));
  }
});
