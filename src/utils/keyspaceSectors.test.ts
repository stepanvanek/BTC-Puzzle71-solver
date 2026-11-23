import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCK_SIZE, TOTAL_BLOCKS, percentToBlockIndex } from '../shared/puzzle71.ts';
import type { LeasedBlockPayload } from '../types/api.ts';
import {
  KEYSPACE_SECTOR_COUNT,
  aggregateBlocksToSectorSummaries,
  blockIndexToSectorIndex,
  buildKeyspaceSectors,
  formatSectorCompactTileBadge,
  formatSectorCoveragePercent,
  getSectorEndBlockIndex,
  getSectorStartBlockIndex,
} from './keyspaceSectors.ts';

test('partitions full Puzzle #71 2^41 block space into 100 contiguous, non-overlapping sectors', () => {
  assert.equal(getSectorStartBlockIndex(0), 0n);
  assert.equal(getSectorEndBlockIndex(KEYSPACE_SECTOR_COUNT - 1), TOTAL_BLOCKS - 1n);

  let summedBlocks = 0n;
  for (let s = 0; s < KEYSPACE_SECTOR_COUNT; s += 1) {
    const start = getSectorStartBlockIndex(s);
    const end = getSectorEndBlockIndex(s);
    assert.ok(end >= start);
    summedBlocks += end - start + 1n;

    if (s > 0) {
      assert.equal(start, getSectorEndBlockIndex(s - 1) + 1n);
    }

    // Starting block from percentToBlockIndex(s) must map cleanly into sector s
    const startFromPercent = percentToBlockIndex(s);
    assert.equal(blockIndexToSectorIndex(startFromPercent), s);
    assert.equal(blockIndexToSectorIndex(end), s);
  }

  assert.equal(summedBlocks, TOTAL_BLOCKS);
});

test('aggregates blocks into sector summaries without double-counting duplicate block indexes', () => {
  const b0 = percentToBlockIndex(12).toString();
  const b1 = (percentToBlockIndex(12) + 5n).toString();
  const blocks: LeasedBlockPayload[] = [
    {
      id: b0,
      blockIndex: b0,
      startKeyHex: '0x40',
      endKeyHex: '0x41',
      progressOffset: Number(BLOCK_SIZE),
      totalKeys: Number(BLOCK_SIZE),
      powCount: 6,
      status: 'completed',
      deviceId: 'dev1',
      leasedAt: 1000,
      completedAt: 2000,
    },
    {
      id: b0,
      blockIndex: b0,
      startKeyHex: '0x40',
      endKeyHex: '0x41',
      progressOffset: 100,
      totalKeys: Number(BLOCK_SIZE),
      powCount: 0,
      status: 'leased',
      deviceId: 'dev1',
      leasedAt: 1000,
      completedAt: null,
    },
    {
      id: b1,
      blockIndex: b1,
      startKeyHex: '0x42',
      endKeyHex: '0x43',
      progressOffset: 123_456,
      totalKeys: Number(BLOCK_SIZE),
      powCount: 0,
      status: 'leased',
      deviceId: 'dev1',
      leasedAt: 3000,
      completedAt: null,
    },
  ];

  const summaries = aggregateBlocksToSectorSummaries(blocks);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].sectorIndex, 12);
  assert.equal(summaries[0].completedBlocksCount, 1);
  assert.equal(summaries[0].scannedKeys, Number(BLOCK_SIZE) + 123_456);
});

test('buildKeyspaceSectors overlays live un-checkpointed progress without double-counting and classifies 3 states', () => {
  const b42 = percentToBlockIndex(42).toString();
  const sectors = buildKeyspaceSectors({
    persistedSectors: [
      {
        sectorIndex: 42,
        scannedKeys: 1_000_000,
        completedBlocksCount: 0,
        updatedAt: 5000,
      },
    ],
    recentBlocks: [
      {
        id: b42,
        blockIndex: b42,
        startKeyHex: '0x50',
        endKeyHex: '0x51',
        progressOffset: 1_000_000,
        totalKeys: Number(BLOCK_SIZE),
        powCount: 0,
        status: 'leased',
        deviceId: 'dev1',
        leasedAt: 4000,
        completedAt: null,
      },
    ],
    liveActiveBlock: {
      blockIndex: b42,
      persistedOffset: 1_000_000,
      currentOffset: 1_500_000,
    },
  });

  assert.equal(sectors.length, 100);
  assert.equal(sectors[0].status, 'unscanned');
  assert.equal(sectors[0].scannedKeys, 0);
  assert.equal(sectors[0].visualFillPercent, 0);

  const s42 = sectors[42];
  assert.equal(s42.status, 'partial');
  assert.equal(s42.scannedKeys, 1_500_000);
  assert.ok(s42.visualFillPercent >= 8);
  assert.equal(s42.activeBlocksCount, 1);

  // Hypothetical full sector coverage transitions cleanly to completed (green)
  const fullSectors = buildKeyspaceSectors({
    persistedSectors: [
      {
        sectorIndex: 7,
        scannedKeys: s42.totalKeysFloat,
        completedBlocksCount: s42.totalBlocks,
        updatedAt: 9000,
      },
    ],
  });
  assert.equal(fullSectors[7].status, 'completed');
  assert.equal(fullSectors[7].coveragePercent, 100);
  assert.equal(fullSectors[7].visualFillPercent, 100);
  assert.equal(formatSectorCompactTileBadge(fullSectors[7], 'cs'), '100%');
});

test('formats sector coverage percentages with locale-appropriate decimal separator', () => {
  assert.equal(formatSectorCoveragePercent(0, 'cs'), '0 %');
  assert.equal(formatSectorCoveragePercent(0, 'en'), '0%');
  assert.equal(formatSectorCoveragePercent(100, 'cs'), '100 %');
  assert.equal(formatSectorCoveragePercent(12.5, 'cs'), '12,50 %');
  assert.equal(formatSectorCoveragePercent(12.5, 'en'), '12.50%');
  assert.equal(formatSectorCoveragePercent(0.0000045, 'cs'), '0,0000045 %');
});
