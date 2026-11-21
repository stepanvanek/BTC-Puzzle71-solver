import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { privateKeyToHash160Hex } from '../src/shared/btcTx.ts';
import { maskBtcAddress } from '../src/shared/btcAddress.ts';
import {
  BLOCK_SIZE,
  BLOCK_SIZE_BITS,
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
} from '../src/shared/puzzle71.ts';
import type { PublicLeaderboardEntry, PublicLeaderboardResponse } from '../src/types/api.ts';
import { calculateKeyspaceProgressPercent } from '../src/utils/keyspaceStats.ts';

export interface UserSessionRow {
  id: string;
  share_token: string;
  btc_address: string;
  address_type: string;
  block_mode: BlockSelectionMode;
  seq_cursor: string;
  created_at: number;
}

export interface DeviceRow {
  id: string;
  session_id: string;
  label: string;
  compute_mode: string;
  gpu_name: string;
  last_rate_kps: number;
  keys_checked: number;
  blocks_completed: number;
  last_seen_at: number;
}

export interface LeasedBlock {
  id: number;
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

export interface SessionSummary {
  session: {
    id: string;
    shareToken: string;
    btcAddress: string;
    addressType: string;
    createdAt: number;
  };
  strategy: {
    blockMode: BlockSelectionMode;
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
  recentBlocks: LeasedBlock[];
}

export interface Puzzle71StoreOptions {
  powHexPrefix?: string;
  minPowSharesFullBlock?: number;
}

const MAX_ACTIVE_LEASES_PER_SESSION = 32;
const MAX_STORED_POW_OFFSETS = 64;
const MAX_INCOMING_POW_OFFSETS = 32;
const STALE_LEASE_MS = 360_000; // 6 minutes without heartbeat

function generateShareToken(): string {
  return crypto.randomBytes(6).toString('base64url'); // 8-10 clean URL-safe chars
}

function generateRandomBlockIndex(): bigint {
  // TOTAL_BLOCKS = 2^41 (6 bytes -> mask top byte to 0x01 for uniform [0, 2^41 - 1])
  const buf = crypto.randomBytes(6);
  const raw =
    (BigInt(buf[0] & 0x01) << 40n) |
    (BigInt(buf[1]) << 32n) |
    (BigInt(buf[2]) << 24n) |
    (BigInt(buf[3]) << 16n) |
    (BigInt(buf[4]) << 8n) |
    BigInt(buf[5]);
  return raw % TOTAL_BLOCKS;
}

function parsePowOffsetsJson(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => Number.isInteger(n) && n >= 0);
  } catch {
    return [];
  }
}

export class Puzzle71Store {
  private db: Database.Database;
  private readonly powHexPrefix: string;
  private readonly minPowSharesFullBlock: number;

  constructor(dbPath: string, options: Puzzle71StoreOptions = {}) {
    this.powHexPrefix = (options.powHexPrefix ?? POW_HASH160_HEX_PREFIX).toLowerCase();
    this.minPowSharesFullBlock = options.minPowSharesFullBlock ?? MIN_POW_SHARES_FULL_BLOCK;
    this.db = this.openHealthyDatabase(dbPath);
    this.migrate();
  }

  private openHealthyDatabase(dbPath: string): Database.Database {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    const tryOpen = (): Database.Database => {
      const db = new Database(dbPath);
      db.pragma('busy_timeout = 5000');
      if (dbPath !== ':memory:') {
        const quick = db.pragma('quick_check(1)', { simple: true });
        if (quick !== 'ok') {
          db.close();
          throw new Error(`SQLite quick_check failed: ${String(quick)}`);
        }
        db.pragma('journal_mode = DELETE');
        db.pragma('synchronous = NORMAL');
      }
      db.pragma('foreign_keys = ON');
      return db;
    };

    try {
      return tryOpen();
    } catch (err) {
      if (dbPath === ':memory:') {
        throw err;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      const errCode = (err as { code?: string } | null)?.code ?? '';
      if (errCode === 'SQLITE_BUSY' || errCode === 'SQLITE_LOCKED' || /locked|busy/i.test(errMsg)) {
        // Transient lock during rapid dev-server restart; wait briefly and retry once
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        return tryOpen();
      }
      console.warn(
        `[Puzzle71Store] Detekována poškozená SQLite databáze (${errMsg}). Vytvářím novou čistou databázi...`,
      );
      const suffix = `.corrupt-${Date.now()}`;
      for (const ext of ['', '-wal', '-shm', '-journal']) {
        const file = `${dbPath}${ext}`;
        if (fs.existsSync(file)) {
          try {
            if (ext === '') {
              fs.renameSync(file, `${file}${suffix}`);
            } else {
              fs.unlinkSync(file);
            }
          } catch {
            try {
              fs.unlinkSync(file);
            } catch {
              // ignore cleanup failure
            }
          }
        }
      }
      return tryOpen();
    }
  }

  private hasColumn(tableName: string, columnName: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === columnName);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,
        share_token TEXT UNIQUE NOT NULL,
        btc_address TEXT NOT NULL,
        address_type TEXT NOT NULL,
        block_mode TEXT NOT NULL DEFAULT 'random',
        seq_cursor TEXT NOT NULL DEFAULT '0',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        label TEXT NOT NULL,
        compute_mode TEXT NOT NULL,
        gpu_name TEXT NOT NULL,
        last_rate_kps REAL NOT NULL DEFAULT 0,
        keys_checked INTEGER NOT NULL DEFAULT 0,
        blocks_completed INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES user_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS searched_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        block_index TEXT NOT NULL,
        start_key_hex TEXT NOT NULL,
        end_key_hex TEXT NOT NULL,
        status TEXT NOT NULL,
        device_id TEXT NOT NULL,
        progress_offset INTEGER NOT NULL DEFAULT 0,
        total_keys INTEGER NOT NULL,
        pow_offsets_json TEXT NOT NULL DEFAULT '[]',
        block_size_bits INTEGER NOT NULL DEFAULT ${Number(BLOCK_SIZE_BITS)},
        leased_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(session_id, block_index),
        FOREIGN KEY (session_id) REFERENCES user_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_blocks_session_status
        ON searched_blocks(session_id, status, heartbeat_at);

      CREATE TABLE IF NOT EXISTS relay_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        txid TEXT NOT NULL,
        raw_tx_hex TEXT NOT NULL,
        user_sats TEXT NOT NULL,
        admin_sats TEXT NOT NULL,
        fee_sats TEXT NOT NULL,
        is_dry_run INTEGER NOT NULL,
        relay_results_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES user_sessions(id) ON DELETE CASCADE
      );
    `);

    if (!this.hasColumn('user_sessions', 'block_mode')) {
      this.db.exec(`ALTER TABLE user_sessions ADD COLUMN block_mode TEXT NOT NULL DEFAULT 'random'`);
    }
    if (!this.hasColumn('user_sessions', 'seq_cursor')) {
      this.db.exec(`ALTER TABLE user_sessions ADD COLUMN seq_cursor TEXT NOT NULL DEFAULT '0'`);
    }
    if (!this.hasColumn('searched_blocks', 'pow_offsets_json')) {
      this.db.exec(`ALTER TABLE searched_blocks ADD COLUMN pow_offsets_json TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!this.hasColumn('searched_blocks', 'block_size_bits')) {
      this.db.exec(`ALTER TABLE searched_blocks ADD COLUMN block_size_bits INTEGER NOT NULL DEFAULT 24`);
    }

    // Namespace legacy 2^24 blocks so new 2^29 sequential block indices 0..2^41-1 never collide
    this.db.exec(`
      UPDATE searched_blocks
      SET block_index = 'legacy24:' || block_index,
          block_size_bits = 24
      WHERE total_keys != ${Number(BLOCK_SIZE)}
        AND block_index NOT LIKE 'legacy24:%';
    `);
    // Clean up unstarted legacy 2^24 leases so devices cleanly receive new 2^29 blocks
    this.db.exec(`
      DELETE FROM searched_blocks
      WHERE total_keys != ${Number(BLOCK_SIZE)}
        AND status = 'leased'
        AND progress_offset = 0;
    `);
  }

  createOrGetSession(btcAddress: string, addressType: string): UserSessionRow {
    const existing = this.db
      .prepare('SELECT * FROM user_sessions WHERE btc_address = ? LIMIT 1')
      .get(btcAddress) as UserSessionRow | undefined;

    if (existing) {
      return existing;
    }

    const id = crypto.randomUUID();
    let shareToken = generateShareToken();
    while (
      this.db.prepare('SELECT 1 FROM user_sessions WHERE share_token = ?').get(shareToken)
    ) {
      shareToken = generateShareToken();
    }

    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO user_sessions
         (id, share_token, btc_address, address_type, block_mode, seq_cursor, created_at)
         VALUES (?, ?, ?, ?, 'random', '0', ?)`,
      )
      .run(id, shareToken, btcAddress, addressType, createdAt);

    return {
      id,
      share_token: shareToken,
      btc_address: btcAddress,
      address_type: addressType,
      block_mode: 'random',
      seq_cursor: '0',
      created_at: createdAt,
    };
  }

  getSessionByToken(shareToken: string): UserSessionRow | null {
    const row = this.db
      .prepare('SELECT * FROM user_sessions WHERE share_token = ? LIMIT 1')
      .get(shareToken) as UserSessionRow | undefined;
    return row ?? null;
  }

  updateSessionStrategy(params: {
    shareToken: string;
    blockMode: BlockSelectionMode;
    startPercent?: number;
    deviceId?: string;
  }): SessionSummary {
    const session = this.getSessionByToken(params.shareToken);
    if (!session) {
      throw new Error('Relace pro tuto URL neexistuje.');
    }
    if (params.blockMode !== 'random' && params.blockMode !== 'sequential') {
      throw new Error('Neplatný režim výběru bloků.');
    }

    const tx = this.db.transaction(() => {
      let nextCursor = session.seq_cursor || '0';
      if (params.blockMode === 'sequential' && params.startPercent !== undefined) {
        if (!Number.isFinite(params.startPercent) || params.startPercent < 0 || params.startPercent > 100) {
          throw new Error('Startovní pozice musí být v rozsahu 0 až 100 %.');
        }
        nextCursor = percentToBlockIndex(params.startPercent).toString();
      }

      this.db
        .prepare('UPDATE user_sessions SET block_mode = ?, seq_cursor = ? WHERE id = ?')
        .run(params.blockMode, nextCursor, session.id);

      // If this device has an unstarted 0-progress lease, release it so the next start immediately applies the new strategy
      if (params.deviceId) {
        this.db
          .prepare(
            `DELETE FROM searched_blocks
             WHERE session_id = ? AND device_id = ? AND status = 'leased' AND progress_offset = 0`,
          )
          .run(session.id, params.deviceId);
      }
    });

    tx();
    const summary = this.getSessionSummary(params.shareToken);
    if (!summary) {
      throw new Error('Relace nebyla nalezena.');
    }
    return summary;
  }

  upsertDevice(params: {
    sessionId: string;
    deviceId: string;
    label: string;
    computeMode: string;
    gpuName: string;
    rateKps?: number;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO devices (id, session_id, label, compute_mode, gpu_name, last_rate_kps, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           label = excluded.label,
           compute_mode = excluded.compute_mode,
           gpu_name = excluded.gpu_name,
           last_rate_kps = COALESCE(?, devices.last_rate_kps),
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        params.deviceId,
        params.sessionId,
        params.label,
        params.computeMode,
        params.gpuName,
        params.rateKps ?? 0,
        now,
        params.rateKps ?? null,
      );
  }

  /**
   * Atomically leases one or more contiguous 2^29 blocks (scaled by measured speed) for the given session & device.
   * Preserves canonical 2^29 block grid in SQLite with zero fragmentation and zero duplicate work.
   */
  leaseBlockBatch(params: {
    shareToken: string;
    deviceId: string;
    deviceLabel: string;
    computeMode: string;
    gpuName: string;
    desiredCount?: number;
    rateKps?: number;
  }): LeasedBlock[] {
    const session = this.getSessionByToken(params.shareToken);
    if (!session) {
      throw new Error('Relace pro tuto URL neexistuje.');
    }

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

    const tx = this.db.transaction((): LeasedBlock[] => {
      const now = Date.now();
      this.upsertDevice({
        sessionId: session.id,
        deviceId: params.deviceId,
        label: params.deviceLabel,
        computeMode: params.computeMode,
        gpuName: params.gpuName,
        rateKps: params.rateKps,
      });

      // 1. Resume ALL existing unfinished blocks owned by this exact device in order
      const ownLeases = this.db
        .prepare(
          `SELECT * FROM searched_blocks
           WHERE session_id = ? AND device_id = ? AND status = 'leased' AND total_keys = ?
           ORDER BY leased_at ASC, id ASC`,
        )
        .all(session.id, params.deviceId, Number(BLOCK_SIZE)) as Array<{
        id: number;
        block_index: string;
        start_key_hex: string;
        end_key_hex: string;
        progress_offset: number;
        total_keys: number;
        pow_offsets_json: string;
        status: 'leased' | 'completed';
        device_id: string;
        leased_at: number;
        completed_at: number | null;
      }>;

      if (ownLeases.length > 0) {
        this.db
          .prepare(
            `UPDATE searched_blocks SET heartbeat_at = ?
             WHERE session_id = ? AND device_id = ? AND status = 'leased' AND total_keys = ?`,
          )
          .run(now, session.id, params.deviceId, Number(BLOCK_SIZE));

        return ownLeases.map((ownLease) => ({
          id: ownLease.id,
          blockIndex: ownLease.block_index,
          startKeyHex: ownLease.start_key_hex,
          endKeyHex: ownLease.end_key_hex,
          progressOffset: ownLease.progress_offset,
          totalKeys: ownLease.total_keys,
          powCount: parsePowOffsetsJson(ownLease.pow_offsets_json).length,
          status: ownLease.status,
          deviceId: ownLease.device_id,
          leasedAt: ownLease.leased_at,
          completedAt: ownLease.completed_at,
        }));
      }

      // 2. Reclaim stale lease (> 6 minutes without heartbeat from another closed tab)
      const staleCutoff = now - STALE_LEASE_MS;
      const staleLease = this.db
        .prepare(
          `SELECT * FROM searched_blocks
           WHERE session_id = ? AND status = 'leased' AND total_keys = ? AND heartbeat_at < ?
           ORDER BY heartbeat_at ASC LIMIT 1`,
        )
        .get(session.id, Number(BLOCK_SIZE), staleCutoff) as
        | {
            id: number;
            block_index: string;
            start_key_hex: string;
            end_key_hex: string;
            progress_offset: number;
            total_keys: number;
            pow_offsets_json: string;
            leased_at: number;
          }
        | undefined;

      if (staleLease) {
        this.db
          .prepare('UPDATE searched_blocks SET device_id = ?, heartbeat_at = ? WHERE id = ?')
          .run(params.deviceId, now, staleLease.id);
        return [
          {
            id: staleLease.id,
            blockIndex: staleLease.block_index,
            startKeyHex: staleLease.start_key_hex,
            endKeyHex: staleLease.end_key_hex,
            progressOffset: staleLease.progress_offset,
            totalKeys: staleLease.total_keys,
            powCount: parsePowOffsetsJson(staleLease.pow_offsets_json).length,
            status: 'leased',
            deviceId: params.deviceId,
            leasedAt: staleLease.leased_at,
            completedAt: null,
          },
        ];
      }

      // 3. Cap active uncompleted leases per session to protect SQLite from device-ID spam
      const activeCountRow = this.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM searched_blocks
           WHERE session_id = ? AND status = 'leased' AND total_keys = ?`,
        )
        .get(session.id, Number(BLOCK_SIZE)) as { cnt: number };

      if (activeCountRow.cnt >= MAX_ACTIVE_LEASES_PER_SESSION) {
        throw new Error(
          `Byl dosažen limit ${MAX_ACTIVE_LEASES_PER_SESSION} současně rozpracovaných bloků bez dokončení.`,
        );
      }

      const headroom = MAX_ACTIVE_LEASES_PER_SESSION - activeCountRow.cnt;
      const batchTarget = Math.min(requestedCount, headroom);

      const freshSession = this.db
        .prepare('SELECT block_mode, seq_cursor FROM user_sessions WHERE id = ?')
        .get(session.id) as { block_mode: BlockSelectionMode; seq_cursor: string };

      const checkStmt = this.db.prepare(
        'SELECT 1 FROM searched_blocks WHERE session_id = ? AND block_index = ?',
      );

      const chosenIndices: bigint[] = [];
      if (freshSession.block_mode === 'sequential') {
        let cursor = 0n;
        try {
          cursor = BigInt(freshSession.seq_cursor || '0');
          if (cursor < 0n || cursor >= TOTAL_BLOCKS) cursor = 0n;
        } catch {
          cursor = 0n;
        }
        for (let step = 0n; step < 2048n && chosenIndices.length < batchTarget; step++) {
          const candidateIdx = (cursor + step) % TOTAL_BLOCKS;
          const exists = checkStmt.get(session.id, candidateIdx.toString());
          if (!exists) {
            chosenIndices.push(candidateIdx);
          } else if (chosenIndices.length > 0) {
            // Keep batch contiguous; stop before already-occupied gap and resume next batch past it
            break;
          }
        }
        if (chosenIndices.length > 0) {
          const lastChosen = chosenIndices[chosenIndices.length - 1];
          const nextCursor = ((lastChosen + 1n) % TOTAL_BLOCKS).toString();
          this.db
            .prepare('UPDATE user_sessions SET seq_cursor = ? WHERE id = ?')
            .run(nextCursor, session.id);
        }
      } else {
        for (let attempt = 0; attempt < 64; attempt++) {
          const baseIdx = generateRandomBlockIndex();
          if (checkStmt.get(session.id, baseIdx.toString())) {
            continue;
          }
          chosenIndices.push(baseIdx);
          for (let k = 1n; k < BigInt(batchTarget); k++) {
            const nextIdx = (baseIdx + k) % TOTAL_BLOCKS;
            if (checkStmt.get(session.id, nextIdx.toString())) {
              break;
            }
            chosenIndices.push(nextIdx);
          }
          break;
        }
      }

      if (chosenIndices.length === 0) {
        throw new Error('Nepodařilo se přidělit unikátní blok prostoru klíčů.');
      }

      const insertStmt = this.db.prepare(
        `INSERT INTO searched_blocks
         (session_id, block_index, start_key_hex, end_key_hex, status, device_id, progress_offset, total_keys, pow_offsets_json, block_size_bits, leased_at, heartbeat_at)
         VALUES (?, ?, ?, ?, 'leased', ?, 0, ?, '[]', ?, ?, ?)`,
      );

      const results: LeasedBlock[] = [];
      for (const chosenIdx of chosenIndices) {
        const range = blockIndexToRange(chosenIdx);
        const candidateStr = chosenIdx.toString();
        const info = insertStmt.run(
          session.id,
          candidateStr,
          range.startKeyHex,
          range.endKeyHex,
          params.deviceId,
          Number(BLOCK_SIZE),
          Number(BLOCK_SIZE_BITS),
          now,
          now,
        );
        results.push({
          id: Number(info.lastInsertRowid),
          blockIndex: candidateStr,
          startKeyHex: range.startKeyHex,
          endKeyHex: range.endKeyHex,
          progressOffset: 0,
          totalKeys: Number(BLOCK_SIZE),
          powCount: 0,
          status: 'leased',
          deviceId: params.deviceId,
          leasedAt: now,
          completedAt: null,
        });
      }

      return results;
    });

    return tx();
  }

  /**
   * Convenience wrapper returning the primary leased block for single-block callers.
   */
  leaseUniqueBlock(params: {
    shareToken: string;
    deviceId: string;
    deviceLabel: string;
    computeMode: string;
    gpuName: string;
  }): LeasedBlock {
    return this.leaseBlockBatch({ ...params, desiredCount: 1 })[0];
  }

  private verifyAndMergePowOffsets(
    row: {
      start_key_hex: string;
      total_keys: number;
      pow_offsets_json: string;
    },
    incomingOffsets: number[] | undefined,
  ): number[] {
    const existing = parsePowOffsetsJson(row.pow_offsets_json);
    const merged = new Set<number>(existing);

    if (!incomingOffsets || incomingOffsets.length === 0) {
      return [...merged];
    }

    if (incomingOffsets.length > MAX_INCOMING_POW_OFFSETS) {
      throw new Error('Příliš mnoho PoW důkazů v jednom požadavku.');
    }

    const startKey = BigInt(row.start_key_hex);
    for (const rawOffset of incomingOffsets) {
      const offset = Number(rawOffset);
      if (!Number.isInteger(offset) || offset < 0 || offset >= row.total_keys) {
        throw new Error('Neplatný offset PoW důkazu mimo přidělený blok.');
      }
      if (merged.has(offset)) {
        continue;
      }
      const key = startKey + BigInt(offset);
      const hashHex = privateKeyToHash160Hex(key);
      if (!hashHex.startsWith(this.powHexPrefix)) {
        throw new Error('Neplatný kryptografický důkaz výpočtu (Hash160 PoW nesouhlasí).');
      }
      if (merged.size < MAX_STORED_POW_OFFSETS) {
        merged.add(offset);
      }
    }

    return [...merged];
  }

  heartbeatBlock(params: {
    shareToken: string;
    blockId: number;
    deviceId: string;
  }): { active: boolean; powCount: number; status: 'leased' | 'completed' | 'reclaimed' } {
    const session = this.getSessionByToken(params.shareToken);
    if (!session) throw new Error('Relace nenalezena.');

    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT id, device_id, status, pow_offsets_json
         FROM searched_blocks WHERE id = ? AND session_id = ?`,
      )
      .get(params.blockId, session.id) as
      | {
          id: number;
          device_id: string;
          status: string;
          pow_offsets_json: string;
        }
      | undefined;

    if (!row || row.status === 'completed') {
      return {
        active: false,
        powCount: row ? parsePowOffsetsJson(row.pow_offsets_json).length : 0,
        status: 'completed',
      };
    }

    if (row.device_id !== params.deviceId) {
      return {
        active: false,
        powCount: parsePowOffsetsJson(row.pow_offsets_json).length,
        status: 'reclaimed',
      };
    }

    this.db
      .prepare(
        `UPDATE searched_blocks SET heartbeat_at = ?
         WHERE session_id = ? AND device_id = ? AND status = 'leased'`,
      )
      .run(now, session.id, params.deviceId);
    this.db
      .prepare('UPDATE devices SET last_seen_at = ? WHERE id = ? AND session_id = ?')
      .run(now, params.deviceId, session.id);

    return {
      active: true,
      powCount: parsePowOffsetsJson(row.pow_offsets_json).length,
      status: 'leased',
    };
  }

  checkpointBlock(params: {
    shareToken: string;
    blockId: number;
    deviceId: string;
    progressOffset: number;
    rateKps: number;
    powOffsets?: number[];
  }): { powCount: number } {
    const session = this.getSessionByToken(params.shareToken);
    if (!session) throw new Error('Relace nenalezena.');

    const tx = this.db.transaction((): { powCount: number } => {
      const now = Date.now();
      const row = this.db
        .prepare(
          `SELECT id, device_id, start_key_hex, progress_offset, total_keys, pow_offsets_json, status
           FROM searched_blocks WHERE id = ? AND session_id = ?`,
        )
        .get(params.blockId, session.id) as
        | {
            id: number;
            device_id: string;
            start_key_hex: string;
            progress_offset: number;
            total_keys: number;
            pow_offsets_json: string;
            status: string;
          }
        | undefined;

      if (!row || row.status === 'completed') {
        return { powCount: row ? parsePowOffsetsJson(row.pow_offsets_json).length : 0 };
      }

      if (row.device_id !== params.deviceId) {
        throw new Error('Tento blok mezitím po delší neaktivitě převzalo jiné vaše zařízení.');
      }

      const mergedOffsets = this.verifyAndMergePowOffsets(row, params.powOffsets);
      let clampedOffset = Math.max(
        row.progress_offset,
        Math.min(row.total_keys, Math.floor(params.progressOffset)),
      );

      // Guard against faking progress beyond 60% of a block without any cryptographic PoW proof
      if (row.total_keys >= Number(BLOCK_SIZE) && mergedOffsets.length === 0) {
        const capWithoutPow = Math.floor(row.total_keys * 0.6);
        clampedOffset = Math.min(clampedOffset, Math.max(row.progress_offset, capWithoutPow));
      }

      const deltaKeys = Math.max(0, clampedOffset - row.progress_offset);

      this.db
        .prepare(
          `UPDATE searched_blocks
           SET progress_offset = ?, pow_offsets_json = ?, heartbeat_at = ?, device_id = ?
           WHERE id = ?`,
        )
        .run(clampedOffset, JSON.stringify(mergedOffsets), now, params.deviceId, row.id);

      // Keep any other queued batch blocks owned by this device fresh while block 1 is actively running
      this.db
        .prepare(
          `UPDATE searched_blocks SET heartbeat_at = ?
           WHERE session_id = ? AND device_id = ? AND status = 'leased' AND id != ?`,
        )
        .run(now, session.id, params.deviceId, row.id);

      this.db
        .prepare(
          `UPDATE devices
           SET keys_checked = keys_checked + ?, last_rate_kps = ?, last_seen_at = ?
           WHERE id = ? AND session_id = ?`,
        )
        .run(deltaKeys, params.rateKps, now, params.deviceId, session.id);

      return { powCount: mergedOffsets.length };
    });

    return tx();
  }

  completeBlock(params: {
    shareToken: string;
    blockId: number;
    deviceId: string;
    rateKps: number;
    powOffsets?: number[];
  }): void {
    const session = this.getSessionByToken(params.shareToken);
    if (!session) throw new Error('Relace nenalezena.');

    const tx = this.db.transaction(() => {
      const now = Date.now();
      const row = this.db
        .prepare(
          `SELECT id, device_id, start_key_hex, progress_offset, total_keys, pow_offsets_json, status
           FROM searched_blocks WHERE id = ? AND session_id = ?`,
        )
        .get(params.blockId, session.id) as
        | {
            id: number;
            device_id: string;
            start_key_hex: string;
            progress_offset: number;
            total_keys: number;
            pow_offsets_json: string;
            status: string;
          }
        | undefined;

      if (!row || row.status === 'completed') return;

      if (row.device_id !== params.deviceId) {
        throw new Error('Tento blok mezitím po delší neaktivitě převzalo jiné vaše zařízení.');
      }

      const mergedOffsets = this.verifyAndMergePowOffsets(row, params.powOffsets);
      const requiredShares = getRequiredPowShares(row.total_keys, this.minPowSharesFullBlock);
      if (mergedOffsets.length < requiredShares) {
        throw new Error(
          `Dokončení bloku vyžaduje kryptografické důkazy výpočtu (doloženo ${mergedOffsets.length}/${requiredShares} PoW podílů).`,
        );
      }

      const remainingKeys = Math.max(0, row.total_keys - row.progress_offset);

      this.db
        .prepare(
          `UPDATE searched_blocks
           SET status = 'completed', progress_offset = total_keys, pow_offsets_json = ?, heartbeat_at = ?, completed_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(mergedOffsets), now, now, row.id);

      // Keep remaining queued batch blocks owned by this device fresh when transitioning to next block
      this.db
        .prepare(
          `UPDATE searched_blocks SET heartbeat_at = ?
           WHERE session_id = ? AND device_id = ? AND status = 'leased' AND id != ?`,
        )
        .run(now, session.id, params.deviceId, row.id);

      this.db
        .prepare(
          `UPDATE devices
           SET keys_checked = keys_checked + ?, blocks_completed = blocks_completed + 1, last_rate_kps = ?, last_seen_at = ?
           WHERE id = ? AND session_id = ?`,
        )
        .run(remainingKeys, params.rateKps, now, params.deviceId, session.id);
    });

    tx();
  }

  recordRelaySubmission(params: {
    shareToken: string;
    txid: string;
    rawTxHex: string;
    userSats: string;
    adminSats: string;
    feeSats: string;
    isDryRun: boolean;
    relayResultsJson: string;
  }): void {
    const session = this.getSessionByToken(params.shareToken);
    if (!session) return;
    this.db
      .prepare(
        `INSERT INTO relay_submissions
         (session_id, txid, raw_tx_hex, user_sats, admin_sats, fee_sats, is_dry_run, relay_results_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        params.txid,
        params.rawTxHex,
        params.userSats,
        params.adminSats,
        params.feeSats,
        params.isDryRun ? 1 : 0,
        params.relayResultsJson,
        Date.now(),
      );
  }

  getSessionSummary(shareToken: string): SessionSummary | null {
    const session = this.getSessionByToken(shareToken);
    if (!session) return null;

    const now = Date.now();
    const onlineCutoff = now - 45_000;

    const agg = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(progress_offset), 0) AS total_keys_checked,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count,
           COALESCE(SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END), 0) AS leased_count
         FROM searched_blocks
         WHERE session_id = ?`,
      )
      .get(session.id) as {
      total_keys_checked: number;
      completed_count: number;
      leased_count: number;
    };

    const deviceRows = this.db
      .prepare('SELECT * FROM devices WHERE session_id = ? ORDER BY last_seen_at DESC')
      .all(session.id) as DeviceRow[];

    const blockRows = this.db
      .prepare(
        `SELECT * FROM searched_blocks
         WHERE session_id = ?
         ORDER BY CASE WHEN status = 'leased' THEN 0 ELSE 1 END, leased_at DESC, id DESC
         LIMIT 40`,
      )
      .all(session.id) as Array<{
      id: number;
      block_index: string;
      start_key_hex: string;
      end_key_hex: string;
      status: 'leased' | 'completed';
      device_id: string;
      progress_offset: number;
      total_keys: number;
      pow_offsets_json: string;
      leased_at: number;
      completed_at: number | null;
    }>;

    let seqCursorBig = 0n;
    try {
      seqCursorBig = BigInt(session.seq_cursor || '0');
    } catch {
      seqCursorBig = 0n;
    }

    return {
      session: {
        id: session.id,
        shareToken: session.share_token,
        btcAddress: session.btc_address,
        addressType: session.address_type,
        createdAt: session.created_at,
      },
      strategy: {
        blockMode: session.block_mode === 'sequential' ? 'sequential' : 'random',
        seqCursor: seqCursorBig.toString(),
        seqPercent: blockIndexToPercent(seqCursorBig),
      },
      stats: {
        totalKeysChecked: agg.total_keys_checked,
        completedBlocksCount: agg.completed_count,
        activeLeasedCount: agg.leased_count,
        blockSizeKeys: Number(BLOCK_SIZE),
      },
      devices: deviceRows.map((d) => ({
        id: d.id,
        label: d.label,
        computeMode: d.compute_mode,
        gpuName: d.gpu_name,
        lastRateKps: d.last_rate_kps,
        keysChecked: d.keys_checked,
        blocksCompleted: d.blocks_completed,
        lastSeenAt: d.last_seen_at,
        isOnline: d.last_seen_at >= onlineCutoff,
      })),
      recentBlocks: blockRows.map((b) => ({
        id: b.id,
        blockIndex: b.block_index,
        startKeyHex: b.start_key_hex,
        endKeyHex: b.end_key_hex,
        status: b.status,
        deviceId: b.device_id,
        progressOffset: b.progress_offset,
        totalKeys: b.total_keys,
        powCount: parsePowOffsetsJson(b.pow_offsets_json).length,
        leasedAt: b.leased_at,
        completedAt: b.completed_at,
      })),
    };
  }

  getPublicLeaderboard(limit = 50): PublicLeaderboardResponse {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(Number.isFinite(limit) ? limit : 50)));
    const rows = this.db
      .prepare(
        `SELECT
           s.btc_address AS btc_address,
           s.address_type AS address_type,
           COALESCE(SUM(b.progress_offset), 0) AS total_keys_checked,
           COALESCE(SUM(CASE WHEN b.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_blocks_count,
           COALESCE(SUM(CASE WHEN b.status = 'leased' THEN 1 ELSE 0 END), 0) AS active_blocks_count,
           MAX(COALESCE(b.completed_at, b.heartbeat_at, b.leased_at, s.created_at)) AS last_activity_at
         FROM user_sessions s
         INNER JOIN searched_blocks b ON b.session_id = s.id
         GROUP BY s.id
         HAVING total_keys_checked > 0 OR completed_blocks_count > 0
         ORDER BY total_keys_checked DESC, completed_blocks_count DESC, last_activity_at DESC`,
      )
      .all() as Array<{
      btc_address: string;
      address_type: string;
      total_keys_checked: number;
      completed_blocks_count: number;
      active_blocks_count: number;
      last_activity_at: number;
    }>;

    const now = Date.now();
    const onlineCutoff = now - 45_000;
    const onlineRow = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM devices WHERE last_seen_at >= ?')
      .get(onlineCutoff) as { cnt: number };

    const entries: PublicLeaderboardEntry[] = rows.slice(0, safeLimit).map((r, index) => {
      const checked = Number(r.total_keys_checked || 0);
      return {
        rank: index + 1,
        maskedAddress: maskBtcAddress(r.btc_address),
        addressType: r.address_type,
        totalKeysChecked: checked,
        completedBlocksCount: Number(r.completed_blocks_count || 0),
        activeBlocksCount: Number(r.active_blocks_count || 0),
        progressPercent: calculateKeyspaceProgressPercent(checked),
        lastActivityAt: Number(r.last_activity_at || 0),
      };
    });

    const topRow = rows[0];
    const topKeysChecked = topRow ? Number(topRow.total_keys_checked || 0) : 0;
    const topCompletedBlocks = topRow ? Number(topRow.completed_blocks_count || 0) : 0;

    return {
      entries,
      summary: {
        participantsCount: rows.length,
        onlineDevicesCount: Number(onlineRow?.cnt || 0),
        topKeysChecked,
        topCompletedBlocks,
        topProgressPercent: calculateKeyspaceProgressPercent(topKeysChecked),
      },
      generatedAt: now,
    };
  }

  close(): void {
    this.db.close();
  }
}
