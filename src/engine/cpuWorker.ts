import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { privateKeyToHash160Hex } from '../shared/btcTx.ts';
import { createIncrementalBasePointCursor } from './computeProfile.ts';

export interface CpuScanBatchRequest {
  type: 'scan';
  id?: number;
  startKeyHex: string;
  count: number;
  targetHash160Hex: string;
}

export interface CpuScanBatchResult {
  type: 'result';
  id?: number;
  checked: number;
  foundKeyHex: string | null;
  powKeysHex: string[];
}

export interface DeriveAffineRequest {
  type: 'derive_affine';
  id: number;
  startKeyHex: string;
}

export interface DeriveAffineResult {
  type: 'derive_affine_result';
  id: number;
  xBytes: Uint8Array;
  yBytes: Uint8Array;
}

export interface VerifyCandidatesRequest {
  type: 'verify_candidates';
  id: number;
  targetHash160Hex: string;
  powPrefix: string;
  hitCandidatesHex: string[];
  powCandidatesHex: string[];
}

export interface VerifyCandidatesResult {
  type: 'verify_candidates_result';
  id: number;
  matchedKeyHex: string | null;
  powKeysHex: string[];
}

const SECP256K1_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const CPU_BATCH_HALF = 64;
const CPU_BATCH_SPAN = 2 * CPU_BATCH_HALF + 1; // 129 keys per affine batch
const MAX_CPU_POW_PER_BATCH = 16;

let cachedCpuKgTable: { kgX: bigint[]; kgY: bigint[] } | null = null;

function getCpuKgTable(): { kgX: bigint[]; kgY: bigint[] } {
  if (cachedCpuKgTable) return cachedCpuKgTable;
  const G = secp256k1.Point.BASE;
  const kgX = new Array<bigint>(CPU_BATCH_HALF + 1);
  const kgY = new Array<bigint>(CPU_BATCH_HALF + 1);
  let pt = G;
  for (let i = 0; i < CPU_BATCH_HALF; i++) {
    const aff = pt.toAffine();
    kgX[i] = aff.x;
    kgY[i] = aff.y;
    pt = pt.add(G);
  }
  const step = G.multiply(BigInt(CPU_BATCH_SPAN)).toAffine();
  kgX[CPU_BATCH_HALF] = step.x;
  kgY[CPU_BATCH_HALF] = step.y;
  cachedCpuKgTable = { kgX, kgY };
  return cachedCpuKgTable;
}

function modP(a: bigint): bigint {
  const r = a % SECP256K1_P;
  return r < 0n ? r + SECP256K1_P : r;
}

function modInverseP(a: bigint): bigint {
  let lm = 1n;
  let hm = 0n;
  let low = modP(a);
  let high = SECP256K1_P;
  while (low > 1n) {
    const r = high / low;
    const nm = hm - lm * r;
    const nnew = high - low * r;
    hm = lm;
    high = low;
    lm = nm;
    low = nnew;
  }
  return modP(lm);
}

function checkAffineMatch(
  x: bigint,
  y: bigint,
  pubBuf: Uint8Array,
  targetHash160Bytes: Uint8Array,
): { targetMatch: boolean; powMatch: boolean } {
  pubBuf[0] = (y & 1n) === 0n ? 0x02 : 0x03;
  let xv = x;
  for (let b = 32; b >= 1; b--) {
    pubBuf[b] = Number(xv & 0xffn);
    xv >>= 8n;
  }
  const h = ripemd160(sha256(pubBuf));
  const powMatch = h[0] === 0 && h[1] === 0 && h[2] === 0;
  for (let j = 0; j < 20; j++) {
    if (h[j] !== targetHash160Bytes[j]) {
      return { targetMatch: false, powMatch };
    }
  }
  return { targetMatch: true, powMatch };
}

function scanCpuProjective(
  startKey: bigint,
  count: number,
  targetHash160Bytes: Uint8Array,
): { checked: number; foundKey: bigint | null; powKeys: bigint[] } {
  let pt = secp256k1.Point.BASE.multiply(startKey);
  const G = secp256k1.Point.BASE;
  const pubBuf = new Uint8Array(33);
  const BATCH = 64;
  const powKeys: bigint[] = [];

  const xs = new Array<bigint>(BATCH);
  const ys = new Array<bigint>(BATCH);
  const zs = new Array<bigint>(BATCH);
  const prefix = new Array<bigint>(BATCH);

  let processed = 0;
  while (processed < count) {
    const batchLen = Math.min(BATCH, count - processed);
    for (let k = 0; k < batchLen; k++) {
      xs[k] = pt.X;
      ys[k] = pt.Y;
      zs[k] = pt.Z;
      if (processed + k + 1 < count) {
        pt = pt.add(G);
      }
    }

    prefix[0] = zs[0] % SECP256K1_P;
    for (let k = 1; k < batchLen; k++) {
      prefix[k] = (prefix[k - 1] * zs[k]) % SECP256K1_P;
    }

    let inv = modInverseP(prefix[batchLen - 1]);
    const zInvs = new Array<bigint>(batchLen);
    for (let k = batchLen - 1; k > 0; k--) {
      zInvs[k] = (inv * prefix[k - 1]) % SECP256K1_P;
      inv = (inv * zs[k]) % SECP256K1_P;
    }
    zInvs[0] = inv;

    for (let k = 0; k < batchLen; k++) {
      const zInv = zInvs[k];
      const x = (xs[k] * zInv) % SECP256K1_P;
      const y = (ys[k] * zInv) % SECP256K1_P;
      const res = checkAffineMatch(x, y, pubBuf, targetHash160Bytes);
      if (res.powMatch && powKeys.length < MAX_CPU_POW_PER_BATCH) {
        powKeys.push(startKey + BigInt(processed + k));
      }
      if (res.targetMatch) {
        return { checked: processed + k + 1, foundKey: startKey + BigInt(processed + k), powKeys };
      }
    }

    processed += batchLen;
  }

  return { checked: count, foundKey: null, powKeys };
}

export function scanCpuBatch(
  startKey: bigint,
  count: number,
  targetHash160Bytes: Uint8Array,
): { checked: number; foundKey: bigint | null; powKeys: bigint[] } {
  if (count <= 0) {
    return { checked: 0, foundKey: null, powKeys: [] };
  }
  // Precondition for affine batching: no batch centre coincides with ±1..±CPU_BATCH_HALF or ±CPU_BATCH_SPAN
  if (startKey <= BigInt(CPU_BATCH_SPAN + 1) || count < 16) {
    return scanCpuProjective(startKey, count, targetHash160Bytes);
  }

  const { kgX, kgY } = getCpuKgTable();
  const pubBuf = new Uint8Array(33);
  const prod = new Array<bigint>(CPU_BATCH_HALF + 1);
  const invs = new Array<bigint>(CPU_BATCH_HALF + 1);
  const powKeys: bigint[] = [];

  let c = CPU_BATCH_HALF;
  const centerAff = secp256k1.Point.BASE.multiply(startKey + BigInt(c)).toAffine();
  let px = centerAff.x;
  let py = centerAff.y;

  while (c - CPU_BATCH_HALF < count) {
    prod[0] = modP(kgX[0] - px);
    for (let i = 1; i <= CPU_BATCH_HALF; i++) {
      prod[i] = (prod[i - 1] * modP(kgX[i] - px)) % SECP256K1_P;
    }

    // Guard against dx == 0 (impossible in Puzzle #71 range, safe fallback if hit in tests)
    if (prod[CPU_BATCH_HALF] === 0n) {
      return scanCpuProjective(startKey, count, targetHash160Bytes);
    }

    let u = modInverseP(prod[CPU_BATCH_HALF]);
    for (let i = CPU_BATCH_HALF; i > 0; i--) {
      invs[i] = (u * prod[i - 1]) % SECP256K1_P;
      u = (u * modP(kgX[i] - px)) % SECP256K1_P;
    }
    invs[0] = u;

    if (c < count) {
      const res = checkAffineMatch(px, py, pubBuf, targetHash160Bytes);
      if (res.powMatch && powKeys.length < MAX_CPU_POW_PER_BATCH) {
        powKeys.push(startKey + BigInt(c));
      }
      if (res.targetMatch) {
        return { checked: c + 1, foundKey: startKey + BigInt(c), powKeys };
      }
    }

    for (let i = 0; i < CPU_BATCH_HALF; i++) {
      const inv = invs[i];
      const gx = kgX[i];
      const gy = kgY[i];
      const sumX = px + gx;

      const offPlus = c + 1 + i;
      if (offPlus < count) {
        const lam = (modP(gy - py) * inv) % SECP256K1_P;
        const x3 = modP(lam * lam - sumX);
        const y3 = modP(lam * (px - x3) - py);
        const res = checkAffineMatch(x3, y3, pubBuf, targetHash160Bytes);
        if (res.powMatch && powKeys.length < MAX_CPU_POW_PER_BATCH) {
          powKeys.push(startKey + BigInt(offPlus));
        }
        if (res.targetMatch) {
          return { checked: offPlus + 1, foundKey: startKey + BigInt(offPlus), powKeys };
        }
      }

      const offMinus = c - 1 - i;
      if (offMinus < count) {
        const lam = (modP(-gy - py) * inv) % SECP256K1_P;
        const x3 = modP(lam * lam - sumX);
        const y3 = modP(lam * (px - x3) - py);
        const res = checkAffineMatch(x3, y3, pubBuf, targetHash160Bytes);
        if (res.powMatch && powKeys.length < MAX_CPU_POW_PER_BATCH) {
          powKeys.push(startKey + BigInt(offMinus));
        }
        if (res.targetMatch) {
          return { checked: offMinus + 1, foundKey: startKey + BigInt(offMinus), powKeys };
        }
      }
    }

    if (c - CPU_BATCH_HALF + CPU_BATCH_SPAN < count) {
      const ls = (modP(kgY[CPU_BATCH_HALF] - py) * invs[CPU_BATCH_HALF]) % SECP256K1_P;
      const xs = modP(ls * ls - (px + kgX[CPU_BATCH_HALF]));
      const ys = modP(ls * (px - xs) - py);
      px = xs;
      py = ys;
    }

    c += CPU_BATCH_SPAN;
  }

  return { checked: count, foundKey: null, powKeys };
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Web Worker message handler
if (typeof self !== 'undefined' && typeof (self as unknown as Worker).postMessage === 'function') {
  const gpuPointCursor = createIncrementalBasePointCursor();

  self.onmessage = (
    ev: MessageEvent<CpuScanBatchRequest | DeriveAffineRequest | VerifyCandidatesRequest>,
  ) => {
    const msg = ev.data;
    if (!msg) return;

    if (msg.type === 'scan') {
      const startKey = BigInt(msg.startKeyHex);
      const targetBytes = hexToBytes(msg.targetHash160Hex);
      const res = scanCpuBatch(startKey, msg.count, targetBytes);
      const payload: CpuScanBatchResult = {
        type: 'result',
        id: msg.id,
        checked: res.checked,
        foundKeyHex: res.foundKey !== null ? '0x' + res.foundKey.toString(16) : null,
        powKeysHex: res.powKeys.map((k) => '0x' + k.toString(16)),
      };
      (self as unknown as Worker).postMessage(payload);
      return;
    }

    if (msg.type === 'derive_affine') {
      const startKey = BigInt(msg.startKeyHex);
      const aff = gpuPointCursor.deriveAffine(startKey);
      const payload: DeriveAffineResult = {
        type: 'derive_affine_result',
        id: msg.id,
        xBytes: aff.xBytes,
        yBytes: aff.yBytes,
      };
      (self as unknown as Worker).postMessage(payload, [aff.xBytes.buffer, aff.yBytes.buffer]);
      return;
    }

    if (msg.type === 'verify_candidates') {
      const powKeysHex: string[] = [];
      for (const hexKey of msg.powCandidatesHex) {
        if (privateKeyToHash160Hex(BigInt(hexKey)).startsWith(msg.powPrefix)) {
          powKeysHex.push(hexKey);
        }
      }

      let matchedKeyHex: string | null = null;
      for (const hexKey of msg.hitCandidatesHex) {
        if (privateKeyToHash160Hex(BigInt(hexKey)) === msg.targetHash160Hex) {
          matchedKeyHex = hexKey;
          break;
        }
      }

      const payload: VerifyCandidatesResult = {
        type: 'verify_candidates_result',
        id: msg.id,
        matchedKeyHex,
        powKeysHex,
      };
      (self as unknown as Worker).postMessage(payload);
    }
  };
}
