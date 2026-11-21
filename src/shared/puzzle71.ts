export const PUZZLE_71_NUMBER = 71;
export const PUZZLE_71_ADDRESS = '1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU';
export const PUZZLE_71_HASH160_HEX = 'f6f5431d25bbf7b12e8add9af5e3475c44a0a5b8';

// Puzzle #71 keyspace: [2^70, 2^71 - 1]
export const PUZZLE_71_MIN_KEY = 0x400000000000000000n;
export const PUZZLE_71_MAX_KEY = 0x7fffffffffffffffffn;
export const PUZZLE_71_TOTAL_KEYS = 0x400000000000000000n; // 2^70

// Demo Puzzle #5: canonical 5-bit puzzle [2^4, 2^5 - 1] = [16, 31], winning key 0x15 (21)
export const DEMO_PUZZLE_5_NUMBER = 5;
export const DEMO_PUZZLE_5_ADDRESS = '1E6NuFjCi27W5zoXg8TRdcSRq84zJeBW3k';
export const DEMO_PUZZLE_5_HASH160_HEX = '8f9dff39a81ee4abcbad2ad8bafff090415a2be8';
export const DEMO_PUZZLE_5_MIN_KEY = 0x10n;
export const DEMO_PUZZLE_5_MAX_KEY = 0x1fn;
export const DEMO_PUZZLE_5_TOTAL_KEYS = 16;
export const DEMO_PUZZLE_5_UTXO_SATS = 500_000n; // 0.005 BTC historical Puzzle #5 amount

// Admin payout address (15% of net reward after network fee)
export const ADMIN_PAYOUT_ADDRESS =
  'bc1queh9gagkne6jmr2452h6dyhl863s5gdzwkjp2wdua5qalnceklhs4vl2wq';

export const USER_SHARE_PERCENT = 85n;
export const ADMIN_SHARE_PERCENT = 15n;

// Canonical keyspace partitioning: 2^29 keys per block = 536,870,912 keys (~3 min @ 3 MKeys/s)
// Total blocks across Puzzle #71 range = 2^41 = 2,199,023,255,552 unique blocks
export const BLOCK_SIZE_BITS = 29n;
export const BLOCK_SIZE = 1n << BLOCK_SIZE_BITS; // 536,870,912
export const TOTAL_BLOCKS = PUZZLE_71_TOTAL_KEYS >> BLOCK_SIZE_BITS; // 2^41

// Proof-of-Work share difficulty: Hash160 starts with '000000' (24 zero bits => ~32 shares per 2^29 block)
export const POW_HASH160_HEX_PREFIX = '000000';
export const MIN_POW_SHARES_FULL_BLOCK = 6;

export function getRequiredPowShares(totalKeys: number, minFullBlockShares = MIN_POW_SHARES_FULL_BLOCK): number {
  if (totalKeys <= 0) return 0;
  if (totalKeys >= Number(BLOCK_SIZE)) return minFullBlockShares;
  // Proportional requirement for legacy/smaller blocks
  return Math.max(1, Math.min(minFullBlockShares, Math.floor((totalKeys * minFullBlockShares) / Number(BLOCK_SIZE))));
}

// Dynamic multi-block batching for fast GPUs while keeping canonical 2^29 blocks in SQLite
export const MAX_BATCH_LEASE_BLOCKS = 8;

export function getRecommendedBatchBlockCount(rateKps: number): number {
  if (!Number.isFinite(rateKps) || rateKps < 5_000_000) return 1;
  if (rateKps < 10_500_000) return 2;
  if (rateKps < 20_000_000) return 4;
  return MAX_BATCH_LEASE_BLOCKS;
}

// Fallback Puzzle #71 total balance (7.10195986 BTC in satoshis) when live query is offline
export const DEFAULT_PUZZLE_71_BALANCE_SATS = 710_195_986n;
export const DEFAULT_FEE_RATE_SAT_VB = 12;

export type BlockSelectionMode = 'random' | 'sequential';

export interface BlockRange {
  blockIndex: bigint;
  blockIndexStr: string;
  startKey: bigint;
  endKey: bigint;
  startKeyHex: string;
  endKeyHex: string;
  totalKeys: number;
}

export function formatPrivateKeyHex(key: bigint): string {
  return key.toString(16).padStart(64, '0');
}

export function formatShortKeyHex(key: bigint): string {
  return '0x' + key.toString(16).padStart(18, '0');
}

export function percentToBlockIndex(percent: number): bigint {
  const clamped = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  if (clamped <= 0) return 0n;
  if (clamped >= 100) return TOTAL_BLOCKS - 1n;
  const ppm = BigInt(Math.round(clamped * 1_000_000));
  const idx = (TOTAL_BLOCKS * ppm) / 100_000_000n;
  return idx >= TOTAL_BLOCKS ? TOTAL_BLOCKS - 1n : idx;
}

export function blockIndexToPercent(blockIndex: bigint): number {
  if (blockIndex <= 0n) return 0;
  if (blockIndex >= TOTAL_BLOCKS - 1n) return 100;
  const tenThousandths = Number((blockIndex * 100_000n) / TOTAL_BLOCKS);
  return Math.round(tenThousandths) / 1000;
}

export function blockIndexToRange(blockIndex: bigint): BlockRange {
  if (blockIndex < 0n || blockIndex >= TOTAL_BLOCKS) {
    throw new Error(`Neplatný index bloku mimo rozsah Puzzle #71: ${blockIndex.toString()}`);
  }
  const startKey = PUZZLE_71_MIN_KEY + blockIndex * BLOCK_SIZE;
  const endKey = startKey + BLOCK_SIZE - 1n;
  return {
    blockIndex,
    blockIndexStr: blockIndex.toString(),
    startKey,
    endKey,
    startKeyHex: formatShortKeyHex(startKey),
    endKeyHex: formatShortKeyHex(endKey),
    totalKeys: Number(BLOCK_SIZE),
  };
}

