import type { Locale } from '../i18n/locale.ts';
import { privateKeyToHash160Hex } from '../shared/btcTx.ts';
import { POW_HASH160_HEX_PREFIX, PUZZLE_71_HASH160_HEX } from '../shared/puzzle71.ts';
import { type AffinePointLE, createIncrementalBasePointCursor } from './computeProfile.ts';
import {
  type CpuScanBatchResult,
  type DeriveAffineResult,
  type VerifyCandidatesResult,
  scanCpuBatch,
} from './cpuWorker.ts';
import {
  HEADER_BYTES,
  KEYS_PER_THREAD_DEFAULT,
  MAX_HITS,
  MAX_POW_HITS,
  OFFSET_TABLE_BITS,
  OUTPUT_BYTES,
  PARAMS_BYTES,
  SECP256K1_HASH160_WGSL,
  WORKGROUP_SIZE,
  buildKgTableBytes,
  buildOffsetTableBytes,
  hex20BytesToU32LE,
} from './secp256k1.wgsl.ts';

export type ComputeBackendMode = 'webgpu' | 'cpu';

export const WEBGPU_MIN_SLICE = WORKGROUP_SIZE; // 64
export const WEBGPU_UNIT_SLICE = WORKGROUP_SIZE * KEYS_PER_THREAD_DEFAULT; // 32,896 (1 workgroup * 514)
export const WEBGPU_INITIAL_SLICE = 16 * WEBGPU_UNIT_SLICE; // 526,336 (16 workgroups, 1024 threads)
export const WEBGPU_MAX_SLICE = 16_777_216; // max 1 block per dispatch
export const CPU_KEYS_PER_WORKER_SLICE = 8_192;

export interface HardwareCapabilities {
  webgpuSupported: boolean;
  mode: ComputeBackendMode;
  adapterName: string;
  isFallbackAdapter?: boolean;
  fallbackReason?: string;
  cpuThreads?: number;
  selfTestPassed: boolean;
  selfTestDurationMs: number;
  selfTestDetails: string;
  recommendedDispatchKeys?: number;
}

const GPU_BUFFER_USAGE = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  STORAGE: 0x0080,
} as const;

const GPU_MAP_MODE_READ = 0x0001;

interface MinimalGPUAdapterInfo {
  device?: string;
  description?: string;
  vendor?: string;
  architecture?: string;
}

interface MinimalGPUBuffer {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy?: () => void;
}

interface MinimalGPUComputePass {
  setPipeline(pipeline: unknown): void;
  setBindGroup(index: number, bindGroup: unknown): void;
  dispatchWorkgroups(countX: number, countY?: number, countZ?: number): void;
  end(): void;
}

interface MinimalGPUCommandEncoder {
  beginComputePass(): MinimalGPUComputePass;
  copyBufferToBuffer(
    src: MinimalGPUBuffer,
    srcOffset: number,
    dst: MinimalGPUBuffer,
    dstOffset: number,
    size: number,
  ): void;
  finish(): unknown;
}

interface MinimalGPUPipeline {
  getBindGroupLayout(idx: number): unknown;
}

interface MinimalGPUDevice {
  lost?: Promise<{ reason?: string; message?: string }>;
  destroy?: () => void;
  createShaderModule(desc: { code: string }): {
    getCompilationInfo(): Promise<{
      messages: Array<{ type: string; message?: string; lineNum?: number }>;
    }>;
  };
  createComputePipeline(desc: unknown): MinimalGPUPipeline;
  createComputePipelineAsync?: (desc: unknown) => Promise<MinimalGPUPipeline>;
  createBuffer(desc: { size: number; usage: number }): MinimalGPUBuffer;
  createBindGroup(desc: unknown): unknown;
  createCommandEncoder(): MinimalGPUCommandEncoder;
  queue: {
    writeBuffer(buf: MinimalGPUBuffer, offset: number, data: ArrayBufferLike | ArrayBufferView): void;
    submit(cmds: unknown[]): void;
  };
}

interface WebGPUBufferSlot {
  paramsBuffer: MinimalGPUBuffer;
  outputBuffer: MinimalGPUBuffer;
  outputReadBuffer: MinimalGPUBuffer;
  bindGroup: unknown;
  uploadedStride: number | null;
  headerStaging: Uint8Array;
  headerView: DataView;
  zeroOutputStaging: Uint8Array;
  cachedTargetHex: string;
  cachedTargetWords: Uint32Array;
}

interface WebGPUContext {
  device: MinimalGPUDevice;
  pipeline: MinimalGPUPipeline;
  slots: [WebGPUBufferSlot, WebGPUBufferSlot];
  cachedOffsetTables: Map<number, Uint8Array>;
}

export interface WebGPUPendingDispatch {
  slotIndex: 0 | 1;
  submittedAt: number;
  startKey: bigint;
  stride: number;
  checked: number;
  workgroups: number;
  keysPerThread: number;
  waitForResult: () => Promise<{
    checked: number;
    foundKey: bigint | null;
    powKeys: bigint[];
    completedAt: number;
    submittedAt: number;
    workgroups: number;
  }>;
}

let gpuCtx: WebGPUContext | null = null;
let cachedKgTableBytes: Uint8Array | null = null;
let gpuHelperWorker: Worker | null = null;
let nextHelperJobId = 1;
const fallbackPointCursor = createIncrementalBasePointCursor();

function getGpuHelperWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!gpuHelperWorker) {
    gpuHelperWorker = new Worker(new URL('./cpuWorker.ts', import.meta.url), { type: 'module' });
  }
  return gpuHelperWorker;
}

async function deriveBaseAffineOffThread(startKey: bigint): Promise<AffinePointLE> {
  const helper = getGpuHelperWorker();
  if (!helper) {
    return fallbackPointCursor.deriveAffine(startKey);
  }
  const id = nextHelperJobId++;
  return new Promise<AffinePointLE>((resolve) => {
    const onMsg = (ev: MessageEvent<DeriveAffineResult>) => {
      if (ev.data?.type === 'derive_affine_result' && ev.data.id === id) {
        helper.removeEventListener('message', onMsg);
        helper.removeEventListener('error', onErr);
        resolve({ xBytes: ev.data.xBytes, yBytes: ev.data.yBytes });
      }
    };
    const onErr = () => {
      helper.removeEventListener('message', onMsg);
      helper.removeEventListener('error', onErr);
      resolve(fallbackPointCursor.deriveAffine(startKey));
    };
    helper.addEventListener('message', onMsg);
    helper.addEventListener('error', onErr);
    helper.postMessage({
      type: 'derive_affine',
      id,
      startKeyHex: '0x' + startKey.toString(16),
    });
  });
}

async function verifyCandidatesOffThread(
  targetHash160Hex: string,
  hitCandidates: bigint[],
  powCandidates: bigint[],
): Promise<{ foundKey: bigint | null; powKeys: bigint[] }> {
  if (hitCandidates.length === 0 && powCandidates.length === 0) {
    return { foundKey: null, powKeys: [] };
  }

  const verifySyncFallback = () => {
    const powKeys: bigint[] = [];
    for (const candidate of powCandidates) {
      if (privateKeyToHash160Hex(candidate).startsWith(POW_HASH160_HEX_PREFIX)) {
        powKeys.push(candidate);
      }
    }
    let foundKey: bigint | null = null;
    for (const candidate of hitCandidates) {
      if (privateKeyToHash160Hex(candidate) === targetHash160Hex) {
        foundKey = candidate;
        break;
      }
    }
    return { foundKey, powKeys };
  };

  const helper = getGpuHelperWorker();
  if (!helper) {
    return verifySyncFallback();
  }

  const id = nextHelperJobId++;
  return new Promise((resolve) => {
    const onMsg = (ev: MessageEvent<VerifyCandidatesResult>) => {
      if (ev.data?.type === 'verify_candidates_result' && ev.data.id === id) {
        helper.removeEventListener('message', onMsg);
        helper.removeEventListener('error', onErr);
        resolve({
          foundKey: ev.data.matchedKeyHex ? BigInt(ev.data.matchedKeyHex) : null,
          powKeys: Array.isArray(ev.data.powKeysHex)
            ? ev.data.powKeysHex.map((h) => BigInt(h))
            : [],
        });
      }
    };
    const onErr = () => {
      helper.removeEventListener('message', onMsg);
      helper.removeEventListener('error', onErr);
      resolve(verifySyncFallback());
    };
    helper.addEventListener('message', onMsg);
    helper.addEventListener('error', onErr);
    helper.postMessage({
      type: 'verify_candidates',
      id,
      targetHash160Hex,
      powPrefix: POW_HASH160_HEX_PREFIX,
      hitCandidatesHex: hitCandidates.map((k) => '0x' + k.toString(16)),
      powCandidatesHex: powCandidates.map((k) => '0x' + k.toString(16)),
    });
  });
}

function getKgTableBytes(): Uint8Array {
  if (!cachedKgTableBytes) {
    cachedKgTableBytes = buildKgTableBytes();
  }
  return cachedKgTableBytes;
}

function detectBrowserShortName(): string | null {
  if (typeof navigator === 'undefined') return null;
  try {
    const ua = navigator.userAgent || '';
    if (/\bEdgA?\//.test(ua)) return 'Edge';
    if (/\bOPR\//.test(ua)) return 'Opera';
    if (/\bFirefox\//.test(ua)) return 'Firefox';
    if (/\bChrome\//.test(ua) || /\bChromium\//.test(ua)) return 'Chrome';
    if (/\bSafari\//.test(ua) && !/Chrom/.test(ua)) return 'Safari';
  } catch {
    return null;
  }
  return null;
}

function formatAdapterName(info?: MinimalGPUAdapterInfo): string {
  const gpuPart =
    info?.description ||
    [...new Set([info?.vendor, info?.architecture, info?.device].filter(Boolean))].join(' · ') ||
    'WebGPU GPU';
  const browser = detectBrowserShortName();
  return browser ? `${gpuPart} · ${browser}` : gpuPart;
}

function createBufferSlot(
  device: MinimalGPUDevice,
  pipeline: MinimalGPUPipeline,
): WebGPUBufferSlot {
  const paramsBuffer = device.createBuffer({
    size: PARAMS_BYTES,
    usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST,
  });

  // Write stride-independent kg_table once per slot buffer
  device.queue.writeBuffer(paramsBuffer, HEADER_BYTES + OFFSET_TABLE_BITS * 64, getKgTableBytes());

  const outputBuffer = device.createBuffer({
    size: OUTPUT_BYTES,
    usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_SRC | GPU_BUFFER_USAGE.COPY_DST,
  });

  const outputReadBuffer = device.createBuffer({
    size: OUTPUT_BYTES,
    usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST,
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 1, resource: { buffer: outputBuffer } },
    ],
  });

  const headerStaging = new Uint8Array(HEADER_BYTES);
  return {
    paramsBuffer,
    outputBuffer,
    outputReadBuffer,
    bindGroup,
    uploadedStride: null,
    headerStaging,
    headerView: new DataView(headerStaging.buffer),
    zeroOutputStaging: new Uint8Array(OUTPUT_BYTES),
    cachedTargetHex: PUZZLE_71_HASH160_HEX,
    cachedTargetWords: hex20BytesToU32LE(PUZZLE_71_HASH160_HEX),
  };
}

async function initWebGPUContext(locale: Locale = 'en'): Promise<
  | { ctx: WebGPUContext; adapterName: string; isFallbackAdapter: boolean; errorReason?: never }
  | { ctx: null; errorReason: string; isFallbackAdapter?: boolean; adapterName?: string }
> {
  const isCs = locale === 'cs';
  const navGpu =
    typeof navigator !== 'undefined'
      ? (navigator as unknown as {
          gpu?: {
            requestAdapter(opts?: { powerPreference?: string }): Promise<{
              info?: MinimalGPUAdapterInfo;
              isFallbackAdapter?: boolean;
              requestDevice(): Promise<MinimalGPUDevice>;
            } | null>;
          };
        }).gpu
      : undefined;

  if (!navGpu) {
    return {
      ctx: null,
      errorReason: isCs
        ? 'navigator.gpu není v tomto prohlížeči nebo kontextu dostupné'
        : 'navigator.gpu is unavailable in this browser or context',
    };
  }

  try {
    const adapter = await navGpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      return {
        ctx: null,
        errorReason: isCs
          ? 'WebGPU adaptér nebyl nalezen (zkuste Chrome/Edge nebo povolte Vulkan/GPU akceleraci)'
          : 'No WebGPU adapter found (try Chrome/Edge or enable GPU/Vulkan acceleration)',
      };
    }

    const adapterName = formatAdapterName(adapter.info);
    const isFallbackAdapter = Boolean(adapter.isFallbackAdapter);
    if (isFallbackAdapter) {
      return {
        ctx: null,
        isFallbackAdapter: true,
        adapterName,
        errorReason: isCs
          ? `Prohlížeč vrátil pouze softwarový WebGPU adaptér (${adapterName}) běžící na CPU`
          : `Browser returned only a software WebGPU adapter (${adapterName}) running on CPU`,
      };
    }

    const device = await adapter.requestDevice();

    const shaderModule = device.createShaderModule({
      code: SECP256K1_HASH160_WGSL,
    });

    const compilationInfo = await shaderModule.getCompilationInfo();
    const errors = compilationInfo.messages.filter((m) => m.type === 'error');
    if (errors.length > 0) {
      const firstErr = errors[0];
      return {
        ctx: null,
        adapterName,
        errorReason: isCs
          ? `WGSL chyba kompilace (řádek ${firstErr.lineNum ?? '?'}): ${firstErr.message ?? 'neznámá chyba'}`
          : `WGSL compile error (line ${firstErr.lineNum ?? '?'}): ${firstErr.message ?? 'unknown error'}`,
      };
    }

    const pipelineDesc = {
      layout: 'auto',
      compute: {
        module: shaderModule,
        entryPoint: 'search',
      },
    };
    const pipeline = device.createComputePipelineAsync
      ? await device.createComputePipelineAsync(pipelineDesc)
      : device.createComputePipeline(pipelineDesc);

    const slots: [WebGPUBufferSlot, WebGPUBufferSlot] = [
      createBufferSlot(device, pipeline),
      createBufferSlot(device, pipeline),
    ];

    const ctx: WebGPUContext = {
      device,
      pipeline,
      slots,
      cachedOffsetTables: new Map(),
    };

    device.lost?.then((info) => {
      console.warn('WebGPU device lost:', info.reason, info.message);
      if (gpuCtx === ctx) {
        gpuCtx = null;
      }
    });

    return { ctx, adapterName, isFallbackAdapter: false };
  } catch (err) {
    return {
      ctx: null,
      errorReason:
        err instanceof Error
          ? err.message
          : isCs
            ? 'Inicializace WebGPU selhala'
            : 'WebGPU initialization failed',
    };
  }
}

export async function reacquireWebGPUContext(locale: Locale = 'en'): Promise<boolean> {
  const init = await initWebGPUContext(locale);
  if (init.ctx) {
    gpuCtx = init.ctx;
    return true;
  }
  return false;
}

/**
 * Splits `desiredKeys` into (workgroups, keysPerThread) inside `remaining` keys,
 * rounding UP workgroups (`Math.ceil`) when possible so small 1.25x calibration bumps
 * always scale up GPU occupancy, while clamping strictly within `remaining`.
 */
export function partitionWebGpuDispatch(
  remaining: number,
  desiredKeys: number,
): { workgroups: number; keysPerThread: number; checked: number } | null {
  if (remaining < WORKGROUP_SIZE) {
    return null;
  }

  if (remaining >= WEBGPU_UNIT_SLICE && desiredKeys >= WEBGPU_UNIT_SLICE) {
    const maxWorkgroups = Math.floor(remaining / WEBGPU_UNIT_SLICE);
    const wantedWorkgroups = Math.max(1, Math.ceil(desiredKeys / WEBGPU_UNIT_SLICE));
    const workgroups = Math.min(maxWorkgroups, wantedWorkgroups);

    if (workgroups * WORKGROUP_SIZE > 1 << OFFSET_TABLE_BITS) {
      throw new Error(
        `Dispatch exceeds limit 2^${OFFSET_TABLE_BITS} threads (${workgroups * WORKGROUP_SIZE})`,
      );
    }

    return {
      workgroups,
      keysPerThread: KEYS_PER_THREAD_DEFAULT,
      checked: workgroups * WEBGPU_UNIT_SLICE,
    };
  }

  const cappedDesired = Math.min(remaining, Math.max(WORKGROUP_SIZE, desiredKeys));
  const keysPerThread = Math.max(
    1,
    Math.min(KEYS_PER_THREAD_DEFAULT, Math.floor(cappedDesired / WORKGROUP_SIZE)),
  );

  return {
    workgroups: 1,
    keysPerThread,
    checked: WORKGROUP_SIZE * keysPerThread,
  };
}

function ensureSlotOffsetTable(
  ctx: WebGPUContext,
  slot: WebGPUBufferSlot,
  stride: number,
): number {
  if (slot.uploadedStride !== stride) {
    let table = ctx.cachedOffsetTables.get(stride);
    if (!table) {
      table = buildOffsetTableBytes(stride);
      ctx.cachedOffsetTables.set(stride, table);
    }
    ctx.device.queue.writeBuffer(slot.paramsBuffer, HEADER_BYTES, table);
    slot.uploadedStride = stride;
  }
  return slot.uploadedStride;
}

async function submitWebGPUSlotInternal(
  ctx: WebGPUContext,
  slotIndex: 0 | 1,
  startKey: bigint,
  workgroups: number,
  keysPerThread: number,
  targetHash160Hex: string,
): Promise<WebGPUPendingDispatch> {
  const slot = ctx.slots[slotIndex];
  const stride = ensureSlotOffsetTable(ctx, slot, keysPerThread);

  const { xBytes, yBytes } = await deriveBaseAffineOffThread(startKey);
  slot.headerStaging.set(xBytes, 0);
  slot.headerStaging.set(yBytes, 32);

  if (slot.cachedTargetHex !== targetHash160Hex) {
    slot.cachedTargetHex = targetHash160Hex;
    slot.cachedTargetWords = hex20BytesToU32LE(targetHash160Hex);
  }
  for (let i = 0; i < 5; i++) {
    slot.headerView.setUint32(64 + i * 4, slot.cachedTargetWords[i], true);
  }
  slot.headerView.setUint32(84, keysPerThread, true);

  ctx.device.queue.writeBuffer(slot.paramsBuffer, 0, slot.headerStaging);
  ctx.device.queue.writeBuffer(slot.outputBuffer, 0, slot.zeroOutputStaging);

  const submittedAt = performance.now();
  const encoder = ctx.device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(ctx.pipeline);
  pass.setBindGroup(0, slot.bindGroup);
  pass.dispatchWorkgroups(workgroups, 1, 1);
  pass.end();
  encoder.copyBufferToBuffer(slot.outputBuffer, 0, slot.outputReadBuffer, 0, OUTPUT_BYTES);
  ctx.device.queue.submit([encoder.finish()]);

  const totalChecked = workgroups * WORKGROUP_SIZE * keysPerThread;
  const mapPromise = slot.outputReadBuffer.mapAsync(GPU_MAP_MODE_READ);

  return {
    slotIndex,
    submittedAt,
    startKey,
    stride,
    checked: totalChecked,
    workgroups,
    keysPerThread,
    waitForResult: async () => {
      await mapPromise;
      const mapped = slot.outputReadBuffer.getMappedRange();
      const odv = new DataView(mapped);
      const count = odv.getUint32(0, true);
      let hits: Array<{ threadId: number; keyOffset: number }> | null = null;
      if (count > 0) {
        const limit = Math.min(count, MAX_HITS);
        hits = [];
        for (let i = 0; i < limit; i++) {
          hits.push({
            threadId: odv.getUint32(4 + i * 8, true),
            keyOffset: odv.getUint32(4 + i * 8 + 4, true),
          });
        }
      }

      const powBase = 4 + MAX_HITS * 8;
      const powCount = odv.getUint32(powBase, true);
      let rawPowHits: Array<{ threadId: number; keyOffset: number }> | null = null;
      if (powCount > 0) {
        const limit = Math.min(powCount, MAX_POW_HITS);
        rawPowHits = [];
        for (let i = 0; i < limit; i++) {
          rawPowHits.push({
            threadId: odv.getUint32(powBase + 4 + i * 8, true),
            keyOffset: odv.getUint32(powBase + 4 + i * 8 + 4, true),
          });
        }
      }

      slot.outputReadBuffer.unmap();
      const completedAt = performance.now();

      const powCandidates = rawPowHits
        ? rawPowHits.map(
            (pHit) => startKey + BigInt(pHit.threadId) * BigInt(stride) + BigInt(pHit.keyOffset),
          )
        : [];
      const hitCandidates = hits
        ? hits.map((hit) => startKey + BigInt(hit.threadId) * BigInt(stride) + BigInt(hit.keyOffset))
        : [];

      const verified = await verifyCandidatesOffThread(
        targetHash160Hex,
        hitCandidates,
        powCandidates,
      );

      if (hits && verified.foundKey === null) {
        for (let i = 0; i < hits.length; i++) {
          console.error('REJECTED a GPU hit: CPU re-derivation disagrees.', {
            threadId: hits[i].threadId,
            keyOffset: hits[i].keyOffset,
            stride,
            candidate: hitCandidates[i].toString(16),
          });
        }
      }

      return {
        checked: totalChecked,
        foundKey: verified.foundKey,
        powKeys: verified.powKeys,
        completedAt,
        submittedAt,
        workgroups,
      };
    },
  };
}

export async function submitWebGPUSlice(params: {
  slotIndex: 0 | 1;
  startKey: bigint;
  maxCount: number;
  desiredDispatchKeys?: number;
  targetHash160Hex?: string;
}): Promise<WebGPUPendingDispatch | null> {
  if (!gpuCtx) {
    const ok = await reacquireWebGPUContext();
    if (!ok || !gpuCtx) {
      throw new Error('WebGPU device was lost and could not be re-initialized.');
    }
  }
  const targetHex = params.targetHash160Hex ?? PUZZLE_71_HASH160_HEX;
  const desired = params.desiredDispatchKeys ?? params.maxCount;
  const plan = partitionWebGpuDispatch(params.maxCount, desired);
  if (!plan) return null;

  return submitWebGPUSlotInternal(
    gpuCtx,
    params.slotIndex,
    params.startKey,
    plan.workgroups,
    plan.keysPerThread,
    targetHex,
  );
}

async function runWebGPUBatch(
  ctx: WebGPUContext,
  startKey: bigint,
  workgroups: number,
  keysPerThread: number,
  targetHash160Hex: string,
): Promise<{
  checked: number;
  foundKey: bigint | null;
  powKeys: bigint[];
  elapsedMs: number;
  workgroups: number;
}> {
  const pending = await submitWebGPUSlotInternal(
    ctx,
    0,
    startKey,
    workgroups,
    keysPerThread,
    targetHash160Hex,
  );
  const res = await pending.waitForResult();
  return {
    checked: res.checked,
    foundKey: res.foundKey,
    powKeys: res.powKeys,
    elapsedMs: res.completedAt - res.submittedAt,
    workgroups: res.workgroups,
  };
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function getCpuThreadCount(): number {
  if (typeof navigator === 'undefined') return 1;
  const hc = navigator.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(16, hc));
}

/**
 * Probes WebGPU availability and verifies cryptographic correctness across
 * quick smoke checks and multi-batch symmetric (-k*G) affine kernel paths.
 */
export async function detectAndVerifyComputeHardware(
  locale: Locale = 'en',
): Promise<HardwareCapabilities> {
  const isCs = locale === 'cs';
  const t0 = performance.now();
  const testStartKey = 0x400000000000000100n;
  // Stage 1: small smoke test (S=4, 256 keys total)
  const smokeExpectedKey = testStartKey + 3n * 4n + 2n;
  const smokeHash160 = privateKeyToHash160Hex(smokeExpectedKey);
  // Stage 2: multi-batch affine check (thread 3, batch 1 center 385, -85*G symmetric point)
  const expectedOffset = 3n * 514n + 300n;
  const expectedKey = testStartKey + expectedOffset;
  const testTargetHash160 = privateKeyToHash160Hex(expectedKey);

  let fallbackReason = '';
  let detectedAdapterName = '';
  let isFallbackAdapter = false;

  const gpuInit = await initWebGPUContext(locale);
  if (gpuInit.ctx) {
    gpuCtx = gpuInit.ctx;
    detectedAdapterName = gpuInit.adapterName;
    try {
      const smokeRes = await runWebGPUBatch(gpuCtx, testStartKey, 1, 4, smokeHash160);
      if (smokeRes.foundKey !== smokeExpectedKey) {
        fallbackReason = isCs
          ? `WebGPU smoke selftest vrátil ${smokeRes.foundKey?.toString(16) ?? 'null'} místo ${smokeExpectedKey.toString(16)}`
          : `WebGPU smoke self-test returned ${smokeRes.foundKey?.toString(16) ?? 'null'} instead of ${smokeExpectedKey.toString(16)}`;
        gpuCtx = null;
      } else {
        const res = await runWebGPUBatch(
          gpuCtx,
          testStartKey,
          1,
          KEYS_PER_THREAD_DEFAULT,
          testTargetHash160,
        );
        const dt = Math.round(performance.now() - t0);
        if (res.foundKey === expectedKey) {
          const recommendedDispatchKeys =
            res.elapsedMs > 250
              ? WEBGPU_UNIT_SLICE
              : res.elapsedMs > 80
                ? 4 * WEBGPU_UNIT_SLICE
                : WEBGPU_INITIAL_SLICE;
          return {
            webgpuSupported: true,
            mode: 'webgpu',
            adapterName: gpuInit.adapterName,
            isFallbackAdapter: false,
            selfTestPassed: true,
            selfTestDurationMs: dt,
            recommendedDispatchKeys,
            selfTestDetails: isCs
              ? `WebGPU affine-batch shader (257 klíčů/dávka, 2x fronta) ověřen za ${dt} ms.`
              : `WebGPU affine-batch shader (257 keys/batch, dual-slot queue) verified in ${dt} ms.`,
          };
        }
        fallbackReason = isCs
          ? `WebGPU selftest vrátil ${res.foundKey?.toString(16) ?? 'null'} místo ${expectedKey.toString(16)}`
          : `WebGPU self-test returned ${res.foundKey?.toString(16) ?? 'null'} instead of ${expectedKey.toString(16)}`;
        gpuCtx = null;
      }
    } catch (err) {
      fallbackReason =
        err instanceof Error
          ? err.message
          : isCs
            ? 'WebGPU selftest vyhodil chybu'
            : 'WebGPU self-test threw an error';
      gpuCtx = null;
    }
  } else {
    fallbackReason = gpuInit.errorReason;
    detectedAdapterName = gpuInit.adapterName ?? '';
    isFallbackAdapter = Boolean(gpuInit.isFallbackAdapter);
  }

  // Fallback to Multi-Core CPU WebWorker pool
  const cpuCheck = scanCpuBatch(testStartKey + 1800n, 128, hexToBytes(testTargetHash160));
  const dt = Math.round(performance.now() - t0);
  const cpuOk = cpuCheck.foundKey === expectedKey;
  const cpuThreads = getCpuThreadCount();

  return {
    webgpuSupported: false,
    mode: 'cpu',
    adapterName:
      detectedAdapterName ||
      fallbackReason ||
      (isCs ? 'WebGPU nedostupné' : 'WebGPU unavailable'),
    isFallbackAdapter,
    fallbackReason,
    cpuThreads,
    selfTestPassed: cpuOk,
    selfTestDurationMs: dt,
    selfTestDetails: cpuOk
      ? isCs
        ? `CPU WebWorker fallback (${cpuThreads} vláken) ověřen za ${dt} ms. Důvod: ${fallbackReason}`
        : `CPU WebWorker fallback (${cpuThreads} threads) verified in ${dt} ms. Reason: ${fallbackReason}`
      : isCs
        ? 'Interní selftest výpočetního jádra selhal.'
        : 'Internal compute kernel self-test failed.',
  };
}

let workerPool: Worker[] | null = null;
let nextCpuJobId = 1;

function getCpuWorkerPool(): Worker[] | null {
  if (typeof Worker === 'undefined') return null;
  if (!workerPool) {
    const count = getCpuThreadCount();
    workerPool = Array.from({ length: count }, () =>
      new Worker(new URL('./cpuWorker.ts', import.meta.url), { type: 'module' }),
    );
  }
  return workerPool;
}

function runWorkerScan(
  worker: Worker,
  startKey: bigint,
  count: number,
  targetHash160Hex: string,
): Promise<{ checked: number; foundKey: bigint | null; powKeys: bigint[] }> {
  const id = nextCpuJobId++;
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent<CpuScanBatchResult>) => {
      if (ev.data?.type === 'result' && ev.data.id === id) {
        worker.removeEventListener('message', onMsg);
        worker.removeEventListener('error', onErr);
        resolve({
          checked: ev.data.checked,
          foundKey: ev.data.foundKeyHex ? BigInt(ev.data.foundKeyHex) : null,
          powKeys: Array.isArray(ev.data.powKeysHex)
            ? ev.data.powKeysHex.map((h) => BigInt(h))
            : [],
        });
      }
    };
    const onErr = (err: ErrorEvent) => {
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
      reject(new Error(err.message || 'CPU WebWorker failed.'));
    };
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);
    worker.postMessage({
      type: 'scan',
      id,
      startKeyHex: '0x' + startKey.toString(16),
      count,
      targetHash160Hex,
    });
  });
}

export async function runComputeSlice(params: {
  mode: ComputeBackendMode;
  startKey: bigint;
  maxCount: number;
  desiredDispatchKeys?: number;
  targetHash160Hex?: string;
  maxThreads?: number;
  sliceKeysPerWorker?: number;
}): Promise<{
  checked: number;
  foundKey: bigint | null;
  powKeys: bigint[];
  elapsedMs: number;
  workgroups: number;
}> {
  const targetHex = params.targetHash160Hex ?? PUZZLE_71_HASH160_HEX;

  if (params.mode === 'webgpu') {
    if (!gpuCtx) {
      const ok = await reacquireWebGPUContext();
      if (!ok || !gpuCtx) {
        throw new Error('WebGPU device was lost and could not be re-initialized.');
      }
    }

    const desired = params.desiredDispatchKeys ?? params.maxCount;
    const plan = partitionWebGpuDispatch(params.maxCount, desired);
    if (plan) {
      return runWebGPUBatch(
        gpuCtx,
        params.startKey,
        plan.workgroups,
        plan.keysPerThread,
        targetHex,
      );
    }
    const t0 = performance.now();
    const tail = scanCpuBatch(params.startKey, params.maxCount, hexToBytes(targetHex));
    return { ...tail, elapsedMs: performance.now() - t0, workgroups: 0 };
  }

  const pool = getCpuWorkerPool();
  const t0 = performance.now();
  const workerCap = Math.max(1, params.maxThreads ?? pool?.length ?? 1);
  const keysPerWorker = Math.max(128, params.sliceKeysPerWorker ?? CPU_KEYS_PER_WORKER_SLICE);

  if (pool && pool.length > 0 && params.maxCount >= 256) {
    const activeWorkers = Math.min(
      pool.length,
      workerCap,
      Math.max(1, Math.floor(params.maxCount / 128)),
    );
    const totalSlice = Math.min(params.maxCount, activeWorkers * keysPerWorker);
    const perWorkerBase = Math.floor(totalSlice / activeWorkers);
    const remainder = totalSlice % activeWorkers;

    const tasks: Array<Promise<{ checked: number; foundKey: bigint | null; powKeys: bigint[] }>> =
      [];
    let cursor = 0;
    for (let i = 0; i < activeWorkers; i++) {
      const count = perWorkerBase + (i < remainder ? 1 : 0);
      if (count > 0) {
        tasks.push(runWorkerScan(pool[i], params.startKey + BigInt(cursor), count, targetHex));
        cursor += count;
      }
    }
    const results = await Promise.all(tasks);
    const elapsedMs = performance.now() - t0;
    let foundKey: bigint | null = null;
    const powKeys: bigint[] = [];
    for (const r of results) {
      if (r.powKeys.length > 0) {
        powKeys.push(...r.powKeys);
      }
      if (r.foundKey !== null && foundKey === null) {
        foundKey = r.foundKey;
      }
    }
    return { checked: cursor, foundKey, powKeys, elapsedMs, workgroups: 0 };
  }

  const sliceCount = Math.min(params.maxCount, keysPerWorker);
  const cpuRes = scanCpuBatch(params.startKey, sliceCount, hexToBytes(targetHex));
  return { ...cpuRes, elapsedMs: performance.now() - t0, workgroups: 0 };
}
