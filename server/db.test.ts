import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateKeyToHash160Hex } from '../src/shared/btcTx.ts';
import { BLOCK_SIZE, percentToBlockIndex } from '../src/shared/puzzle71.ts';
import { Puzzle71Store } from './db.ts';

function findPowOffsetsInRange(
  startKeyHex: string,
  hexPrefix: string,
  needed: number,
  maxScan = 8000,
): number[] {
  const startKey = BigInt(startKeyHex);
  const found: number[] = [];
  for (let offset = 0; offset < maxScan; offset++) {
    if (privateKeyToHash160Hex(startKey + BigInt(offset)).startsWith(hexPrefix)) {
      found.push(offset);
      if (found.length >= needed) break;
    }
  }
  return found;
}

test('Per-user session leasing blocks fake PoW completions and verifies authentic PoW shares', () => {
  // Use '00' prefix (1/256 hit rate) with 3 required shares so real cryptographic PoW can be mined quickly in unit tests
  const store = new Puzzle71Store(':memory:', {
    powHexPrefix: '00',
    minPowSharesFullBlock: 3,
  });

  const session = store.createOrGetSession(
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    'P2WPKH (SegWit v0)',
  );
  assert.ok(session.share_token.length >= 6);

  // Returning the same BTC address returns the same share_token
  const sameSession = store.createOrGetSession(
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    'P2WPKH (SegWit v0)',
  );
  assert.equal(sameSession.share_token, session.share_token);

  // Device A leases a 2^29 block
  const blockA = store.leaseUniqueBlock({
    shareToken: session.share_token,
    deviceId: 'device-A',
    deviceLabel: 'Desktop GPU',
    computeMode: 'webgpu',
    gpuName: 'Mock GPU A',
  });
  assert.equal(blockA.totalKeys, Number(BLOCK_SIZE));

  // Device B leases a block on the SAME user's URL
  const blockB = store.leaseUniqueBlock({
    shareToken: session.share_token,
    deviceId: 'device-B',
    deviceLabel: 'Laptop CPU',
    computeMode: 'cpu',
    gpuName: 'CPU Fallback',
  });

  assert.notEqual(blockA.blockIndex, blockB.blockIndex);
  assert.notEqual(blockA.id, blockB.id);

  // Spoofed checkpoint above 60% without any PoW shares gets capped at 60%
  store.checkpointBlock({
    shareToken: session.share_token,
    blockId: blockA.id,
    deviceId: 'device-A',
    progressOffset: Number(BLOCK_SIZE) - 10,
    rateKps: 3_000_000,
  });

  const resumedCapped = store.leaseUniqueBlock({
    shareToken: session.share_token,
    deviceId: 'device-A',
    deviceLabel: 'Desktop GPU',
    computeMode: 'webgpu',
    gpuName: 'Mock GPU A',
  });
  assert.equal(resumedCapped.id, blockA.id);
  assert.equal(resumedCapped.progressOffset, Math.floor(Number(BLOCK_SIZE) * 0.6));

  // Attempting to complete block A without PoW shares MUST be rejected
  assert.throws(
    () =>
      store.completeBlock({
        shareToken: session.share_token,
        blockId: blockA.id,
        deviceId: 'device-A',
        rateKps: 3_000_000,
      }),
    /PoW podílů/,
  );

  // Submitting fabricated offsets (that do not match Hash160 prefix) MUST also be rejected
  assert.throws(
    () =>
      store.checkpointBlock({
        shareToken: session.share_token,
        blockId: blockA.id,
        deviceId: 'device-A',
        progressOffset: Number(BLOCK_SIZE) - 100,
        rateKps: 3_000_000,
        powOffsets: [0, 1, 2],
      }),
    /Hash160 PoW nesouhlasí/,
  );

  // Mine 3 genuine PoW offsets inside blockA and complete the block
  const validPow = findPowOffsetsInRange(blockA.startKeyHex, '00', 3);
  assert.equal(validPow.length, 3);

  store.completeBlock({
    shareToken: session.share_token,
    blockId: blockA.id,
    deviceId: 'device-A',
    rateKps: 3_100_000,
    powOffsets: validPow,
  });

  const nextA = store.leaseUniqueBlock({
    shareToken: session.share_token,
    deviceId: 'device-A',
    deviceLabel: 'Desktop GPU',
    computeMode: 'webgpu',
    gpuName: 'Mock GPU A',
  });
  assert.notEqual(nextA.blockIndex, blockA.blockIndex);
  assert.notEqual(nextA.blockIndex, blockB.blockIndex);

  const summary = store.getSessionSummary(session.share_token);
  assert.ok(summary);
  assert.equal(summary.stats.completedBlocksCount, 1);
  assert.equal(summary.stats.activeLeasedCount, 2);
  assert.equal(summary.stats.blockSizeKeys, Number(BLOCK_SIZE));
  assert.equal(summary.devices.length, 2);

  store.close();
});

test('Sequential block mode starts at chosen percentage, increments monotonically, and caps active leases', () => {
  const store = new Puzzle71Store(':memory:', {
    powHexPrefix: '00',
    minPowSharesFullBlock: 2,
  });
  const session = store.createOrGetSession(
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    'P2WPKH (SegWit v0)',
  );

  const midIdx = percentToBlockIndex(50);
  const updated = store.updateSessionStrategy({
    shareToken: session.share_token,
    blockMode: 'sequential',
    startPercent: 50,
  });
  assert.equal(updated.strategy.blockMode, 'sequential');
  assert.equal(updated.strategy.seqCursor, midIdx.toString());
  assert.equal(updated.strategy.seqPercent, 50);

  const seq0 = store.leaseUniqueBlock({
    shareToken: session.share_token,
    deviceId: 'dev-0',
    deviceLabel: 'GPU 0',
    computeMode: 'webgpu',
    gpuName: 'GPU',
  });
  assert.equal(seq0.blockIndex, midIdx.toString());
  assert.equal(seq0.startKeyHex, '0x600000000000000000');

  // Complete first block and then pre-occupy midIdx + 1 with another device so cursor skips it cleanly
  const pow0 = findPowOffsetsInRange(seq0.startKeyHex, '00', 2);
  store.completeBlock({
    shareToken: session.share_token,
    blockId: seq0.id,
    deviceId: 'dev-0',
    rateKps: 3_000_000,
    powOffsets: pow0,
  });

  const seq1 = store.leaseUniqueBlock({
    shareToken: session.share_token,
    deviceId: 'dev-1',
    deviceLabel: 'GPU 1',
    computeMode: 'webgpu',
    gpuName: 'GPU',
  });
  assert.equal(seq1.blockIndex, (midIdx + 1n).toString());

  // Switching strategy from an unstarted 0-progress lease releases that lease cleanly
  store.updateSessionStrategy({
    shareToken: session.share_token,
    blockMode: 'sequential',
    startPercent: 25,
    deviceId: 'dev-1',
  });
  const quarterIdx = percentToBlockIndex(25);
  const seqQuarter = store.leaseUniqueBlock({
    shareToken: session.share_token,
    deviceId: 'dev-1',
    deviceLabel: 'GPU 1',
    computeMode: 'webgpu',
    gpuName: 'GPU',
  });
  assert.equal(seqQuarter.blockIndex, quarterIdx.toString());

  // Active lease cap (32) prevents unbounded DB row creation with fake device IDs
  for (let i = 1; i < 32; i++) {
    store.leaseUniqueBlock({
      shareToken: session.share_token,
      deviceId: `spam-dev-${i}`,
      deviceLabel: `Dev ${i}`,
      computeMode: 'cpu',
      gpuName: 'CPU',
    });
  }
  assert.throws(
    () =>
      store.leaseUniqueBlock({
        shareToken: session.share_token,
        deviceId: 'spam-dev-overflow',
        deviceLabel: 'Overflow',
        computeMode: 'cpu',
        gpuName: 'CPU',
      }),
    /dosažen limit 32/,
  );

  // Heartbeat keep-alive keeps paused lease owned by the same device and detects reclaimed/other device
  const hbOk = store.heartbeatBlock({
    shareToken: session.share_token,
    blockId: seqQuarter.id,
    deviceId: 'dev-1',
  });
  assert.equal(hbOk.active, true);
  assert.equal(hbOk.status, 'leased');

  const hbOther = store.heartbeatBlock({
    shareToken: session.share_token,
    blockId: seqQuarter.id,
    deviceId: 'other-device',
  });
  assert.equal(hbOther.active, false);
  assert.equal(hbOther.status, 'reclaimed');

  store.close();
});

test('Store automatically recovers when SQLite database file is malformed', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puzzle71-db-test-'));
  const dbPath = path.join(tmpDir, 'corrupt.db');
  fs.writeFileSync(dbPath, Buffer.from('NOT_A_VALID_SQLITE_HEADER_0123456789'));

  const store = new Puzzle71Store(dbPath);
  const session = store.createOrGetSession(
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    'P2WPKH (SegWit v0)',
  );
  assert.ok(session.share_token.length >= 6);
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Multi-block batch leasing scales by GPU speed, stays contiguous, resumes full queue, and clamps to headroom', () => {
  const store = new Puzzle71Store(':memory:', {
    powHexPrefix: '00',
    minPowSharesFullBlock: 2,
  });
  const session = store.createOrGetSession(
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    'P2WPKH (SegWit v0)',
  );

  // Random mode at 14 MKeys/s should allocate 4 contiguous blocks
  const randomBatch = store.leaseBlockBatch({
    shareToken: session.share_token,
    deviceId: 'fast-gpu-random',
    deviceLabel: 'RTX 4090',
    computeMode: 'webgpu',
    gpuName: 'NVIDIA RTX 4090',
    rateKps: 14_000_000,
  });
  assert.equal(randomBatch.length, 4);
  for (let i = 1; i < randomBatch.length; i++) {
    const prevIdx = BigInt(randomBatch[i - 1].blockIndex);
    const currIdx = BigInt(randomBatch[i].blockIndex);
    assert.equal(currIdx, prevIdx + 1n);
  }

  // Reconnecting the same device resumes all 4 blocks in original order
  const resumedRandom = store.leaseBlockBatch({
    shareToken: session.share_token,
    deviceId: 'fast-gpu-random',
    deviceLabel: 'RTX 4090',
    computeMode: 'webgpu',
    gpuName: 'NVIDIA RTX 4090',
    rateKps: 14_000_000,
  });
  assert.deepEqual(
    resumedRandom.map((b) => b.id),
    randomBatch.map((b) => b.id),
  );

  // Switching strategy cleans all unstarted 0-progress queued blocks for that device
  store.updateSessionStrategy({
    shareToken: session.share_token,
    blockMode: 'sequential',
    startPercent: 50,
    deviceId: 'fast-gpu-random',
  });
  const midIdx = percentToBlockIndex(50);

  // Sequential mode at 30 MKeys/s should allocate 8 contiguous blocks starting at midIdx and advance cursor by 8
  const seqBatch = store.leaseBlockBatch({
    shareToken: session.share_token,
    deviceId: 'fast-gpu-random',
    deviceLabel: 'RTX 4090',
    computeMode: 'webgpu',
    gpuName: 'NVIDIA RTX 4090',
    rateKps: 30_000_000,
  });
  assert.equal(seqBatch.length, 8);
  assert.equal(seqBatch[0].blockIndex, midIdx.toString());
  assert.equal(seqBatch[7].blockIndex, (midIdx + 7n).toString());

  const afterBatchSummary = store.getSessionSummary(session.share_token);
  assert.ok(afterBatchSummary);
  assert.equal(afterBatchSummary.strategy.seqCursor, (midIdx + 8n).toString());

  // Checkpoint on first block also keeps queued batch blocks fresh; complete first block and verify cursor continuity
  store.checkpointBlock({
    shareToken: session.share_token,
    blockId: seqBatch[0].id,
    deviceId: 'fast-gpu-random',
    progressOffset: 1000,
    rateKps: 30_000_000,
  });
  const pow0 = findPowOffsetsInRange(seqBatch[0].startKeyHex, '00', 2);
  store.completeBlock({
    shareToken: session.share_token,
    blockId: seqBatch[0].id,
    deviceId: 'fast-gpu-random',
    rateKps: 30_000_000,
    powOffsets: pow0,
  });

  // 7 leased remain for fast-gpu-random. Fill up to 29 active leases, leaving headroom of 3 out of 32
  for (let i = 0; i < 22; i++) {
    store.leaseBlockBatch({
      shareToken: session.share_token,
      deviceId: `filler-${i}`,
      deviceLabel: `Filler ${i}`,
      computeMode: 'cpu',
      gpuName: 'CPU',
      desiredCount: 1,
    });
  }

  // Requesting 8 blocks with only 3 headroom clamps cleanly to 3 contiguous blocks instead of failing
  const clampedBatch = store.leaseBlockBatch({
    shareToken: session.share_token,
    deviceId: 'fast-gpu-2',
    deviceLabel: 'RTX 5090',
    computeMode: 'webgpu',
    gpuName: 'NVIDIA RTX 5090',
    rateKps: 35_000_000,
  });
  assert.equal(clampedBatch.length, 3);

  const summaryCheck = store.getSessionSummary(session.share_token);
  assert.ok(summaryCheck);
  assert.ok(summaryCheck.devices.some((d) => d.id === 'fast-gpu-2' && d.isOnline));

  store.close();
});

test('Per-user block isolation: User B must still traverse blocks completed by User A (solo mode) and public leaderboard masks addresses safely', () => {
  const store = new Puzzle71Store(':memory:', {
    powHexPrefix: '00',
    minPowSharesFullBlock: 2,
  });

  const addrA = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const addrB = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
  const addrIdle = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';

  const userA = store.createOrGetSession(addrA, 'P2WPKH (SegWit v0)');
  const userB = store.createOrGetSession(addrB, 'P2PKH (Legacy)');
  store.createOrGetSession(addrIdle, 'P2SH (Script Hash)'); // 0-key idle session

  assert.notEqual(userA.id, userB.id);
  assert.notEqual(userA.share_token, userB.share_token);

  // Both users choose sequential mode from block #0 (0 %)
  store.updateSessionStrategy({ shareToken: userA.share_token, blockMode: 'sequential', startPercent: 0 });
  store.updateSessionStrategy({ shareToken: userB.share_token, blockMode: 'sequential', startPercent: 0 });

  // User A leases block #0 and block #1, and completes block #0 + advances block #1 partially
  const aBlock0 = store.leaseUniqueBlock({
    shareToken: userA.share_token,
    deviceId: 'dev-user-a-1',
    deviceLabel: 'PC A',
    computeMode: 'webgpu',
    gpuName: 'GPU A',
  });
  assert.equal(aBlock0.blockIndex, '0');

  const powA0 = findPowOffsetsInRange(aBlock0.startKeyHex, '00', 2);
  store.completeBlock({
    shareToken: userA.share_token,
    blockId: aBlock0.id,
    deviceId: 'dev-user-a-1',
    rateKps: 3_000_000,
    powOffsets: powA0,
  });

  const aBlock1 = store.leaseUniqueBlock({
    shareToken: userA.share_token,
    deviceId: 'dev-user-a-2',
    deviceLabel: 'Laptop A',
    computeMode: 'cpu',
    gpuName: 'CPU A',
  });
  assert.equal(aBlock1.blockIndex, '1');
  store.checkpointBlock({
    shareToken: userA.share_token,
    blockId: aBlock1.id,
    deviceId: 'dev-user-a-2',
    progressOffset: 250_000,
    rateKps: 250_000,
  });

  // User B starts sequential at 0% -> MUST still receive block #0 and block #1 independently (NOT skipped!)
  const bBlock0 = store.leaseUniqueBlock({
    shareToken: userB.share_token,
    deviceId: 'dev-user-b-1',
    deviceLabel: 'PC B',
    computeMode: 'webgpu',
    gpuName: 'GPU B',
  });
  assert.equal(bBlock0.blockIndex, '0');
  assert.notEqual(bBlock0.id, aBlock0.id);

  store.checkpointBlock({
    shareToken: userB.share_token,
    blockId: bBlock0.id,
    deviceId: 'dev-user-b-1',
    progressOffset: 100_000,
    rateKps: 1_500_000,
  });

  // User B's second device leases the next sequential block -> MUST receive block #1 independently
  const bBlock1 = store.leaseUniqueBlock({
    shareToken: userB.share_token,
    deviceId: 'dev-user-b-2',
    deviceLabel: 'Phone B',
    computeMode: 'cpu',
    gpuName: 'CPU B',
  });
  assert.equal(bBlock1.blockIndex, '1');

  // Verify public leaderboard ranking, solo-consistent summary (never summing solo ranges together), and masking
  const leaderboard = store.getPublicLeaderboard(20);
  assert.equal(leaderboard.summary.participantsCount, 2); // idle session excluded
  assert.equal(leaderboard.summary.onlineDevicesCount, 4); // dev-user-a-1/2 + dev-user-b-1/2
  assert.equal(leaderboard.summary.topCompletedBlocks, 1); // #1 solver's record, not cross-user sum
  assert.equal(leaderboard.summary.topKeysChecked, Number(BLOCK_SIZE) + 250_000);
  assert.ok(leaderboard.summary.topProgressPercent > 0 && leaderboard.summary.topProgressPercent <= 100);

  assert.equal(leaderboard.entries.length, 2);
  const [first, second] = leaderboard.entries;

  assert.equal(first.rank, 1);
  assert.equal(first.maskedAddress, 'bc1qw5…v8f3t4');
  assert.equal(first.completedBlocksCount, 1);
  assert.equal(first.activeBlocksCount, 1);
  assert.equal(first.totalKeysChecked, Number(BLOCK_SIZE) + 250_000);
  assert.ok(first.progressPercent > 0);

  assert.equal(second.rank, 2);
  assert.equal(second.maskedAddress, '1A1zP1…DivfNa');
  assert.equal(second.completedBlocksCount, 0);
  assert.equal(second.activeBlocksCount, 2);
  assert.equal(second.totalKeysChecked, 100_000);

  // Security check: serialized JSON must NEVER contain full BTC addresses or any share token
  const serialized = JSON.stringify(leaderboard);
  assert.ok(!serialized.includes(addrA));
  assert.ok(!serialized.includes(addrB));
  assert.ok(!serialized.includes(userA.share_token));
  assert.ok(!serialized.includes(userB.share_token));

  store.close();
});

