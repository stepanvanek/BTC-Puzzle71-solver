import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { validateBitcoinAddress } from '../shared/btcAddress.ts';
import { buildAndSignPuzzle71Tx, privateKeyToHash160Hex } from '../shared/btcTx.ts';
import { partitionWebGpuDispatch } from './computeEngine.ts';
import { scanCpuBatch } from './cpuWorker.ts';
import {
  ADMIN_PAYOUT_ADDRESS,
  BLOCK_SIZE,
  BLOCK_SIZE_BITS,
  DEMO_PUZZLE_5_ADDRESS,
  DEMO_PUZZLE_5_HASH160_HEX,
  DEMO_PUZZLE_5_MIN_KEY,
  DEMO_PUZZLE_5_TOTAL_KEYS,
  DEMO_PUZZLE_5_UTXO_SATS,
  MAX_BATCH_LEASE_BLOCKS,
  MIN_POW_SHARES_FULL_BLOCK,
  TOTAL_BLOCKS,
  blockIndexToPercent,
  blockIndexToRange,
  getRecommendedBatchBlockCount,
  getRequiredPowShares,
  percentToBlockIndex,
} from '../shared/puzzle71.ts';
import {
  BATCH_HALF,
  BATCH_KEYS,
  KG_TABLE_BYTES,
  MAX_POW_HITS,
  OFFSET_TABLE_BITS,
  OUTPUT_BYTES,
  PARAMS_BYTES,
  SECP256K1_HASH160_WGSL,
  TABLE_BYTES,
  buildKgTableBytes,
  buildOffsetTableBytes,
  packU256LEBytes,
} from './secp256k1.wgsl.ts';

function bytesLEToBigInt(bytes: Uint8Array, byteOffset = 0): bigint {
  let out = 0n;
  for (let i = 31; i >= 0; i--) {
    out = (out << 8n) | BigInt(bytes[byteOffset + i]);
  }
  return out;
}

test('Compute batch scanner finds exact private key across affine and Montgomery batch boundaries', () => {
  const startKey = 0x400000000000001000n;
  for (const offset of [0n, 37n, 63n, 64n, 65n, 128n, 129n, 140n, 290n]) {
    const winningKey = startKey + offset;
    const targetHashHex = privateKeyToHash160Hex(winningKey);
    const targetBytes = Uint8Array.from(Buffer.from(targetHashHex, 'hex'));

    const result = scanCpuBatch(startKey, 320, targetBytes);
    assert.equal(result.foundKey, winningKey);
    assert.equal(result.checked, Number(offset) + 1);
  }

  // Small start keys (< CPU_BATCH_SPAN) safely fall back to projective scanner
  const smallStart = 7n;
  const smallTarget = Uint8Array.from(Buffer.from(privateKeyToHash160Hex(12n), 'hex'));
  const smallRes = scanCpuBatch(smallStart, 20, smallTarget);
  assert.equal(smallRes.foundKey, 12n);
  assert.equal(smallRes.checked, 6);
});

test('Compute batch scanner returns null when key is outside batch range', () => {
  const startKey = 0x400000000000002000n;
  const targetHashHex = privateKeyToHash160Hex(0x400000000000003000n);
  const targetBytes = Uint8Array.from(Buffer.from(targetHashHex, 'hex'));

  const result = scanCpuBatch(startKey, 300, targetBytes);
  assert.equal(result.foundKey, null);
  assert.equal(result.checked, 300);
  assert.equal(Array.isArray(result.powKeys), true);
});

test('WGSL precomputed kgTableBytes and offsetTableBytes match secp256k1 generator multiples and layout sizes', () => {
  assert.equal(PARAMS_BYTES, 9752);
  assert.equal(MAX_POW_HITS, 16);
  assert.equal(OUTPUT_BYTES, 264);

  const kgBytes = buildKgTableBytes();
  assert.equal(kgBytes.byteLength, KG_TABLE_BYTES);

  const g128 = secp256k1.Point.BASE.multiply(BigInt(BATCH_HALF)).toAffine();
  assert.deepEqual(
    kgBytes.slice((BATCH_HALF - 1) * 64, (BATCH_HALF - 1) * 64 + 32),
    packU256LEBytes(g128.x),
  );
  assert.deepEqual(
    kgBytes.slice((BATCH_HALF - 1) * 64 + 32, (BATCH_HALF - 1) * 64 + 64),
    packU256LEBytes(g128.y),
  );

  const g257 = secp256k1.Point.BASE.multiply(BigInt(BATCH_KEYS)).toAffine();
  assert.deepEqual(
    kgBytes.slice(BATCH_HALF * 64, BATCH_HALF * 64 + 32),
    packU256LEBytes(g257.x),
  );

  const keysPerThread = 514;
  const offsetBytes = buildOffsetTableBytes(keysPerThread);
  assert.equal(offsetBytes.byteLength, TABLE_BYTES);
  assert.equal(offsetBytes.byteLength, OFFSET_TABLE_BITS * 64);

  const b15 = secp256k1.Point.BASE.multiply((1n << 15n) * BigInt(keysPerThread)).toAffine();
  assert.deepEqual(offsetBytes.slice(15 * 64, 15 * 64 + 32), packU256LEBytes(b15.x));
  assert.deepEqual(offsetBytes.slice(15 * 64 + 32, 15 * 64 + 64), packU256LEBytes(b15.y));
});

test('Symmetric 257-key batch indexing covers [0, 513] without gaps or duplicates and preserves EC point symmetry', () => {
  const seen = new Set<number>();
  const numBatches = 2;
  for (let batch = 0; batch < numBatches; batch++) {
    const stepBase = batch * BATCH_KEYS;
    seen.add(stepBase + BATCH_HALF);
    for (let rev = 0; rev < BATCH_HALF; rev++) {
      const i = BATCH_HALF - 1 - rev;
      seen.add(stepBase + BATCH_HALF + 1 + i);
      seen.add(stepBase + BATCH_HALF - 1 - i);
    }
  }
  assert.equal(seen.size, numBatches * BATCH_KEYS);
  for (let s = 0; s < numBatches * BATCH_KEYS; s++) {
    assert.equal(seen.has(s), true, `Missing offset ${s}`);
  }

  // Verify symmetric EC identity P - k*G uses (-kgTable[i].y) mod p with same X
  const kgBytes = buildKgTableBytes();
  const startKey = 0x400000000000000100n;
  const centerKey = startKey + 3n * 514n + BigInt(BATCH_HALF + BATCH_KEYS); // batch 1 center = 385
  const centerPt = secp256k1.Point.BASE.multiply(centerKey);
  const targetStepPt = secp256k1.Point.BASE.multiply(centerKey - 85n).toAffine(); // offset 300
  const gx85 = bytesLEToBigInt(kgBytes, 84 * 64);
  const gy85 = bytesLEToBigInt(kgBytes, 84 * 64 + 32);
  const pMod = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  const negPt85 = secp256k1.Point.fromAffine({ x: gx85, y: pMod - gy85 });
  const reconstructed = centerPt.add(negPt85).toAffine();
  assert.equal(reconstructed.x, targetStepPt.x);
  assert.equal(reconstructed.y, targetStepPt.y);
});

test('partitionWebGpuDispatch respects remaining block bounds and scales workgroups via Math.ceil without stalling', () => {
  const fullBlock = partitionWebGpuDispatch(16_777_216, 16_777_216);
  assert.ok(fullBlock);
  assert.equal(fullBlock.keysPerThread, 514);
  assert.equal(fullBlock.workgroups, 510);
  assert.equal(fullBlock.checked, 510 * 64 * 514);
  assert.ok(fullBlock.checked <= 16_777_216);

  // Small 1.25x growth from 1 workgroup (32,896 -> 41,120) must immediately jump to 2 workgroups (65,792)
  const growStep = partitionWebGpuDispatch(16_777_216, 41_120);
  assert.ok(growStep);
  assert.equal(growStep.workgroups, 2);
  assert.equal(growStep.keysPerThread, 514);
  assert.equal(growStep.checked, 2 * 32_896);

  const calibrated = partitionWebGpuDispatch(16_777_216, 1_500_000);
  assert.ok(calibrated);
  assert.equal(calibrated.keysPerThread, 514);
  assert.equal(calibrated.workgroups, Math.ceil(1_500_000 / 32_896));
  assert.ok(calibrated.checked <= 16_777_216);

  const tail256 = partitionWebGpuDispatch(256, 1_500_000);
  assert.ok(tail256);
  assert.equal(tail256.workgroups, 1);
  assert.equal(tail256.keysPerThread, 4);
  assert.equal(tail256.checked, 256);

  const tinyTail = partitionWebGpuDispatch(63, 1_500_000);
  assert.equal(tinyTail, null);
});

test('WGSL shader uses krackpot high-occupancy layout without uniform arrays, inner atomicLoad, or early hit return', () => {
  assert.equal(SECP256K1_HASH160_WGSL.includes('var<uniform>'), false);
  assert.equal(SECP256K1_HASH160_WGSL.includes('atomicLoad'), false);
  assert.match(SECP256K1_HASH160_WGSL, /@binding\(0\)\s+var<storage,\s*read>\s+params:\s*SearchParams/);
  assert.match(SECP256K1_HASH160_WGSL, /@binding\(1\)\s+var<storage,\s*read_write>\s+result:\s*SearchOutput/);
  assert.equal(SECP256K1_HASH160_WGSL.includes('@compute @workgroup_size(64)\nfn search('), true);
  assert.equal(SECP256K1_HASH160_WGSL.includes('fn fp_inv(a: U256) -> U256'), true);
  assert.equal(SECP256K1_HASH160_WGSL.includes('fn sha256_pubkey33('), true);
  assert.equal(SECP256K1_HASH160_WGSL.includes('fn ripemd160_sha32('), true);
  assert.equal(SECP256K1_HASH160_WGSL.includes('pow_count: atomic<u32>'), true);
  assert.equal(SECP256K1_HASH160_WGSL.includes('pow_results: array<FoundKey,'), true);
  assert.equal(SECP256K1_HASH160_WGSL.includes('select(gy,'), false);
});

test('Puzzle #71 2^29 block sizing, PoW threshold, and percentage mapping stay consistent', () => {
  assert.equal(BLOCK_SIZE_BITS, 29n);
  assert.equal(BLOCK_SIZE, 536_870_912n);
  assert.equal(TOTAL_BLOCKS, 1n << 41n);
  assert.equal(getRequiredPowShares(Number(BLOCK_SIZE)), MIN_POW_SHARES_FULL_BLOCK);
  assert.equal(getRequiredPowShares(16_777_216), 1);

  assert.equal(percentToBlockIndex(0), 0n);
  assert.equal(percentToBlockIndex(50), TOTAL_BLOCKS / 2n);
  assert.equal(percentToBlockIndex(100), TOTAL_BLOCKS - 1n);

  const midRange = blockIndexToRange(percentToBlockIndex(50));
  assert.equal(midRange.startKeyHex, '0x600000000000000000');
  assert.equal(blockIndexToPercent(midRange.blockIndex), 50);

  assert.equal(getRecommendedBatchBlockCount(0), 1);
  assert.equal(getRecommendedBatchBlockCount(3_000_000), 1);
  assert.equal(getRecommendedBatchBlockCount(6_500_000), 2);
  assert.equal(getRecommendedBatchBlockCount(14_000_000), 4);
  assert.equal(getRecommendedBatchBlockCount(35_000_000), MAX_BATCH_LEASE_BLOCKS);
});

test('Demo Puzzle #5 real scan finds key 0x15 and signs valid 85/15 demo transaction', () => {
  const addrCheck = validateBitcoinAddress(DEMO_PUZZLE_5_ADDRESS);
  assert.equal(addrCheck.valid, true);

  const targetBytes = Uint8Array.from(Buffer.from(DEMO_PUZZLE_5_HASH160_HEX, 'hex'));
  const scan = scanCpuBatch(DEMO_PUZZLE_5_MIN_KEY, DEMO_PUZZLE_5_TOTAL_KEYS, targetBytes);
  assert.equal(scan.foundKey, 0x15n);

  const tx = buildAndSignPuzzle71Tx({
    privateKey: scan.foundKey!,
    utxos: [{ txid: '5'.repeat(64), vout: 0, valueSats: DEMO_PUZZLE_5_UTXO_SATS }],
    userAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    adminAddress: ADMIN_PAYOUT_ADDRESS,
    feeRateSatPerVb: 12,
  });
  assert.equal(tx.signatureVerified, true);
  assert.equal(tx.pubKeyHash160Hex, DEMO_PUZZLE_5_HASH160_HEX);
  assert.equal(tx.userSats + tx.adminSats + tx.feeSats, DEMO_PUZZLE_5_UTXO_SATS);
});
