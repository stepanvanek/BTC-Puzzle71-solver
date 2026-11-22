import { secp256k1 } from '@noble/curves/secp256k1.js';

export type ComputeProfile = 'max' | 'smooth';

export const COMPUTE_PROFILE_STORAGE_KEY = 'puzzle71.computeProfile_v1';
export const MAX_CALIBRATION_STORAGE_KEY = 'puzzle71.dispatchKeys_v3';
export const SMOOTH_CALIBRATION_STORAGE_KEY = 'puzzle71.dispatchKeys.smooth_v1';

export const DEFAULT_COMPUTE_PROFILE: ComputeProfile = 'max';

export interface ComputeProfileConfig {
  profile: ComputeProfile;
  pipelineDepth: 1 | 2;
  minDispatchMs: number;
  targetDispatchMs: number;
  maxDispatchMs: number;
  cpuThreads: number;
  cpuSliceKeysPerWorker: number;
  yieldEveryDispatch: boolean;
}

export function getCpuThreadsForProfile(
  profile: ComputeProfile,
  hardwareConcurrency?: number,
): number {
  const rawHc =
    typeof hardwareConcurrency === 'number' && Number.isFinite(hardwareConcurrency)
      ? Math.floor(hardwareConcurrency)
      : typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)
        ? Math.floor(navigator.hardwareConcurrency)
        : 4;

  const fullCount = Math.max(1, Math.min(16, rawHc));
  if (profile === 'max') {
    return fullCount;
  }

  // Smooth profile reserves 1-2 CPU cores so browser scrolling, touch & OS UI never starve
  if (fullCount <= 2) return 1;
  if (fullCount <= 5) return fullCount - 1;
  return Math.min(14, fullCount - 2);
}

export function getComputeProfileConfig(
  profile: ComputeProfile,
  hardwareConcurrency?: number,
): ComputeProfileConfig {
  const cpuThreads = getCpuThreadsForProfile(profile, hardwareConcurrency);
  if (profile === 'smooth') {
    return {
      profile: 'smooth',
      pipelineDepth: 1,
      minDispatchMs: 6,
      targetDispatchMs: 18,
      maxDispatchMs: 30,
      cpuThreads,
      cpuSliceKeysPerWorker: 4_096,
      yieldEveryDispatch: true,
    };
  }

  return {
    profile: 'max',
    pipelineDepth: 2,
    minDispatchMs: 40,
    targetDispatchMs: 160,
    maxDispatchMs: 380,
    cpuThreads,
    cpuSliceKeysPerWorker: 8_192,
    yieldEveryDispatch: false,
  };
}

let runtimeComputeProfile: ComputeProfile = DEFAULT_COMPUTE_PROFILE;

export function loadSavedComputeProfile(): ComputeProfile {
  return runtimeComputeProfile;
}

export function saveComputeProfile(profile: ComputeProfile): void {
  runtimeComputeProfile = profile;
}

export function computeNextDispatchKeys(params: {
  currentKeys: number;
  lastChecked: number;
  unsubmittedKeys: number;
  gpuSpanMs: number;
  minSlice: number;
  unitSlice: number;
  maxSlice: number;
  config: Pick<ComputeProfileConfig, 'minDispatchMs' | 'targetDispatchMs' | 'maxDispatchMs'>;
}): number {
  const {
    currentKeys,
    lastChecked,
    unsubmittedKeys,
    gpuSpanMs,
    minSlice,
    unitSlice,
    maxSlice,
    config,
  } = params;

  if (lastChecked < minSlice) {
    return currentKeys;
  }

  let next = currentKeys;
  if (gpuSpanMs > config.maxDispatchMs) {
    next = Math.max(minSlice, Math.floor(currentKeys / 2));
  } else if (unsubmittedKeys >= currentKeys || lastChecked >= currentKeys) {
    const base = Math.max(currentKeys, lastChecked);
    if (gpuSpanMs < config.minDispatchMs) {
      next = Math.min(maxSlice, base * 2);
    } else if (gpuSpanMs < config.targetDispatchMs) {
      // Avoid jumping from sub-unit mobile slices (< 32,896) straight into multi-workgroup dispatches
      const step = base >= unitSlice ? unitSlice : minSlice;
      next = Math.min(maxSlice, Math.max(base + step, Math.floor(base * 1.25)));
    }
  }

  return Math.max(minSlice, Math.min(maxSlice, next));
}

export interface AffinePointLE {
  xBytes: Uint8Array;
  yBytes: Uint8Array;
}

export function packFieldCoordinateLE(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 0; i < 8; i++) {
    const limb = Number(v & 0xffffffffn);
    out[i * 4] = limb & 0xff;
    out[i * 4 + 1] = (limb >>> 8) & 0xff;
    out[i * 4 + 2] = (limb >>> 16) & 0xff;
    out[i * 4 + 3] = (limb >>> 24) & 0xff;
    v >>= 32n;
  }
  return out;
}

const MAX_INCREMENTAL_DELTA = 67_108_864n;

/**
 * Incremental secp256k1 point cursor so contiguous WebGPU dispatches avoid
 * repeating a full 256-bit scalar multiplication from G on every batch.
 */
export function createIncrementalBasePointCursor() {
  let lastKey: bigint | null = null;
  let lastPoint: ReturnType<typeof secp256k1.Point.BASE.multiply> | null = null;
  const deltaCache = new Map<bigint, ReturnType<typeof secp256k1.Point.BASE.multiply>>();

  return {
    deriveAffine(startKey: bigint): AffinePointLE {
      let nextPoint: ReturnType<typeof secp256k1.Point.BASE.multiply>;

      if (lastKey !== null && lastPoint !== null) {
        const delta = startKey - lastKey;
        if (delta === 0n) {
          nextPoint = lastPoint;
        } else if (delta > 0n && delta <= MAX_INCREMENTAL_DELTA) {
          let stepPt = deltaCache.get(delta);
          if (!stepPt) {
            if (deltaCache.size >= 32) {
              deltaCache.clear();
            }
            stepPt = secp256k1.Point.BASE.multiply(delta);
            deltaCache.set(delta, stepPt);
          }
          nextPoint = lastPoint.add(stepPt);
        } else {
          nextPoint = secp256k1.Point.BASE.multiply(startKey);
        }
      } else {
        nextPoint = secp256k1.Point.BASE.multiply(startKey);
      }

      lastKey = startKey;
      lastPoint = nextPoint;
      const aff = nextPoint.toAffine();
      return {
        xBytes: packFieldCoordinateLE(aff.x),
        yBytes: packFieldCoordinateLE(aff.y),
      };
    },
    reset(): void {
      lastKey = null;
      lastPoint = null;
      deltaCache.clear();
    },
  };
}
