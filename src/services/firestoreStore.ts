import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  type DocumentReference,
} from 'firebase/firestore';
import { OperationType, db, handleFirestoreError } from '../firebase.ts';
import { maskBtcAddress, validateBitcoinAddress } from '../shared/btcAddress.ts';
import { privateKeyToHash160Hex } from '../shared/btcTx.ts';
import {
  BLOCK_SIZE,
  MAX_BATCH_LEASE_BLOCKS,
  MIN_POW_SHARES_FULL_BLOCK,
  POW_HASH160_HEX_PREFIX,
  TOTAL_BLOCKS,
  blockIndexToPercent,
  blockIndexToRange,
  getRecommendedBatchBlockCount,
  getRequiredPowShares,
  percentToBlockIndex,
  type BlockSelectionMode,
} from '../shared/puzzle71.ts';
import type {
  LeasedBlockPayload,
  PublicLeaderboardEntry,
  PublicLeaderboardResponse,
  SessionData,
  SessionSectorSummary,
} from '../types/api.ts';
import {
  aggregateBlocksToSectorSummaries,
  blockIndexToSectorIndex,
} from '../utils/keyspaceSectors.ts';
import { calculateKeyspaceProgressPercent } from '../utils/keyspaceStats.ts';

const MAX_ACTIVE_LEASES_PER_SESSION = 32;
const MAX_STORED_POW_OFFSETS = 64;
const MAX_INCOMING_POW_OFFSETS = 32;
const STALE_LEASE_MS = 360_000; // 6 minutes without heartbeat
const ONLINE_CUTOFF_MS = 45_000;

interface FirestoreSessionDoc {
  btcAddress: string;
  shareToken: string;
  addressType: string;
  blockMode: BlockSelectionMode;
  seqCursor: string;
  totalKeysChecked: number;
  completedBlocksCount: number;
  activeLeasedCount: number;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

interface FirestoreDeviceDoc {
  id: string;
  label: string;
  computeMode: 'webgpu' | 'cpu';
  gpuName: string;
  lastRateKps: number;
  keysChecked: number;
  blocksCompleted: number;
  lastSeenAt: Timestamp | null;
}

interface FirestoreBlockDoc {
  blockIndex: string;
  startKeyHex: string;
  endKeyHex: string;
  status: 'leased' | 'completed';
  deviceId: string;
  progressOffset: number;
  totalKeys: number;
  powOffsets: number[];
  powCount: number;
  leasedAt: Timestamp | null;
  heartbeatAt: Timestamp | null;
  completedAt: Timestamp | null;
}

interface FirestoreLeaderboardDoc {
  maskedAddress: string;
  addressType: string;
  totalKeysChecked: number;
  completedBlocksCount: number;
  activeBlocksCount: number;
  lastActivityAt: Timestamp | null;
}

interface FirestoreSectorDoc {
  sectorIndex: string;
  scannedKeys: number;
  completedBlocksCount: number;
  updatedAt: Timestamp | null;
}

function timestampToMs(ts: Timestamp | number | null | undefined, fallback = Date.now()): number {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (ts && typeof ts === 'object' && typeof ts.toMillis === 'function') {
    return ts.toMillis();
  }
  return fallback;
}

function generateShareToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateRandomBlockIndex(): bigint {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  const raw =
    (BigInt(buf[0] & 0x01) << 40n) |
    (BigInt(buf[1]) << 32n) |
    (BigInt(buf[2]) << 24n) |
    (BigInt(buf[3]) << 16n) |
    (BigInt(buf[4]) << 8n) |
    BigInt(buf[5]);
  return raw % TOTAL_BLOCKS;
}

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function sanitizeLabel(label: string): string {
  const trimmed = label.trim().slice(0, 80);
  return trimmed || 'Browser';
}

function sanitizeGpuName(gpuName: string): string {
  const trimmed = gpuName.trim().slice(0, 160);
  return trimmed || 'WebGPU / CPU';
}

function sanitizePowOffsets(existing: number[], incoming: number[], startKeyHex: string, totalKeys: number): number[] {
  const merged = new Set<number>();
  for (const n of existing) {
    if (Number.isInteger(n) && n >= 0 && n < totalKeys) {
      merged.add(n);
    }
  }
  if (incoming.length > 0) {
    const startKey = BigInt(startKeyHex);
    for (const rawOffset of incoming.slice(0, MAX_INCOMING_POW_OFFSETS)) {
      if (!Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset >= totalKeys) continue;
      if (merged.has(rawOffset)) continue;
      const hashHex = privateKeyToHash160Hex(startKey + BigInt(rawOffset));
      if (hashHex.startsWith(POW_HASH160_HEX_PREFIX)) {
        merged.add(rawOffset);
      }
    }
  }
  return [...merged].sort((a, b) => a - b).slice(0, MAX_STORED_POW_OFFSETS);
}

function mapBlockDocToPayload(docData: FirestoreBlockDoc): LeasedBlockPayload {
  const leasedAtMs = timestampToMs(docData.leasedAt);
  const completedAtMs = docData.completedAt ? timestampToMs(docData.completedAt) : null;
  return {
    id: docData.blockIndex,
    blockIndex: docData.blockIndex,
    startKeyHex: docData.startKeyHex,
    endKeyHex: docData.endKeyHex,
    progressOffset: docData.progressOffset,
    totalKeys: docData.totalKeys,
    powCount: docData.powCount,
    status: docData.status,
    deviceId: docData.deviceId,
    leasedAt: leasedAtMs,
    completedAt: completedAtMs,
  };
}

export async function getSessionSummaryByAddress(btcAddress: string): Promise<SessionData | null> {
  const sessionPath = `sessions/${btcAddress}`;
  try {
    const sessionRef = doc(db, 'sessions', btcAddress);
    const sessionSnap = await getDoc(sessionRef);
    if (!sessionSnap.exists()) return null;

    const s = sessionSnap.data() as FirestoreSessionDoc;
    const now = Date.now();
    const onlineCutoff = now - ONLINE_CUTOFF_MS;

    const devicesSnap = await getDocs(
      query(collection(db, 'sessions', btcAddress, 'devices'), orderBy('lastSeenAt', 'desc'), limit(40)),
    );
    const leasedSnap = await getDocs(
      query(collection(db, 'sessions', btcAddress, 'blocks'), where('status', '==', 'leased'), limit(32)),
    );
    const recentSnap = await getDocs(
      query(collection(db, 'sessions', btcAddress, 'blocks'), orderBy('leasedAt', 'desc'), limit(40)),
    );
    const sectorsSnap = await getDocs(
      query(collection(db, 'sessions', btcAddress, 'sectors'), where('scannedKeys', '>=', 0), limit(100)),
    );

    const blockMap = new Map<string, LeasedBlockPayload>();
    for (const d of leasedSnap.docs) {
      const payload = mapBlockDocToPayload(d.data() as FirestoreBlockDoc);
      blockMap.set(payload.blockIndex, payload);
    }
    for (const d of recentSnap.docs) {
      const payload = mapBlockDocToPayload(d.data() as FirestoreBlockDoc);
      if (!blockMap.has(payload.blockIndex)) {
        blockMap.set(payload.blockIndex, payload);
      }
    }

    const recentBlocks = [...blockMap.values()]
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'leased' ? -1 : 1;
        return b.leasedAt - a.leasedAt;
      })
      .slice(0, 40);

    let sectors: SessionSectorSummary[] = sectorsSnap.docs
      .map((d) => {
        const sec = d.data() as FirestoreSectorDoc;
        const parsedIdx = Number(sec.sectorIndex);
        return {
          sectorIndex: Number.isInteger(parsedIdx) ? parsedIdx : -1,
          scannedKeys: Number(sec.scannedKeys || 0),
          completedBlocksCount: Number(sec.completedBlocksCount || 0),
          updatedAt: timestampToMs(sec.updatedAt),
        };
      })
      .filter((sec) => sec.sectorIndex >= 0 && sec.sectorIndex < 100)
      .sort((a, b) => a.sectorIndex - b.sectorIndex);

    // Seamless fallback for pre-upgrade sessions that have scanned blocks before /sectors existed
    if (sectors.length === 0 && Number(s.totalKeysChecked || 0) > 0) {
      if (recentSnap.docs.length < 40) {
        sectors = aggregateBlocksToSectorSummaries([...blockMap.values()]);
      } else {
        const legacyBlocksSnap = await getDocs(
          query(collection(db, 'sessions', btcAddress, 'blocks'), limit(500)),
        );
        const legacyMap = new Map<string, LeasedBlockPayload>(blockMap);
        for (const d of legacyBlocksSnap.docs) {
          const payload = mapBlockDocToPayload(d.data() as FirestoreBlockDoc);
          if (!legacyMap.has(payload.blockIndex)) {
            legacyMap.set(payload.blockIndex, payload);
          }
        }
        sectors = aggregateBlocksToSectorSummaries([...legacyMap.values()]);
      }
    }

    let seqCursorBig = 0n;
    try {
      seqCursorBig = BigInt(s.seqCursor || '0');
    } catch {
      seqCursorBig = 0n;
    }

    return {
      session: {
        id: s.btcAddress,
        shareToken: s.shareToken,
        btcAddress: s.btcAddress,
        addressType: s.addressType,
        createdAt: timestampToMs(s.createdAt),
      },
      strategy: {
        blockMode: s.blockMode === 'sequential' ? 'sequential' : 'random',
        seqCursor: seqCursorBig.toString(),
        seqPercent: blockIndexToPercent(seqCursorBig),
      },
      stats: {
        totalKeysChecked: Number(s.totalKeysChecked || 0),
        completedBlocksCount: Number(s.completedBlocksCount || 0),
        activeLeasedCount: Number(s.activeLeasedCount || 0),
        blockSizeKeys: Number(BLOCK_SIZE),
      },
      devices: devicesSnap.docs.map((d) => {
        const dev = d.data() as FirestoreDeviceDoc;
        const lastSeenAt = timestampToMs(dev.lastSeenAt);
        return {
          id: dev.id,
          label: dev.label,
          computeMode: dev.computeMode,
          gpuName: dev.gpuName,
          lastRateKps: Number(dev.lastRateKps || 0),
          keysChecked: Number(dev.keysChecked || 0),
          blocksCompleted: Number(dev.blocksCompleted || 0),
          lastSeenAt,
          isOnline: lastSeenAt >= onlineCutoff,
        };
      }),
      recentBlocks,
      sectors,
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, sessionPath);
  }
}

export async function getSessionSummaryByToken(shareToken: string): Promise<SessionData | null> {
  const token = shareToken.trim();
  if (!token) return null;
  const tokenPath = `share_tokens/${token}`;
  try {
    const tokenSnap = await getDoc(doc(db, 'share_tokens', token));
    if (!tokenSnap.exists()) return null;
    const { btcAddress } = tokenSnap.data() as { btcAddress: string };
    if (!btcAddress) return null;
    return await getSessionSummaryByAddress(btcAddress);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, tokenPath);
  }
}

export async function createOrResumeSessionByAddress(params: {
  btcAddress: string;
  locale: 'en' | 'cs';
}): Promise<SessionData> {
  const validation = validateBitcoinAddress(params.btcAddress, params.locale);
  if (!validation.valid || !validation.parsed) {
    throw new Error(
      validation.error ||
        (params.locale === 'cs' ? 'Neplatná bitcoinová adresa.' : 'Invalid Bitcoin address.'),
    );
  }

  const normalizedAddress = validation.parsed.normalizedAddress;
  const addressType = validation.parsed.type;
  const sessionPath = `sessions/${normalizedAddress}`;

  try {
    // 1. Resume existing persistent workspace for this Bitcoin address if it already exists
    const existing = await getSessionSummaryByAddress(normalizedAddress);
    if (existing) {
      return existing;
    }

    // 2. Otherwise atomically create session + immutable share_tokens lookup
    const sessionRef = doc(db, 'sessions', normalizedAddress);
    const shareToken = generateShareToken();
    const tokenRef = doc(db, 'share_tokens', shareToken);

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(sessionRef);
      if (snap.exists()) {
        return;
      }
      tx.set(sessionRef, {
        btcAddress: normalizedAddress,
        shareToken,
        addressType,
        blockMode: 'random',
        seqCursor: '0',
        totalKeysChecked: 0,
        completedBlocksCount: 0,
        activeLeasedCount: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      tx.set(tokenRef, {
        btcAddress: normalizedAddress,
        createdAt: serverTimestamp(),
      });
    });

    const created = await getSessionSummaryByAddress(normalizedAddress);
    if (!created) {
      throw new Error(
        params.locale === 'cs'
          ? 'Nepodařilo se načíst nově vytvořenou relaci.'
          : 'Failed to load newly created session.',
      );
    }
    return created;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, sessionPath);
  }
}

export async function updateSessionStrategyInFirestore(params: {
  btcAddress: string;
  blockMode: BlockSelectionMode;
  startPercent?: number;
  deviceId: string;
}): Promise<SessionData> {
  const sessionPath = `sessions/${params.btcAddress}`;
  try {
    if (params.blockMode !== 'random' && params.blockMode !== 'sequential') {
      throw new Error('Neplatný režim výběru bloků.');
    }
    if (
      params.blockMode === 'sequential' &&
      params.startPercent !== undefined &&
      (!Number.isFinite(params.startPercent) || params.startPercent < 0 || params.startPercent > 100)
    ) {
      throw new Error('Startovní pozice musí být v rozsahu 0 až 100 %.');
    }

    const leasedSnap = await getDocs(
      query(collection(db, 'sessions', params.btcAddress, 'blocks'), where('status', '==', 'leased'), limit(32)),
    );
    const zeroProgressRefs = leasedSnap.docs
      .filter((d) => {
        const data = d.data() as FirestoreBlockDoc;
        return data.deviceId === params.deviceId && data.progressOffset === 0;
      })
      .map((d) => d.ref);

    const sessionRef = doc(db, 'sessions', params.btcAddress);
    await runTransaction(db, async (tx) => {
      const sessionSnap = await tx.get(sessionRef);
      if (!sessionSnap.exists()) {
        throw new Error('Relace pro tuto adresu neexistuje.');
      }
      const s = sessionSnap.data() as FirestoreSessionDoc;
      const toDelete: DocumentReference[] = [];
      for (const ref of zeroProgressRefs) {
        const bSnap = await tx.get(ref);
        if (bSnap.exists()) {
          const b = bSnap.data() as FirestoreBlockDoc;
          if (b.status === 'leased' && b.deviceId === params.deviceId && b.progressOffset === 0) {
            toDelete.push(ref);
          }
        }
      }

      const nextCursor =
        params.blockMode === 'sequential' && params.startPercent !== undefined
          ? percentToBlockIndex(params.startPercent).toString()
          : s.seqCursor || '0';

      for (const ref of toDelete) {
        tx.delete(ref);
      }

      tx.update(sessionRef, {
        blockMode: params.blockMode,
        seqCursor: nextCursor,
        activeLeasedCount: Math.max(0, Number(s.activeLeasedCount || 0) - toDelete.length),
        updatedAt: serverTimestamp(),
      });
    });

    const summary = await getSessionSummaryByAddress(params.btcAddress);
    if (!summary) {
      throw new Error('Relace nebyla nalezena.');
    }
    return summary;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, sessionPath);
  }
}

export async function leaseBlockBatchInFirestore(params: {
  btcAddress: string;
  deviceId: string;
  deviceLabel: string;
  computeMode: 'webgpu' | 'cpu';
  gpuName: string;
  rateKps?: number;
  desiredCount?: number;
}): Promise<LeasedBlockPayload[]> {
  const blocksPath = `sessions/${params.btcAddress}/blocks`;
  try {
    const rawDesired =
      params.desiredCount !== undefined
        ? params.desiredCount
        : params.rateKps !== undefined
          ? getRecommendedBatchBlockCount(params.rateKps)
          : 1;
    const requestedCount = Math.min(
      MAX_BATCH_LEASE_BLOCKS,
      Math.max(1, Number.isFinite(rawDesired) ? Math.floor(rawDesired) : 1),
    );

    const sessionRef = doc(db, 'sessions', params.btcAddress);
    const deviceRef = doc(db, 'sessions', params.btcAddress, 'devices', params.deviceId);
    const blocksCol = collection(db, 'sessions', params.btcAddress, 'blocks');

    // Pre-fetch session + active leased blocks to prepare candidate doc refs before transaction
    const [sessionPreSnap, leasedPreSnap] = await Promise.all([
      getDoc(sessionRef),
      getDocs(query(blocksCol, where('status', '==', 'leased'), limit(40))),
    ]);
    if (!sessionPreSnap.exists()) {
      throw new Error('Relace pro tuto adresu neexistuje.');
    }

    const preSession = sessionPreSnap.data() as FirestoreSessionDoc;
    const ownLeaseRefs = leasedPreSnap.docs
      .filter((d) => (d.data() as FirestoreBlockDoc).deviceId === params.deviceId)
      .sort(
        (a, b) =>
          timestampToMs((a.data() as FirestoreBlockDoc).leasedAt) -
          timestampToMs((b.data() as FirestoreBlockDoc).leasedAt),
      )
      .map((d) => d.ref);

    const nowMs = Date.now();
    const staleCutoffMs = nowMs - STALE_LEASE_MS;
    const staleLeaseRefs = leasedPreSnap.docs
      .filter((d) => {
        const data = d.data() as FirestoreBlockDoc;
        return timestampToMs(data.heartbeatAt) < staleCutoffMs;
      })
      .sort(
        (a, b) =>
          timestampToMs((a.data() as FirestoreBlockDoc).heartbeatAt) -
          timestampToMs((b.data() as FirestoreBlockDoc).heartbeatAt),
      )
      .slice(0, 1)
      .map((d) => d.ref);

    // Pre-compute candidate block IDs (enough headroom in case a couple already exist)
    const candidateIds: string[] = [];
    const seenIds = new Set<string>();
    if (preSession.blockMode === 'sequential') {
      let cursor = 0n;
      try {
        cursor = BigInt(preSession.seqCursor || '0');
      } catch {
        cursor = 0n;
      }
      const probeLimit = requestedCount + 16;
      for (let i = 0; i < probeLimit; i++) {
        const idx = (cursor + BigInt(i)) % TOTAL_BLOCKS;
        const idStr = idx.toString();
        if (!seenIds.has(idStr)) {
          seenIds.add(idStr);
          candidateIds.push(idStr);
        }
      }
    } else {
      const probeLimit = requestedCount + 12;
      for (let i = 0; i < probeLimit; i++) {
        const idx = generateRandomBlockIndex();
        const idStr = idx.toString();
        if (!seenIds.has(idStr)) {
          seenIds.add(idStr);
          candidateIds.push(idStr);
        }
      }
    }

    const resultBlocks = await runTransaction(db, async (tx): Promise<LeasedBlockPayload[]> => {
      const txSessionSnap = await tx.get(sessionRef);
      if (!txSessionSnap.exists()) {
        throw new Error('Relace pro tuto adresu neexistuje.');
      }
      const s = txSessionSnap.data() as FirestoreSessionDoc;
      const txDeviceSnap = await tx.get(deviceRef);

      const ownSnaps = await Promise.all(ownLeaseRefs.map((ref) => tx.get(ref)));
      const staleSnaps = await Promise.all(staleLeaseRefs.map((ref) => tx.get(ref)));
      const candidateRefs = candidateIds.map((id) => doc(blocksCol, id));
      const candidateSnaps = await Promise.all(candidateRefs.map((ref) => tx.get(ref)));

      // Upsert device record cleanly
      const prevDev = txDeviceSnap.exists() ? (txDeviceSnap.data() as FirestoreDeviceDoc) : null;
      const nextRate =
        params.rateKps !== undefined && Number.isFinite(params.rateKps) && params.rateKps >= 0
          ? params.rateKps
          : (prevDev?.lastRateKps ?? 0);

      tx.set(deviceRef, {
        id: params.deviceId,
        label: sanitizeLabel(params.deviceLabel),
        computeMode: params.computeMode === 'webgpu' ? 'webgpu' : 'cpu',
        gpuName: sanitizeGpuName(params.gpuName),
        lastRateKps: nextRate,
        keysChecked: prevDev ? Number(prevDev.keysChecked || 0) : 0,
        blocksCompleted: prevDev ? Number(prevDev.blocksCompleted || 0) : 0,
        lastSeenAt: serverTimestamp(),
      });

      // 1. Resume existing unfinished blocks owned by this device
      const activeOwnBlocks: LeasedBlockPayload[] = [];
      for (const snap of ownSnaps) {
        if (!snap.exists()) continue;
        const b = snap.data() as FirestoreBlockDoc;
        if (b.status === 'leased' && b.deviceId === params.deviceId && b.totalKeys === Number(BLOCK_SIZE)) {
          tx.update(snap.ref, {
            deviceId: params.deviceId,
            progressOffset: b.progressOffset,
            powOffsets: b.powOffsets,
            powCount: b.powCount,
            heartbeatAt: serverTimestamp(),
          });
          activeOwnBlocks.push(mapBlockDocToPayload(b));
        }
      }
      if (activeOwnBlocks.length > 0) {
        return activeOwnBlocks;
      }

      // 2. Reclaim stale lease (> 6 min without heartbeat)
      for (const snap of staleSnaps) {
        if (!snap.exists()) continue;
        const b = snap.data() as FirestoreBlockDoc;
        if (
          b.status === 'leased' &&
          b.totalKeys === Number(BLOCK_SIZE) &&
          timestampToMs(b.heartbeatAt) < Date.now() - STALE_LEASE_MS
        ) {
          tx.update(snap.ref, {
            deviceId: params.deviceId,
            progressOffset: b.progressOffset,
            powOffsets: b.powOffsets,
            powCount: b.powCount,
            heartbeatAt: serverTimestamp(),
          });
          return [
            {
              ...mapBlockDocToPayload(b),
              deviceId: params.deviceId,
            },
          ];
        }
      }

      if (Number(s.activeLeasedCount || 0) >= MAX_ACTIVE_LEASES_PER_SESSION) {
        throw new Error(
          'Dosáhli jste limitu aktivních rozpracovaných bloků pro tuto adresu. Dokončete prosím rozpracované bloky.',
        );
      }

      // 3. Allocate up to requestedCount fresh contiguous or random 2^29 blocks
      const createdBlocks: LeasedBlockPayload[] = [];
      let lastAllocatedIdx: bigint | null = null;
      const maxToCreate = Math.min(
        requestedCount,
        MAX_ACTIVE_LEASES_PER_SESSION - Number(s.activeLeasedCount || 0),
      );

      for (let i = 0; i < candidateSnaps.length && createdBlocks.length < maxToCreate; i++) {
        const snap = candidateSnaps[i];
        if (snap.exists()) {
          if (s.blockMode === 'sequential' && createdBlocks.length > 0) {
            break;
          }
          continue;
        }
        const idxBig = BigInt(candidateIds[i]);
        const range = blockIndexToRange(idxBig);
        const now = Date.now();
        tx.set(snap.ref, {
          blockIndex: range.blockIndexStr,
          startKeyHex: range.startKeyHex,
          endKeyHex: range.endKeyHex,
          status: 'leased',
          deviceId: params.deviceId,
          progressOffset: 0,
          totalKeys: range.totalKeys,
          powOffsets: [],
          powCount: 0,
          leasedAt: serverTimestamp(),
          heartbeatAt: serverTimestamp(),
          completedAt: null,
        });
        createdBlocks.push({
          id: range.blockIndexStr,
          blockIndex: range.blockIndexStr,
          startKeyHex: range.startKeyHex,
          endKeyHex: range.endKeyHex,
          progressOffset: 0,
          totalKeys: range.totalKeys,
          powCount: 0,
          status: 'leased',
          deviceId: params.deviceId,
          leasedAt: now,
          completedAt: null,
        });
        lastAllocatedIdx = idxBig;
      }

      if (createdBlocks.length === 0) {
        throw new Error('Nepodařilo se najít volný blok klíčového prostoru.');
      }

      const nextSeqCursor =
        s.blockMode === 'sequential' && lastAllocatedIdx !== null
          ? ((lastAllocatedIdx + 1n) % TOTAL_BLOCKS).toString()
          : s.seqCursor || '0';

      tx.update(sessionRef, {
        seqCursor: nextSeqCursor,
        totalKeysChecked: Number(s.totalKeysChecked || 0),
        completedBlocksCount: Number(s.completedBlocksCount || 0),
        activeLeasedCount: Math.min(64, Number(s.activeLeasedCount || 0) + createdBlocks.length),
        updatedAt: serverTimestamp(),
      });

      return createdBlocks;
    });

    return resultBlocks;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, blocksPath);
  }
}

export async function heartbeatBlockInFirestore(params: {
  btcAddress: string;
  blockIndex: string;
  deviceId: string;
}): Promise<{ active: boolean; status: 'leased' | 'completed' | 'reclaimed' }> {
  const blockPath = `sessions/${params.btcAddress}/blocks/${params.blockIndex}`;
  try {
    const blockRef = doc(db, 'sessions', params.btcAddress, 'blocks', params.blockIndex);
    const deviceRef = doc(db, 'sessions', params.btcAddress, 'devices', params.deviceId);

    return await runTransaction(db, async (tx) => {
      const [blockSnap, deviceSnap] = await Promise.all([tx.get(blockRef), tx.get(deviceRef)]);
      if (!blockSnap.exists()) {
        return { active: false, status: 'reclaimed' as const };
      }
      const b = blockSnap.data() as FirestoreBlockDoc;
      if (b.status === 'completed') {
        return { active: false, status: 'completed' as const };
      }
      if (b.deviceId !== params.deviceId) {
        return { active: false, status: 'reclaimed' as const };
      }

      tx.update(blockRef, {
        deviceId: b.deviceId,
        progressOffset: b.progressOffset,
        powOffsets: b.powOffsets,
        powCount: b.powCount,
        heartbeatAt: serverTimestamp(),
      });

      if (deviceSnap.exists()) {
        const d = deviceSnap.data() as FirestoreDeviceDoc;
        tx.update(deviceRef, {
          label: d.label,
          computeMode: d.computeMode,
          gpuName: d.gpuName,
          lastRateKps: d.lastRateKps,
          keysChecked: d.keysChecked,
          blocksCompleted: d.blocksCompleted,
          lastSeenAt: serverTimestamp(),
        });
      }

      return { active: true, status: 'leased' as const };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, blockPath);
  }
}

export async function checkpointBlockInFirestore(params: {
  btcAddress: string;
  blockIndex: string;
  deviceId: string;
  progressOffset: number;
  rateKps: number;
  powOffsets: number[];
}): Promise<{ powCount: number }> {
  const blockPath = `sessions/${params.btcAddress}/blocks/${params.blockIndex}`;
  try {
    const addressHash = await sha256Hex(params.btcAddress);
    const maskedAddress = maskBtcAddress(params.btcAddress);

    const sectorIdx = blockIndexToSectorIndex(params.blockIndex);
    const sessionRef = doc(db, 'sessions', params.btcAddress);
    const blockRef = doc(db, 'sessions', params.btcAddress, 'blocks', params.blockIndex);
    const deviceRef = doc(db, 'sessions', params.btcAddress, 'devices', params.deviceId);
    const sectorRef = doc(db, 'sessions', params.btcAddress, 'sectors', String(sectorIdx));
    const leaderboardRef = doc(db, 'leaderboard', addressHash);

    return await runTransaction(db, async (tx) => {
      const [sessionSnap, blockSnap, deviceSnap, sectorSnap, lbSnap] = await Promise.all([
        tx.get(sessionRef),
        tx.get(blockRef),
        tx.get(deviceRef),
        tx.get(sectorRef),
        tx.get(leaderboardRef),
      ]);

      if (!sessionSnap.exists()) throw new Error('Relace nenalezena.');
      if (!blockSnap.exists()) return { powCount: 0 };

      const s = sessionSnap.data() as FirestoreSessionDoc;
      const b = blockSnap.data() as FirestoreBlockDoc;
      if (b.status === 'completed') return { powCount: b.powCount };
      if (b.deviceId !== params.deviceId) {
        throw new Error('Tento blok mezitím po delší neaktivitě převzalo jiné vaše zařízení.');
      }

      const mergedOffsets = sanitizePowOffsets(
        b.powOffsets || [],
        params.powOffsets || [],
        b.startKeyHex,
        b.totalKeys,
      );

      let clampedOffset = Math.max(
        b.progressOffset,
        Math.min(b.totalKeys, Math.floor(params.progressOffset)),
      );
      if (b.totalKeys >= Number(BLOCK_SIZE) && mergedOffsets.length === 0) {
        const capWithoutPow = Math.floor(b.totalKeys * 0.6);
        clampedOffset = Math.min(clampedOffset, Math.max(b.progressOffset, capWithoutPow));
      }

      const deltaKeys = Math.max(0, clampedOffset - b.progressOffset);
      const nextSessionTotal = Number(s.totalKeysChecked || 0) + deltaKeys;

      tx.update(blockRef, {
        deviceId: params.deviceId,
        progressOffset: clampedOffset,
        powOffsets: mergedOffsets,
        powCount: mergedOffsets.length,
        heartbeatAt: serverTimestamp(),
      });

      const prevSector = sectorSnap.exists() ? (sectorSnap.data() as FirestoreSectorDoc) : null;
      if (deltaKeys > 0 || (prevSector === null && clampedOffset > 0)) {
        if (prevSector) {
          tx.update(sectorRef, {
            scannedKeys: Number(prevSector.scannedKeys || 0) + deltaKeys,
            completedBlocksCount: Number(prevSector.completedBlocksCount || 0),
            updatedAt: serverTimestamp(),
          });
        } else {
          tx.set(sectorRef, {
            sectorIndex: String(sectorIdx),
            scannedKeys: Math.min(Number(BLOCK_SIZE), clampedOffset),
            completedBlocksCount: 0,
            updatedAt: serverTimestamp(),
          });
        }
      }

      const safeRate = Number.isFinite(params.rateKps) && params.rateKps >= 0 ? params.rateKps : 0;
      if (deviceSnap.exists()) {
        const d = deviceSnap.data() as FirestoreDeviceDoc;
        tx.update(deviceRef, {
          label: d.label,
          computeMode: d.computeMode,
          gpuName: d.gpuName,
          lastRateKps: safeRate,
          keysChecked: Number(d.keysChecked || 0) + deltaKeys,
          blocksCompleted: Number(d.blocksCompleted || 0),
          lastSeenAt: serverTimestamp(),
        });
      }

      tx.update(sessionRef, {
        seqCursor: s.seqCursor || '0',
        totalKeysChecked: nextSessionTotal,
        completedBlocksCount: Number(s.completedBlocksCount || 0),
        activeLeasedCount: Number(s.activeLeasedCount || 0),
        updatedAt: serverTimestamp(),
      });

      if (nextSessionTotal > 0 || Number(s.completedBlocksCount || 0) > 0 || Number(s.activeLeasedCount || 0) > 0) {
        if (lbSnap.exists()) {
          tx.update(leaderboardRef, {
            totalKeysChecked: nextSessionTotal,
            completedBlocksCount: Number(s.completedBlocksCount || 0),
            activeBlocksCount: Number(s.activeLeasedCount || 0),
            lastActivityAt: serverTimestamp(),
          });
        } else if (deltaKeys <= Number(BLOCK_SIZE) && nextSessionTotal <= Number(BLOCK_SIZE)) {
          tx.set(leaderboardRef, {
            maskedAddress,
            addressType: s.addressType,
            totalKeysChecked: nextSessionTotal,
            completedBlocksCount: Number(s.completedBlocksCount || 0),
            activeBlocksCount: Number(s.activeLeasedCount || 0),
            lastActivityAt: serverTimestamp(),
          });
        }
      }

      return { powCount: mergedOffsets.length };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, blockPath);
  }
}

export async function completeBlockInFirestore(params: {
  btcAddress: string;
  blockIndex: string;
  deviceId: string;
  rateKps: number;
  powOffsets: number[];
}): Promise<SessionData | null> {
  const blockPath = `sessions/${params.btcAddress}/blocks/${params.blockIndex}`;
  try {
    const addressHash = await sha256Hex(params.btcAddress);
    const maskedAddress = maskBtcAddress(params.btcAddress);

    const sectorIdx = blockIndexToSectorIndex(params.blockIndex);
    const sessionRef = doc(db, 'sessions', params.btcAddress);
    const blockRef = doc(db, 'sessions', params.btcAddress, 'blocks', params.blockIndex);
    const deviceRef = doc(db, 'sessions', params.btcAddress, 'devices', params.deviceId);
    const sectorRef = doc(db, 'sessions', params.btcAddress, 'sectors', String(sectorIdx));
    const leaderboardRef = doc(db, 'leaderboard', addressHash);

    await runTransaction(db, async (tx) => {
      const [sessionSnap, blockSnap, deviceSnap, sectorSnap, lbSnap] = await Promise.all([
        tx.get(sessionRef),
        tx.get(blockRef),
        tx.get(deviceRef),
        tx.get(sectorRef),
        tx.get(leaderboardRef),
      ]);

      if (!sessionSnap.exists()) throw new Error('Relace nenalezena.');
      if (!blockSnap.exists()) return;

      const s = sessionSnap.data() as FirestoreSessionDoc;
      const b = blockSnap.data() as FirestoreBlockDoc;
      if (b.status === 'completed') return;
      if (b.deviceId !== params.deviceId) {
        throw new Error('Tento blok mezitím po delší neaktivitě převzalo jiné vaše zařízení.');
      }

      const mergedOffsets = sanitizePowOffsets(
        b.powOffsets || [],
        params.powOffsets || [],
        b.startKeyHex,
        b.totalKeys,
      );
      const requiredShares = getRequiredPowShares(b.totalKeys, MIN_POW_SHARES_FULL_BLOCK);
      if (mergedOffsets.length < requiredShares) {
        throw new Error(
          `Dokončení bloku vyžaduje kryptografické důkazy výpočtu (doloženo ${mergedOffsets.length}/${requiredShares} PoW podílů).`,
        );
      }

      const remainingKeys = Math.max(0, b.totalKeys - b.progressOffset);
      const nextSessionTotal = Number(s.totalKeysChecked || 0) + remainingKeys;
      const nextCompleted = Number(s.completedBlocksCount || 0) + 1;
      const nextActiveLeased = Math.max(0, Number(s.activeLeasedCount || 0) - 1);

      tx.update(blockRef, {
        status: 'completed',
        deviceId: params.deviceId,
        progressOffset: b.totalKeys,
        powOffsets: mergedOffsets,
        powCount: mergedOffsets.length,
        heartbeatAt: serverTimestamp(),
        completedAt: serverTimestamp(),
      });

      const prevSector = sectorSnap.exists() ? (sectorSnap.data() as FirestoreSectorDoc) : null;
      if (prevSector) {
        tx.update(sectorRef, {
          scannedKeys: Number(prevSector.scannedKeys || 0) + remainingKeys,
          completedBlocksCount: Number(prevSector.completedBlocksCount || 0) + 1,
          updatedAt: serverTimestamp(),
        });
      } else {
        tx.set(sectorRef, {
          sectorIndex: String(sectorIdx),
          scannedKeys: Math.min(Number(BLOCK_SIZE), b.totalKeys),
          completedBlocksCount: 1,
          updatedAt: serverTimestamp(),
        });
      }

      const safeRate = Number.isFinite(params.rateKps) && params.rateKps >= 0 ? params.rateKps : 0;
      if (deviceSnap.exists()) {
        const d = deviceSnap.data() as FirestoreDeviceDoc;
        tx.update(deviceRef, {
          label: d.label,
          computeMode: d.computeMode,
          gpuName: d.gpuName,
          lastRateKps: safeRate,
          keysChecked: Number(d.keysChecked || 0) + remainingKeys,
          blocksCompleted: Number(d.blocksCompleted || 0) + 1,
          lastSeenAt: serverTimestamp(),
        });
      }

      tx.update(sessionRef, {
        seqCursor: s.seqCursor || '0',
        totalKeysChecked: nextSessionTotal,
        completedBlocksCount: nextCompleted,
        activeLeasedCount: nextActiveLeased,
        updatedAt: serverTimestamp(),
      });

      if (lbSnap.exists()) {
        tx.update(leaderboardRef, {
          totalKeysChecked: nextSessionTotal,
          completedBlocksCount: nextCompleted,
          activeBlocksCount: nextActiveLeased,
          lastActivityAt: serverTimestamp(),
        });
      } else if (nextSessionTotal <= Number(BLOCK_SIZE)) {
        tx.set(leaderboardRef, {
          maskedAddress,
          addressType: s.addressType,
          totalKeysChecked: nextSessionTotal,
          completedBlocksCount: nextCompleted,
          activeBlocksCount: nextActiveLeased,
          lastActivityAt: serverTimestamp(),
        });
      }
    });

    return await getSessionSummaryByAddress(params.btcAddress);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, blockPath);
  }
}

export async function recordRelaySubmissionInFirestore(params: {
  btcAddress: string;
  txid: string;
  userSats: string;
  adminSats: string;
  feeSats: string;
  isDryRun: boolean;
  summaryText: string;
}): Promise<void> {
  const relayPath = `sessions/${params.btcAddress}/relay_submissions/${params.txid}`;
  try {
    await setDoc(doc(db, 'sessions', params.btcAddress, 'relay_submissions', params.txid), {
      txid: params.txid,
      userSats: params.userSats,
      adminSats: params.adminSats,
      feeSats: params.feeSats,
      isDryRun: params.isDryRun,
      summaryText: params.summaryText.slice(0, 1000),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, relayPath);
  }
}

export async function getPublicLeaderboardFromFirestore(limitCount = 50): Promise<PublicLeaderboardResponse> {
  const lbPath = 'leaderboard';
  try {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(Number.isFinite(limitCount) ? limitCount : 50)));
    const snap = await getDocs(
      query(
        collection(db, 'leaderboard'),
        where('totalKeysChecked', '>=', 0),
        orderBy('totalKeysChecked', 'desc'),
        limit(safeLimit),
      ),
    );

    const now = Date.now();
    const onlineCutoff = now - ONLINE_CUTOFF_MS;

    const validDocs = snap.docs
      .map((d) => d.data() as FirestoreLeaderboardDoc)
      .filter((r) => Number(r.totalKeysChecked || 0) > 0 || Number(r.completedBlocksCount || 0) > 0);

    let onlineDevicesCount = 0;
    const entries: PublicLeaderboardEntry[] = validDocs.map((r, index) => {
      const checked = Number(r.totalKeysChecked || 0);
      const lastActivityAt = timestampToMs(r.lastActivityAt, 0);
      if (lastActivityAt >= onlineCutoff) {
        onlineDevicesCount += Math.max(1, Number(r.activeBlocksCount || 0));
      }
      return {
        rank: index + 1,
        maskedAddress: r.maskedAddress,
        addressType: r.addressType,
        totalKeysChecked: checked,
        completedBlocksCount: Number(r.completedBlocksCount || 0),
        activeBlocksCount: Number(r.activeBlocksCount || 0),
        progressPercent: calculateKeyspaceProgressPercent(checked),
        lastActivityAt,
      };
    });

    const top = entries[0];
    return {
      entries,
      summary: {
        participantsCount: entries.length,
        onlineDevicesCount,
        topKeysChecked: top ? top.totalKeysChecked : 0,
        topCompletedBlocks: top ? top.completedBlocksCount : 0,
        topProgressPercent: top ? top.progressPercent : 0,
      },
      generatedAt: now,
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, lbPath);
  }
}
