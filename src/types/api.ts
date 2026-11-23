export interface SessionData {
  session: {
    id: string;
    shareToken: string;
    btcAddress: string;
    addressType: string;
    createdAt: number;
  };
  strategy: {
    blockMode: 'random' | 'sequential';
    seqCursor: string;
    seqPercent: number;
  };
  stats: {
    totalKeysChecked: number;
    completedBlocksCount: number;
    activeLeasedCount: number;
    blockSizeKeys: number;
  };
  devices: Array<{
    id: string;
    label: string;
    computeMode: string;
    gpuName: string;
    lastRateKps: number;
    keysChecked: number;
    blocksCompleted: number;
    lastSeenAt: number;
    isOnline: boolean;
  }>;
  recentBlocks: Array<{
    id: string;
    blockIndex: string;
    startKeyHex: string;
    endKeyHex: string;
    progressOffset: number;
    totalKeys: number;
    powCount: number;
    status: 'leased' | 'completed';
    deviceId: string;
    leasedAt: number;
    completedAt: number | null;
  }>;
  sectors?: SessionSectorSummary[];
}

export interface SessionSectorSummary {
  sectorIndex: number;
  scannedKeys: number;
  completedBlocksCount: number;
  updatedAt: number;
}

export interface LeasedBlockPayload {
  id: string;
  blockIndex: string;
  startKeyHex: string;
  endKeyHex: string;
  progressOffset: number;
  totalKeys: number;
  powCount: number;
  status: 'leased' | 'completed';
  deviceId: string;
  leasedAt: number;
  completedAt: number | null;
}

export interface LeaseBlocksResponse {
  block: LeasedBlockPayload;
  blocks: LeasedBlockPayload[];
  recommendedBatchCount?: number;
}

export interface PuzzleUtxoItem {
  txid: string;
  vout: number;
  valueSats: string;
  confirmed: boolean;
}

export interface PuzzleNetworkInfo {
  address: string;
  totalBalanceSats: string;
  utxoCount: number;
  utxo: PuzzleUtxoItem;
  utxos: PuzzleUtxoItem[];
  recommendedFeeRateSatVb: number;
  slipstreamFeeRateSatVb: number;
  source: 'live-mempool' | 'fallback';
  fetchedAt: number;
}

export interface PrivateRelayReceipt {
  provider: string;
  endpoint: string;
  accepted: boolean;
  statusCode: number;
  responseText: string;
}

export interface PrivateBroadcastResult {
  dryRun: boolean;
  anyAccepted: boolean;
  receipts: PrivateRelayReceipt[];
}

export interface PublicLeaderboardEntry {
  rank: number;
  maskedAddress: string;
  addressType: string;
  totalKeysChecked: number;
  completedBlocksCount: number;
  activeBlocksCount: number;
  progressPercent: number;
  lastActivityAt: number;
}

export interface PublicLeaderboardResponse {
  entries: PublicLeaderboardEntry[];
  summary: {
    participantsCount: number;
    onlineDevicesCount: number;
    topKeysChecked: number;
    topCompletedBlocks: number;
    topProgressPercent: number;
  };
  generatedAt: number;
}

export type ActiveTab = 'compute' | 'ledger' | 'puzzles' | 'leaderboard' | 'relay' | 'docs' | 'terms';
