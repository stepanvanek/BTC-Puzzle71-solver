import type { Locale } from '../i18n/locale.ts';
import {
  BLOCK_SIZE,
  PUZZLE_71_MIN_KEY,
  TOTAL_BLOCKS,
  formatShortKeyHex,
} from '../shared/puzzle71.ts';
import type { LeasedBlockPayload, SessionSectorSummary } from '../types/api.ts';

export const KEYSPACE_SECTOR_COUNT = 100;

export type SectorCoverageStatus = 'unscanned' | 'partial' | 'completed';

export interface KeyspaceSectorInfo {
  sectorIndex: number;
  startPercent: number;
  endPercent: number;
  startBlockIndexStr: string;
  endBlockIndexStr: string;
  totalBlocks: number;
  totalKeysFloat: number;
  startKeyHex: string;
  endKeyHex: string;
  scannedKeys: number;
  completedBlocksCount: number;
  activeBlocksCount: number;
  coveragePercent: number;
  visualFillPercent: number;
  status: SectorCoverageStatus;
}

export interface LiveActiveBlockOverlay {
  blockIndex: string;
  currentOffset: number;
  persistedOffset: number;
}

export function getSectorStartBlockIndex(sectorIndex: number): bigint {
  const clamped = Math.max(0, Math.min(KEYSPACE_SECTOR_COUNT, Math.floor(sectorIndex)));
  return (TOTAL_BLOCKS * BigInt(clamped)) / BigInt(KEYSPACE_SECTOR_COUNT);
}

export function getSectorEndBlockIndex(sectorIndex: number): bigint {
  const clamped = Math.max(0, Math.min(KEYSPACE_SECTOR_COUNT - 1, Math.floor(sectorIndex)));
  return getSectorStartBlockIndex(clamped + 1) - 1n;
}

export function blockIndexToSectorIndex(blockIndexInput: bigint | string): number {
  let idx: bigint;
  try {
    idx = typeof blockIndexInput === 'bigint' ? blockIndexInput : BigInt(blockIndexInput);
  } catch {
    return 0;
  }
  if (idx <= 0n) return 0;
  if (idx >= TOTAL_BLOCKS - 1n) return KEYSPACE_SECTOR_COUNT - 1;

  let candidate = Number((idx * BigInt(KEYSPACE_SECTOR_COUNT)) / TOTAL_BLOCKS);
  if (!Number.isFinite(candidate) || candidate < 0) candidate = 0;
  if (candidate >= KEYSPACE_SECTOR_COUNT) candidate = KEYSPACE_SECTOR_COUNT - 1;

  while (candidate < KEYSPACE_SECTOR_COUNT - 1 && idx >= getSectorStartBlockIndex(candidate + 1)) {
    candidate += 1;
  }
  while (candidate > 0 && idx < getSectorStartBlockIndex(candidate)) {
    candidate -= 1;
  }
  return candidate;
}

export function aggregateBlocksToSectorSummaries(
  blocks: LeasedBlockPayload[],
): SessionSectorSummary[] {
  const buckets = new Map<number, { scannedKeys: number; completedBlocksCount: number; updatedAt: number }>();
  const seenBlockIds = new Set<string>();

  for (const block of blocks) {
    if (seenBlockIds.has(block.blockIndex)) continue;
    seenBlockIds.add(block.blockIndex);

    const effectiveKeys =
      block.status === 'completed'
        ? Math.max(Number(block.totalKeys || 0), Number(block.progressOffset || 0))
        : Math.max(0, Number(block.progressOffset || 0));

    if (effectiveKeys <= 0 && block.status !== 'completed') continue;

    const sectorIdx = blockIndexToSectorIndex(block.blockIndex);
    const prev = buckets.get(sectorIdx) ?? { scannedKeys: 0, completedBlocksCount: 0, updatedAt: 0 };
    buckets.set(sectorIdx, {
      scannedKeys: prev.scannedKeys + effectiveKeys,
      completedBlocksCount: prev.completedBlocksCount + (block.status === 'completed' ? 1 : 0),
      updatedAt: Math.max(prev.updatedAt, block.completedAt ?? block.leasedAt ?? 0),
    });
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sectorIndex, val]) => ({
      sectorIndex,
      scannedKeys: val.scannedKeys,
      completedBlocksCount: val.completedBlocksCount,
      updatedAt: val.updatedAt,
    }));
}

export function computeVisualFillPercent(coveragePercent: number, scannedKeys: number): number {
  if (scannedKeys <= 0 || coveragePercent <= 0) return 0;
  if (coveragePercent >= 100) return 100;
  if (coveragePercent >= 1) {
    return Math.min(99, Math.max(8, coveragePercent));
  }
  // Ensure even 1 scanned block out of 21.99B blocks shows a crisp partial bar
  return Math.max(8, Math.min(20, 8 + coveragePercent * 12));
}

export function buildKeyspaceSectors(params: {
  persistedSectors?: SessionSectorSummary[];
  recentBlocks?: LeasedBlockPayload[];
  liveActiveBlock?: LiveActiveBlockOverlay | null;
}): KeyspaceSectorInfo[] {
  const recentBlocks = params.recentBlocks ?? [];
  const baseSummaries =
    params.persistedSectors && params.persistedSectors.length > 0
      ? params.persistedSectors
      : aggregateBlocksToSectorSummaries(recentBlocks);

  const summaryMap = new Map<number, { scannedKeys: number; completedBlocksCount: number }>();
  for (const item of baseSummaries) {
    if (item.sectorIndex < 0 || item.sectorIndex >= KEYSPACE_SECTOR_COUNT) continue;
    summaryMap.set(item.sectorIndex, {
      scannedKeys: Math.max(0, Number(item.scannedKeys || 0)),
      completedBlocksCount: Math.max(0, Number(item.completedBlocksCount || 0)),
    });
  }

  // Apply live un-checkpointed delta from active browser scan loop without double-counting
  const live = params.liveActiveBlock;
  if (live && live.currentOffset > live.persistedOffset) {
    const liveSectorIdx = blockIndexToSectorIndex(live.blockIndex);
    const prev = summaryMap.get(liveSectorIdx) ?? { scannedKeys: 0, completedBlocksCount: 0 };
    summaryMap.set(liveSectorIdx, {
      scannedKeys: prev.scannedKeys + (live.currentOffset - live.persistedOffset),
      completedBlocksCount: prev.completedBlocksCount,
    });
  }

  const activeCounts = new Map<number, number>();
  for (const b of recentBlocks) {
    if (b.status !== 'leased') continue;
    const isLiveThisBlock = live && live.blockIndex === b.blockIndex && live.currentOffset > 0;
    if (b.progressOffset > 0 || isLiveThisBlock) {
      const sIdx = blockIndexToSectorIndex(b.blockIndex);
      activeCounts.set(sIdx, (activeCounts.get(sIdx) ?? 0) + 1);
    }
  }
  if (live && live.currentOffset > 0) {
    const liveSectorIdx = blockIndexToSectorIndex(live.blockIndex);
    if (!activeCounts.has(liveSectorIdx)) {
      activeCounts.set(liveSectorIdx, 1);
    }
  }

  const sectors: KeyspaceSectorInfo[] = [];
  for (let s = 0; s < KEYSPACE_SECTOR_COUNT; s += 1) {
    const startBlock = getSectorStartBlockIndex(s);
    const endBlock = getSectorEndBlockIndex(s);
    const totalBlocks = Number(endBlock - startBlock + 1n);
    const totalKeysFloat = Number(BigInt(totalBlocks) * BLOCK_SIZE);

    const startKey = PUZZLE_71_MIN_KEY + startBlock * BLOCK_SIZE;
    const endKey = PUZZLE_71_MIN_KEY + (endBlock + 1n) * BLOCK_SIZE - 1n;

    const stats = summaryMap.get(s);
    const scannedKeys = stats ? stats.scannedKeys : 0;
    const completedBlocksCount = stats ? stats.completedBlocksCount : 0;
    const activeBlocksCount = activeCounts.get(s) ?? 0;

    const rawCoverage = totalKeysFloat > 0 ? (scannedKeys / totalKeysFloat) * 100 : 0;
    const coveragePercent = Math.max(0, Math.min(100, rawCoverage));
    const status: SectorCoverageStatus =
      scannedKeys >= totalKeysFloat || coveragePercent >= 100
        ? 'completed'
        : scannedKeys > 0
          ? 'partial'
          : 'unscanned';

    sectors.push({
      sectorIndex: s,
      startPercent: s,
      endPercent: s + 1,
      startBlockIndexStr: startBlock.toString(),
      endBlockIndexStr: endBlock.toString(),
      totalBlocks,
      totalKeysFloat,
      startKeyHex: formatShortKeyHex(startKey),
      endKeyHex: formatShortKeyHex(endKey),
      scannedKeys,
      completedBlocksCount,
      activeBlocksCount,
      coveragePercent: status === 'completed' ? 100 : coveragePercent,
      visualFillPercent: status === 'completed' ? 100 : computeVisualFillPercent(coveragePercent, scannedKeys),
      status,
    });
  }

  return sectors;
}

export function formatSectorCoveragePercent(
  coveragePercent: number,
  locale: Locale = 'en',
): string {
  const isCs = locale === 'cs';
  const suffix = isCs ? ' %' : '%';
  const formatDec = (raw: string) => (isCs ? raw.replace('.', ',') : raw);

  if (!Number.isFinite(coveragePercent) || coveragePercent <= 0) {
    return `0${suffix}`;
  }
  if (coveragePercent >= 100) {
    return `100${suffix}`;
  }
  if (coveragePercent >= 1) {
    return `${formatDec(coveragePercent.toFixed(2))}${suffix}`;
  }
  if (coveragePercent >= 0.001) {
    return `${formatDec(coveragePercent.toFixed(4))}${suffix}`;
  }
  const exp = Math.floor(Math.log10(coveragePercent));
  const decimals = Math.min(14, Math.max(4, Math.abs(exp) + 1));
  return `${formatDec(coveragePercent.toFixed(decimals))}${suffix}`;
}

export function formatSectorCompactTileBadge(
  sector: KeyspaceSectorInfo,
  locale: Locale = 'en',
): string {
  if (sector.status === 'unscanned') return '';
  if (sector.status === 'completed') return '100%';
  if (sector.coveragePercent >= 1) {
    const val = Math.floor(sector.coveragePercent);
    return `${val}%`;
  }
  const equivBlocks = sector.scannedKeys / Number(BLOCK_SIZE);
  if (equivBlocks >= 1000) {
    return `${Math.round(equivBlocks / 1000)}k`;
  }
  if (equivBlocks >= 1) {
    return `${Math.round(equivBlocks)}b`;
  }
  return locale === 'cs' ? '<1b' : '<1b';
}
