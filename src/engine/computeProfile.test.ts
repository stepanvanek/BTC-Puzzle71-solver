import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
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

test('Smooth profile uses single-slot ~18ms WebGPU budget and leaves spare CPU cores for UI', () => {
  const cfg = getComputeProfileConfig('smooth', 8);
  assert.equal(cfg.profile, 'smooth');
  assert.equal(cfg.pipelineDepth, 1);
  assert.equal(cfg.minDispatchMs, 6);
  assert.equal(cfg.targetDispatchMs, 18);
  assert.equal(cfg.maxDispatchMs, 30);
  assert.equal(cfg.cpuThreads, 6);
  assert.equal(cfg.cpuSliceKeysPerWorker, 4_096);
  assert.equal(cfg.yieldEveryDispatch, true);

  assert.equal(getCpuThreadsForProfile('smooth', 1), 1);
  assert.equal(getCpuThreadsForProfile('smooth', 2), 1);
  assert.equal(getCpuThreadsForProfile('smooth', 4), 3);
  assert.equal(getCpuThreadsForProfile('smooth', 16), 14);
});

test('computeNextDispatchKeys scales smoothly including sub-unit mobile slices without overshooting', () => {
  const smoothCfg = getComputeProfileConfig('smooth', 8);

  // Slow phone GPU takes 75ms on 32,896 keys -> must halve below unitSlice (32,896)
  const shrunk = computeNextDispatchKeys({
    currentKeys: 32_896,
    lastChecked: 32_896,
    unsubmittedKeys: 1_000_000,
    gpuSpanMs: 75,
    minSlice: 64,
    unitSlice: 32_896,
    maxSlice: 16_777_216,
    config: smoothCfg,
  });
  assert.equal(shrunk, 16_448);

  // When sub-unit slice (8,192 keys) runs slightly fast (10ms < 18ms), grow gradually, not by +32,896
  const gentlyGrown = computeNextDispatchKeys({
    currentKeys: 8_192,
    lastChecked: 8_192,
    unsubmittedKeys: 1_000_000,
    gpuSpanMs: 10,
    minSlice: 64,
    unitSlice: 32_896,
    maxSlice: 16_777_216,
    config: smoothCfg,
  });
  assert.equal(gentlyGrown, 10_240);

  // Desktop GPU hitting 12ms in smooth mode scales up gently by 1.25x / +unitSlice
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
