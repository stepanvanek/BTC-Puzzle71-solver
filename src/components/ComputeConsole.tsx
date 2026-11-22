import { AlertTriangle, Check, Clock, Compass, Copy, Cpu, FlaskConical, Gauge, ListOrdered, Lock, Pause, Play, QrCode, RefreshCw, ShieldCheck, Shuffle, Zap } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useMemo, useState } from 'react';
import type { HardwareCapabilities } from '../engine/computeEngine.ts';
import {
  type ComputeProfile,
  canChangeComputeProfile,
  getCpuThreadsForProfile,
} from '../engine/computeProfile.ts';
import { useLocale } from '../i18n/LocaleContext.tsx';
import { formatLocalizedDecimal, formatLocalizedNumber } from '../i18n/locale.ts';
import { calculatePayoutSplit, formatBtcFromSats } from '../shared/btcAddress.ts';
import { estimatePuzzleTxVbytes, type SignedPuzzleTxResult } from '../shared/btcTx.ts';
import {
  DEFAULT_FEE_RATE_SAT_VB,
  DEFAULT_PUZZLE_71_BALANCE_SATS,
  DEMO_PUZZLE_5_ADDRESS,
  DEMO_PUZZLE_5_NUMBER,
  MIN_POW_SHARES_FULL_BLOCK,
  PUZZLE_71_ADDRESS,
  blockIndexToRange,
  getRequiredPowShares,
  percentToBlockIndex,
} from '../shared/puzzle71.ts';
import type {
  LeasedBlockPayload,
  PrivateBroadcastResult,
  PuzzleNetworkInfo,
  SessionData,
} from '../types/api.ts';
import { buildShareableSessionUrl } from '../utils/deviceId.ts';
import {
  calculateKeyspaceProgressPercent,
  estimateFullKeyspaceSeconds,
  formatDurationFromSeconds,
  formatKeyspaceProgressPercent,
} from '../utils/keyspaceStats.ts';
import type { SpeedSample } from '../utils/speedHistory.ts';
import { ClaimBanner } from './ClaimBanner.tsx';
import { SpeedHistoryChart } from './SpeedHistoryChart.tsx';

interface ComputeConsoleProps {
  sessionData: SessionData;
  currentDeviceId?: string;
  hardware: HardwareCapabilities | null;
  computeProfile?: ComputeProfile;
  isProbingHardware?: boolean;
  isUpdatingStrategy?: boolean;
  isRunning: boolean;
  isBusyStarting: boolean;
  isRunningDemo?: boolean;
  demoScanStatus?: { testedKeyHex: string; progressPct: number } | null;
  demoClaimState?: {
    foundKeyHex: string;
    signedTx: SignedPuzzleTxResult;
    broadcastResult: PrivateBroadcastResult | null;
  } | null;
  currentBlock: LeasedBlockPayload | null;
  currentOffsetInBlock: number;
  currentKeyHex: string;
  liveKeysPerSec: number;
  speedHistory?: SpeedSample[];
  batchStatus?: { current: number; total: number } | null;
  dispatchTelemetry?: { checked: number; workgroups: number; elapsedMs: number } | null;
  networkInfo: PuzzleNetworkInfo | null;
  engineError: string | null;
  onToggleRun: () => void;
  onChangeComputeProfile?: (profile: ComputeProfile) => void;
  onRetryWebGPU?: () => void;
  onUpdateStrategy?: (blockMode: 'random' | 'sequential', startPercent?: number) => Promise<void> | void;
  onRunDemoPuzzle5?: () => Promise<void> | void;
  onDismissDemoClaim?: () => void;
}

function formatRate(kps: number): string {
  if (kps >= 1_000_000) return `${(kps / 1_000_000).toFixed(2)} MKeys/s`;
  if (kps >= 1_000) return `${(kps / 1_000).toFixed(2)} kKeys/s`;
  return `${Math.round(kps)} Keys/s`;
}

export function ComputeConsole({
  sessionData,
  currentDeviceId,
  hardware,
  computeProfile = 'max',
  isProbingHardware = false,
  isUpdatingStrategy = false,
  isRunning,
  isBusyStarting,
  isRunningDemo = false,
  demoScanStatus = null,
  demoClaimState = null,
  currentBlock,
  currentOffsetInBlock,
  currentKeyHex,
  liveKeysPerSec,
  speedHistory = [],
  batchStatus,
  dispatchTelemetry,
  networkInfo,
  engineError,
  onToggleRun,
  onChangeComputeProfile,
  onRetryWebGPU,
  onUpdateStrategy,
  onRunDemoPuzzle5,
  onDismissDemoClaim,
}: ComputeConsoleProps) {
  const { locale } = useLocale();
  const isCs = locale === 'cs';

  const [copiedUrl, setCopiedUrl] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const strategyMode = sessionData.strategy?.blockMode ?? 'random';
  const savedSeqPercent = sessionData.strategy?.seqPercent ?? 0;
  const [draftPercent, setDraftPercent] = useState<number>(savedSeqPercent);

  useEffect(() => {
    setDraftPercent(savedSeqPercent);
  }, [savedSeqPercent]);

  const previewRange = useMemo(() => {
    const idx = percentToBlockIndex(draftPercent);
    return blockIndexToRange(idx);
  }, [draftPercent]);

  const percentDirty = Math.abs(draftPercent - savedSeqPercent) >= 0.01;

  const shareUrl = buildShareableSessionUrl(sessionData.session.shareToken, locale);

  const sequentialPresets = useMemo(
    () => [
      { label: isCs ? 'Od začátku (0 %)' : 'From start (0%)', percent: 0 },
      { label: isCs ? '25 % (čtvrtina)' : '25% (quarter)', percent: 25 },
      { label: isCs ? '50 % (polovina)' : '50% (midpoint)', percent: 50 },
      { label: isCs ? '75 % (tři čtvrtiny)' : '75% (three-quarters)', percent: 75 },
      { label: isCs ? '90 % (závěr)' : '90% (upper end)', percent: 90 },
    ],
    [isCs],
  );

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // Fallback selection ignored
    }
  };

  const blockProgressPct =
    currentBlock && currentBlock.totalKeys > 0
      ? Math.min(100, (currentOffsetInBlock / currentBlock.totalKeys) * 100)
      : 0;

  const requiredPowCount = currentBlock
    ? getRequiredPowShares(currentBlock.totalKeys, MIN_POW_SHARES_FULL_BLOCK)
    : MIN_POW_SHARES_FULL_BLOCK;
  const currentPowCount = currentBlock?.powCount ?? 0;

  const onlineDevices = sessionData.devices.filter((d) => d.isOnline);
  const onlineDevicesCount = onlineDevices.length;
  const fleetRateKps = onlineDevices.reduce((acc, d) => acc + Math.max(0, d.lastRateKps || 0), 0);
  const totalCheckedWithCurrent =
    sessionData.stats.totalKeysChecked +
    (currentBlock ? Math.max(0, currentOffsetInBlock - currentBlock.progressOffset) : 0);

  const otherOnlineRateKps = onlineDevices
    .filter((d) => d.id !== currentDeviceId)
    .reduce((acc, d) => acc + Math.max(0, d.lastRateKps || 0), 0);
  const currentDeviceSavedRate =
    sessionData.devices.find((d) => d.id === currentDeviceId)?.lastRateKps ?? 0;
  const effectiveRateForEstimate =
    isRunning && liveKeysPerSec > 0
      ? otherOnlineRateKps + liveKeysPerSec
      : otherOnlineRateKps > 0
        ? otherOnlineRateKps + currentDeviceSavedRate
        : currentDeviceSavedRate > 0
          ? currentDeviceSavedRate
          : Math.max(0, ...sessionData.devices.map((d) => d.lastRateKps || 0));

  const fullKeyspaceProgressPct = calculateKeyspaceProgressPercent(totalCheckedWithCurrent);
  const fullKeyspaceProgressText = formatKeyspaceProgressPercent(totalCheckedWithCurrent, locale);
  const fullSpaceSeconds = estimateFullKeyspaceSeconds(
    effectiveRateForEstimate,
    totalCheckedWithCurrent,
  );
  const halfSpaceSeconds = fullSpaceSeconds !== null ? fullSpaceSeconds / 2 : null;
  const reference3MSeconds = estimateFullKeyspaceSeconds(3_000_000, totalCheckedWithCurrent);

  const payoutPreview = useMemo(() => {
    const feeRate = BigInt(networkInfo?.slipstreamFeeRateSatVb ?? DEFAULT_FEE_RATE_SAT_VB * 2);
    const totalAddressBalanceSats = networkInfo
      ? BigInt(networkInfo.totalBalanceSats)
      : DEFAULT_PUZZLE_71_BALANCE_SATS;

    const allUtxos = networkInfo?.utxos ?? [];
    const marginalCost = 148n * feeRate;
    const economical = allUtxos.filter((u) => BigInt(u.valueSats) > marginalCost);
    const activeUtxos = economical.length > 0 ? economical : allUtxos;

    const spendableSats =
      activeUtxos.length > 0
        ? activeUtxos.reduce((acc, u) => acc + BigInt(u.valueSats), 0n)
        : totalAddressBalanceSats;

    const inputCount = Math.max(1, activeUtxos.length);
    const estVb = BigInt(estimatePuzzleTxVbytes(34, 34, inputCount));
    const estFeeSats = estVb * feeRate;
    const split = calculatePayoutSplit(spendableSats, estFeeSats, locale);
    return {
      ...split,
      totalAddressBalanceSats,
      utxoCount: networkInfo?.utxoCount ?? 1,
      spendableCount: inputCount,
      feeRate,
    };
  }, [networkInfo, locale]);

  const isHardwareChecking = !hardware || isProbingHardware;
  const isHardwareFailed = Boolean(hardware && !isProbingHardware && !hardware.selfTestPassed);
  const isHardwareReady = Boolean(hardware && !isProbingHardware && hardware.selfTestPassed);

  return (
    <div className="mx-auto max-w-[1280px] px-6 py-8 space-y-6">
      {/* Shareable Multi-Device URL Banner */}
      <section className="rounded-xl border border-[#222938] bg-[#11151E] p-5 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
              <span>{isCs ? 'Výplatní adresa (85 %)' : 'Payout Address (85%)'}</span>
              <span aria-hidden="true">·</span>
              <span className="text-slate-200 font-medium">{sessionData.session.addressType}</span>
            </div>
            <p className="mt-1 font-mono text-sm text-slate-100 break-all">
              {sessionData.session.btcAddress}
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 shrink-0">
            <div className="flex items-center rounded-lg border border-[#283144] bg-[#0B0E15] px-3 py-2 font-mono text-xs text-slate-300 max-w-full sm:max-w-[340px] truncate">
              <span className="truncate">{shareUrl}</span>
            </div>
            <button
              type="button"
              onClick={handleCopyUrl}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#283144] bg-[#181E2B] px-3.5 py-2 text-xs font-medium text-slate-200 hover:border-[#3A4761] hover:bg-[#1F2738] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copiedUrl ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                  <span>{isCs ? 'Zkopírováno' : 'Copied'}</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{isCs ? 'Kopírovat URL' : 'Copy URL'}</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => setShowQr((v) => !v)}
              aria-expanded={showQr}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#283144] bg-[#181E2B] px-3.5 py-2 text-xs font-medium text-slate-200 hover:border-[#3A4761] hover:bg-[#1F2738] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <QrCode className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{isCs ? 'QR pro další zařízení' : 'QR for Other Devices'}</span>
            </button>
          </div>
        </div>

        {showQr && (
          <div className="mt-5 flex flex-col sm:flex-row items-start sm:items-center gap-5 border-t border-[#1D2432] pt-5">
            <div className="rounded-lg bg-white p-2.5 shrink-0">
              <QRCodeSVG value={shareUrl} size={116} />
            </div>
            <div className="text-xs text-slate-400 space-y-1.5 max-w-xl">
              <p className="text-sm font-medium text-slate-200">
                {isCs
                  ? 'Připojte další počítač nebo telefon pod stejnou adresu'
                  : 'Connect another PC or phone under the same payout address'}
              </p>
              <p>
                {isCs
                  ? 'Naskenujte QR kód nebo zkopírujte URL výše a otevřete ji na dalším zařízení. Server každému zařízení automaticky přidělí unikátní blok klíčů (podle zvoleného režimu), takže nikdy nepočítáte stejný prostor dvakrát.'
                  : 'Scan the QR code or copy the URL above to open it on another device. The server assigns non-overlapping keyspace blocks per device according to your chosen strategy.'}
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Primary Compute Console */}
      <section className="rounded-xl border border-[#222938] bg-[#11151E] p-6 sm:p-8">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
              <span className="inline-flex items-center gap-1.5 font-medium text-slate-200">
                <Cpu className="h-3.5 w-3.5 text-[#F7931A] shrink-0" aria-hidden="true" />
                {isHardwareChecking
                  ? isCs
                    ? 'Inicializuji a ověřuji výpočetní hardware...'
                    : 'Initializing and verifying compute hardware...'
                  : hardware?.mode === 'webgpu'
                    ? `WebGPU Compute (${hardware.adapterName})`
                    : `CPU WebWorker Fallback (${hardware?.adapterName ?? ''})`}
              </span>
              {isHardwareReady && hardware && (
                <span className="text-emerald-400">
                  {isCs
                    ? `Selftest ověřen (${hardware.selfTestDurationMs} ms)`
                    : `Self-test passed (${hardware.selfTestDurationMs} ms)`}
                </span>
              )}
            </div>

            <h1 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight text-slate-100">
              {isRunning
                ? isCs
                  ? 'Probíhá paralelní hledání Puzzle #71'
                  : 'Scanning Puzzle #71 Keyspace'
                : isHardwareChecking
                  ? isCs
                    ? 'Příprava a ověřování výpočetního uzlu…'
                    : 'Preparing & Verifying Compute Node…'
                  : isHardwareFailed
                    ? isCs
                      ? 'Ověření výpočetního jádra selhalo'
                      : 'Compute Kernel Verification Failed'
                    : currentBlock
                      ? isCs
                        ? 'Výpočet pozastaven (blok je rezervován)'
                        : 'Compute Paused (Block Reserved)'
                      : isCs
                        ? 'Výpočetní uzel připraven'
                        : 'Compute Node Ready'}
            </h1>
            <p className="text-xs text-slate-400 max-w-2xl">
              {isHardwareChecking
                ? isCs
                  ? 'Probíhá kryptografický selftest secp256k1 + SHA-256 + RIPEMD-160. Jakmile skončí, tlačítko spuštění se aktivuje.'
                  : 'Running secp256k1 + SHA-256 + RIPEMD-160 cryptographic self-test. The start button unlocks automatically once verified.'
                : !isRunning && currentBlock
                  ? isCs
                    ? 'Aktuální blok zůstává držen pro tento prohlížeč, dokud zůstanete na stránce. Můžete kdykoliv pokračovat od rozpracovaného místa.'
                    : 'Your active block stays reserved in this browser tab as long as the page remains open. Resume anytime from your saved offset.'
                  : hardware?.selfTestDetails}
            </p>
          </div>

          <div className="shrink-0 flex flex-col items-stretch sm:items-end gap-2.5">
            <div
              role="group"
              aria-label={isCs ? 'Výkonnostní profil výpočtu' : 'Compute performance profile'}
              className={`grid grid-cols-2 rounded-lg border border-[#222938] bg-[#0B0E15] p-1 gap-1 ${
                !canChangeComputeProfile(isRunning, isBusyStarting) ? 'opacity-80' : ''
              }`}
            >
              <button
                type="button"
                disabled={!canChangeComputeProfile(isRunning, isBusyStarting)}
                aria-pressed={computeProfile === 'max'}
                onClick={() => onChangeComputeProfile?.('max')}
                title={
                  !canChangeComputeProfile(isRunning, isBusyStarting)
                    ? isCs
                      ? 'Přepínání výkonu je během výpočtu uzamčeno — nejprve klikněte na Pauza.'
                      : 'Profile switching is locked while scanning — click Pause first.'
                    : isCs
                      ? 'Plný výkon GPU (2 fronty, 160 ms) / 100 % CPU vláken'
                      : 'Full GPU queue (2 slots, 160 ms) / 100% CPU threads'
                }
                className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer disabled:cursor-not-allowed ${
                  computeProfile === 'max'
                    ? 'bg-[#241B10] text-[#F7931A] border border-[#F7931A]/50'
                    : 'text-slate-400 hover:text-slate-200 border border-transparent disabled:opacity-45 disabled:hover:text-slate-400'
                }`}
              >
                <Zap className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Max</span>
              </button>
              <button
                type="button"
                disabled={!canChangeComputeProfile(isRunning, isBusyStarting)}
                aria-pressed={computeProfile === 'smooth'}
                onClick={() => onChangeComputeProfile?.('smooth')}
                title={
                  !canChangeComputeProfile(isRunning, isBusyStarting)
                    ? isCs
                      ? 'Přepínání výkonu je během výpočtu uzamčeno — nejprve klikněte na Pauza.'
                      : 'Profile switching is locked while scanning — click Pause first.'
                    : isCs
                      ? 'Plynulý chod prohlížeče s minimální ztrátou výkonu (1 GPU fronta ~75 ms / nízká zátěž CPU)'
                      : 'Smooth browser responsiveness with minimal speed loss (1 GPU slot ~75 ms / high CPU throughput)'
                }
                className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer disabled:cursor-not-allowed ${
                  computeProfile === 'smooth'
                    ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/45'
                    : 'text-slate-400 hover:text-slate-200 border border-transparent disabled:opacity-45 disabled:hover:text-slate-400'
                }`}
              >
                <Gauge className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Smooth</span>
              </button>
            </div>

            <button
              type="button"
              disabled={!isHardwareReady || isBusyStarting}
              onClick={onToggleRun}
              className={`inline-flex w-full sm:w-auto items-center justify-center gap-2.5 rounded-lg px-7 py-3.5 text-sm font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-45 ${
                isRunning
                  ? 'border border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
                  : 'bg-[#F7931A] text-[#090B10] hover:bg-[#ff9f2e]'
              }`}
            >
              {isRunning ? (
                <>
                  <Pause className="h-4 w-4" aria-hidden="true" />
                  <span>{isCs ? 'Pauza' : 'Pause'}</span>
                </>
              ) : isBusyStarting ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>{isCs ? 'Přiděluji unikátní blok…' : 'Leasing unique block…'}</span>
                </>
              ) : isHardwareChecking ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>{isCs ? 'Ověřuji hardware…' : 'Verifying hardware…'}</span>
                </>
              ) : isHardwareFailed ? (
                <span>{isCs ? 'Selftest selhal' : 'Self-test failed'}</span>
              ) : currentBlock ? (
                <>
                  <Play className="h-4 w-4" aria-hidden="true" />
                  <span>{isCs ? 'Pokračovat ve výpočtu' : 'Resume Scan'}</span>
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" aria-hidden="true" />
                  <span>
                    {hardware?.mode === 'webgpu'
                      ? isCs
                        ? 'Spustit WebGPU výpočet'
                        : 'Start WebGPU Scan'
                      : isCs
                        ? 'Spustit výpočet'
                        : 'Start Scan'}
                  </span>
                </>
              )}
            </button>

            <p className="inline-flex items-center justify-end gap-1.5 text-[11px] text-slate-400 sm:text-right">
              {!canChangeComputeProfile(isRunning, isBusyStarting) ? (
                <>
                  <Lock className="h-3 w-3 shrink-0 text-amber-400/80" aria-hidden="true" />
                  <span>
                    {isCs
                      ? 'Pro přepnutí mezi Max a Smooth nejprve klikněte na Pauza.'
                      : 'Click Pause first to switch between Max and Smooth.'}
                  </span>
                </>
              ) : computeProfile === 'smooth' ? (
                <span>
                  {isCs
                    ? 'Smooth: 1 GPU fronta (~75 ms) / plynulý chod s minimálním poklesem výkonu'
                    : 'Smooth: 1 GPU slot (~75 ms) / smooth browser with minimal throughput loss'}
                </span>
              ) : (
                <span>
                  {isCs
                    ? 'Max: plný výkon GPU (2 fronty, 160 ms) / 100 % CPU vláken'
                    : 'Max: full GPU throughput (2 slots, 160 ms) / 100% CPU threads'}
                </span>
              )}
            </p>
          </div>
        </div>

        {hardware && hardware.mode === 'cpu' && (
          <div
            role="status"
            className="mt-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-amber-500/35 bg-amber-950/25 px-4 py-3 text-xs text-amber-200"
          >
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="space-y-1">
                <p className="font-semibold text-amber-300">
                  {isCs
                    ? `Aktivní nouzový režim CPU (${hardware.cpuThreads ?? 1} ${(hardware.cpuThreads ?? 1) === 1 ? 'vlákno' : 'vláken'}) — bez GPU akcelerace`
                    : `CPU Fallback Active (${hardware.cpuThreads ?? 1} ${(hardware.cpuThreads ?? 1) === 1 ? 'thread' : 'threads'}) — No GPU Acceleration`}
                </p>
                <p className="text-amber-200/80 leading-relaxed">
                  {hardware.fallbackReason || hardware.adapterName}.{' '}
                  {isCs
                    ? 'CPU dosahuje řádově stovek kKeys/s oproti MKeys/s na WebGPU. Pokud jste v náhledovém okně (iframe) nebo prohlížeči s vypnutým WebGPU, otevřete aplikaci přímo v novém okně Chrome/Edge nebo ověřte GPU znovu.'
                    : 'CPU runs at hundreds of kKeys/s compared to MKeys/s on WebGPU. If you are in an embedded preview iframe or browser with WebGPU disabled, open this page in Chrome/Edge directly or re-probe GPU.'}
                </p>
              </div>
            </div>
            {onRetryWebGPU && !isRunning && (
              <button
                type="button"
                disabled={isProbingHardware}
                onClick={onRetryWebGPU}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3.5 py-2 text-xs font-medium text-amber-200 hover:bg-amber-500/25 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${isProbingHardware ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                <span>
                  {isProbingHardware
                    ? isCs
                      ? 'Ověřuji GPU...'
                      : 'Probing GPU...'
                    : isCs
                      ? 'Znovu ověřit WebGPU'
                      : 'Re-probe WebGPU'}
                </span>
              </button>
            )}
          </div>
        )}

        {engineError && (
          <div
            role="alert"
            className="mt-5 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-xs text-red-300"
          >
            {engineError}
          </div>
        )}

        {/* Block Selection Mode & Sequential Position Picker */}
        <div className="mt-5 border-t border-[#1D2432] pt-5 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-200">
                {isCs ? 'Způsob přidělování bloků' : 'Block Allocation Strategy'}
              </h2>
              <p className="text-xs text-slate-400">
                {isCs
                  ? 'Vyberte, zda má server navrhovat bloky náhodně napříč celým prostorem, nebo plynule za sebou.'
                  : 'Choose whether the server assigns random non-overlapping blocks across the range or sequential blocks from a chosen position.'}
              </p>
            </div>
            {isRunning && (
              <span className="text-[11px] text-amber-300/80">
                {isCs
                  ? 'Pro změnu strategie nejprve pozastavte výpočet'
                  : 'Pause scanning first to switch strategy'}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              disabled={isRunning || isUpdatingStrategy}
              onClick={() => onUpdateStrategy?.('random')}
              className={`flex items-start gap-3 rounded-lg border p-3 text-left cursor-pointer disabled:cursor-not-allowed ${
                strategyMode === 'random'
                  ? 'border-[#F7931A]/70 bg-[#1B1712] text-slate-100'
                  : 'border-[#222938] bg-[#0B0E15] text-slate-300 hover:border-[#323D54] disabled:text-slate-400'
              }`}
            >
              <Shuffle
                className={`h-4 w-4 shrink-0 mt-0.5 ${
                  strategyMode === 'random' ? 'text-[#F7931A]' : 'text-slate-400'
                }`}
                aria-hidden="true"
              />
              <div className="space-y-0.5">
                <div className="text-xs font-semibold">
                  {isCs ? 'Náhodné bloky (Doporučeno)' : 'Random Blocks (Recommended)'}
                </div>
                <div className="text-[11px] text-slate-400 leading-relaxed">
                  {isCs
                    ? 'Každé zařízení dostane náhodný unikátní blok z celého prostoru klíčů.'
                    : 'Each device receives a unique random block sampled across the full keyspace.'}
                </div>
              </div>
            </button>

            <button
              type="button"
              disabled={isRunning || isUpdatingStrategy}
              onClick={() => onUpdateStrategy?.('sequential', draftPercent)}
              className={`flex items-start gap-3 rounded-lg border p-3 text-left cursor-pointer disabled:cursor-not-allowed ${
                strategyMode === 'sequential'
                  ? 'border-[#F7931A]/70 bg-[#1B1712] text-slate-100'
                  : 'border-[#222938] bg-[#0B0E15] text-slate-300 hover:border-[#323D54] disabled:text-slate-400'
              }`}
            >
              <ListOrdered
                className={`h-4 w-4 shrink-0 mt-0.5 ${
                  strategyMode === 'sequential' ? 'text-[#F7931A]' : 'text-slate-400'
                }`}
                aria-hidden="true"
              />
              <div className="space-y-0.5">
                <div className="text-xs font-semibold">
                  {isCs ? 'Sekvenčně (Bloky za sebou)' : 'Sequential (Ordered Blocks)'}
                </div>
                <div className="text-[11px] text-slate-400 leading-relaxed">
                  {isCs
                    ? 'Bloky jdou plynule jeden za druhým od místa, které si zvolíte níže.'
                    : 'Blocks advance contiguously one after another from the starting offset below.'}
                </div>
              </div>
            </button>
          </div>

          {strategyMode === 'sequential' && (
            <div className="rounded-lg border border-[#222938] bg-[#0B0E15] p-3.5 space-y-2.5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-200">
                  {isCs
                    ? 'Odkud v rozsahu Puzzle #71 začít?'
                    : 'Where in Puzzle #71 range should scanning start?'}
                </span>
                <span className="font-mono text-xs text-[#F7931A]">
                  {isCs
                    ? `Pozice ${formatLocalizedDecimal(draftPercent, 2, locale)} % rozsahu`
                    : `Position ${formatLocalizedDecimal(draftPercent, 2, locale)}% of range`}
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                {sequentialPresets.map((preset) => {
                  const isActive = Math.abs(draftPercent - preset.percent) < 0.05;
                  return (
                    <button
                      key={preset.percent}
                      type="button"
                      disabled={isRunning || isUpdatingStrategy}
                      onClick={() => {
                        setDraftPercent(preset.percent);
                        void onUpdateStrategy?.('sequential', preset.percent);
                      }}
                      className={`rounded-lg border px-2.5 py-1 text-xs font-medium cursor-pointer disabled:cursor-not-allowed ${
                        isActive
                          ? 'border-[#F7931A] bg-[#241B10] text-[#F7931A]'
                          : 'border-[#283144] bg-[#141925] text-slate-300 hover:border-[#3A4761]'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>

              <div className="space-y-1">
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    aria-label={
                      isCs
                        ? 'Startovní pozice v rozsahu Puzzle #71 v procentech'
                        : 'Puzzle #71 starting position percentage'
                    }
                    min={0}
                    max={99.9}
                    step={0.1}
                    disabled={isRunning || isUpdatingStrategy}
                    value={Math.min(99.9, draftPercent)}
                    onChange={(e) => setDraftPercent(Number(e.target.value))}
                    className="w-full accent-[#F7931A] cursor-pointer disabled:cursor-not-allowed"
                  />
                  <div className="flex items-center gap-1.5 shrink-0">
                    <input
                      type="number"
                      aria-label={
                        isCs
                          ? 'Přesná startovní pozice v procentech'
                          : 'Exact starting position percentage'
                      }
                      min={0}
                      max={99.99}
                      step={0.1}
                      disabled={isRunning || isUpdatingStrategy}
                      value={draftPercent}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        if (Number.isFinite(val)) {
                          setDraftPercent(Math.max(0, Math.min(99.99, val)));
                        }
                      }}
                      className="w-20 rounded-md border border-[#283144] bg-[#141925] px-2 py-1 text-right font-mono text-xs text-slate-100 focus:border-[#F7931A] focus:outline-none"
                    />
                    <span className="text-xs text-slate-400">%</span>
                  </div>
                  {percentDirty && (
                    <button
                      type="button"
                      disabled={isRunning || isUpdatingStrategy}
                      onClick={() => onUpdateStrategy?.('sequential', draftPercent)}
                      className="rounded-lg bg-[#F7931A] px-3 py-1.5 text-xs font-semibold text-[#090B10] hover:bg-[#ff9f2e] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
                    >
                      {isUpdatingStrategy
                        ? isCs
                          ? 'Ukládám...'
                          : 'Saving...'
                        : isCs
                          ? 'Použít pozici'
                          : 'Apply Position'}
                    </button>
                  )}
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>{isCs ? '0 % · Úplný začátek rozsahu' : '0% · Range start'}</span>
                  <span>{isCs ? '50 % · Přesná polovina' : '50% · Exact midpoint'}</span>
                  <span>{isCs ? '100 % · Konec rozsahu' : '100% · Range end'}</span>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 border-t border-[#181F2D] pt-2 text-[11px] text-slate-400">
                <span>
                  {isCs ? 'Další sekvenční blok:' : 'Next sequential block:'}{' '}
                  <span className="font-mono text-slate-200">#{previewRange.blockIndexStr}</span> (
                  {isCs ? 'od' : 'from'}{' '}
                  <span className="font-mono text-slate-300">{previewRange.startKeyHex}</span>)
                </span>
                {currentBlock && currentOffsetInBlock > 0 && (
                  <span className="text-slate-500">
                    {isCs
                      ? 'Rozpracovaný blok se dokončí a nový už půjde od této pozice.'
                      : 'The active block finishes first, then new leases start from this offset.'}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Active Block Progress */}
        <div className="mt-5 border-t border-[#1D2432] pt-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
            <div className="font-mono text-slate-300 flex flex-wrap items-center gap-x-2 gap-y-1">
              {currentBlock ? (
                <>
                  <span>
                    {isCs ? 'Aktivní unikátní blok' : 'Active unique block'}{' '}
                    <span className="text-[#F7931A]">#{currentBlock.blockIndex}</span>
                  </span>
                  {batchStatus && batchStatus.total > 1 && (
                    <span className="rounded bg-[#182030] border border-[#2B374F] px-2 py-0.5 text-[11px] text-sky-300">
                      {isCs
                        ? `Dávka GPU: blok ${batchStatus.current} / ${batchStatus.total} v řadě`
                        : `GPU batch: block ${batchStatus.current} / ${batchStatus.total}`}
                    </span>
                  )}
                  <span className="text-slate-600">|</span>
                  <span>
                    {currentBlock.startKeyHex} → {currentBlock.endKeyHex}
                  </span>
                </>
              ) : (
                <span className="text-slate-500">
                  {isCs
                    ? `Po spuštění vám server přidělí ${strategyMode === 'sequential' ? 'sekvenční' : 'náhodný'} blok o velikosti ${formatLocalizedNumber(sessionData.stats.blockSizeKeys, locale)} klíčů (~3–5 min při ~3 MKeys/s; rychlejší GPU automaticky dostávají souvislé dávky 2–8 bloků).`
                    : `Upon start, the server leases a ${strategyMode === 'sequential' ? 'sequential' : 'random'} block of ${formatLocalizedNumber(sessionData.stats.blockSizeKeys, locale)} keys (~3–5 min at ~3 MKeys/s; faster GPUs automatically receive contiguous 2–8 block batches).`}
                </span>
              )}
            </div>
            <div className="font-mono tabular-nums text-slate-300">
              {currentBlock
                ? `${formatLocalizedNumber(currentOffsetInBlock, locale)} / ${formatLocalizedNumber(currentBlock.totalKeys, locale)} ${isCs ? 'klíčů' : 'keys'} (${formatLocalizedDecimal(blockProgressPct, 2, locale)}${isCs ? ' %' : '%'})`
                : isCs
                  ? '0 %'
                  : '0%'}
            </div>
          </div>

          <div
            role="progressbar"
            aria-valuenow={Math.round(blockProgressPct)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[#0B0E15] border border-[#1E2534]"
          >
            <div
              className="h-full w-full origin-left bg-[#F7931A] will-change-transform transition-transform duration-200"
              style={{ transform: `scaleX(${Math.max(0, Math.min(1, blockProgressPct / 100))})` }}
            />
          </div>

          <div className="mt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-500">
            <p className="font-mono truncate">
              {currentBlock && !isRunning ? (
                <span className="text-amber-300/90">
                  {isCs
                    ? 'Pauza aktivní — blok je držen v prohlížeči, dokud budete pokračovat nebo neodejdete'
                    : 'Pause active — block stays held in this tab until you resume or close'}
                </span>
              ) : currentKeyHex ? (
                <>
                  {isCs ? 'Aktuálně testovaný klíč:' : 'Current tested key:'}{' '}
                  <span className="text-slate-300">{currentKeyHex}</span>
                </>
              ) : isCs ? (
                'Ochrana proti podvodnému hlášení: server ověřuje PoW podíly z výpočtu.'
              ) : (
                'Anti-cheat verification: server validates cryptographic PoW shares per block.'
              )}
            </p>
            {currentBlock && (
              <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-slate-400 shrink-0">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                {isCs
                  ? `Ověřené PoW důkazy: ${currentPowCount} / ${requiredPowCount}`
                  : `Verified PoW shares: ${currentPowCount} / ${requiredPowCount}`}
              </span>
            )}
          </div>
        </div>

        {/* 4-column Tabular Metrics Strip */}
        <div className="mt-5 grid grid-cols-2 lg:grid-cols-4 gap-4 border-t border-[#1D2432] pt-5">
          <div>
            <p className="text-xs text-slate-400">{isCs ? 'Aktuální rychlost' : 'Live Hashrate'}</p>
            <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-100">
              {formatRate(liveKeysPerSec)}
            </p>
            {dispatchTelemetry && (
              <p className="mt-0.5 font-mono text-[11px] text-slate-500 tabular-nums">
                {dispatchTelemetry.workgroups > 0
                  ? `${dispatchTelemetry.workgroups} wg · ${formatLocalizedNumber(dispatchTelemetry.checked, locale)} ${isCs ? 'klíčů' : 'keys'} (${Math.round(dispatchTelemetry.elapsedMs)} ms)`
                  : `${isCs ? `CPU dávka (${getCpuThreadsForProfile(computeProfile, hardware?.cpuThreads)} vláken)` : `CPU batch (${getCpuThreadsForProfile(computeProfile, hardware?.cpuThreads)} threads)`} · ${formatLocalizedNumber(dispatchTelemetry.checked, locale)} ${isCs ? 'klíčů' : 'keys'} (${Math.round(dispatchTelemetry.elapsedMs)} ms)`}
              </p>
            )}
          </div>
          <div>
            <p className="text-xs text-slate-400">
              {isCs ? 'Prohledáno uživatelem' : 'Keys Scanned (Session)'}
            </p>
            <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-100">
              {formatLocalizedNumber(totalCheckedWithCurrent, locale)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-400">
              {isCs ? 'Dokončené bloky' : 'Completed Blocks'}
            </p>
            <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-100">
              {formatLocalizedNumber(sessionData.stats.completedBlocksCount, locale)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-400">
              {isCs ? 'Připojená zařízení' : 'Connected Devices'}
            </p>
            <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-100">
              {isCs
                ? `${onlineDevicesCount} aktivní / ${sessionData.devices.length} celkem`
                : `${onlineDevicesCount} online / ${sessionData.devices.length} total`}
            </p>
          </div>
        </div>

        {/* User Session Full-Range Progress & Estimated Total Space Duration */}
        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-[#1D2432] pt-5">
          <div className="rounded-lg border border-[#1E2534] bg-[#0B0E15] p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                <Compass className="h-3.5 w-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
                <span>
                  {isCs
                    ? 'Progres z celého rozsahu Puzzle #71 (2⁷⁰)'
                    : 'Progress Across Puzzle #71 Keyspace (2⁷⁰)'}
                </span>
              </span>
              <span className="text-[11px] font-mono text-slate-500">
                {isCs ? 'Sólo prostor této adresy' : 'Solo space for this address'}
              </span>
            </div>
            <p className="font-mono text-lg font-semibold tabular-nums text-emerald-400">
              {fullKeyspaceProgressText}
            </p>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#141925] border border-[#1E2534]">
              <div
                className="h-full w-full origin-left bg-emerald-400 will-change-transform transition-transform duration-300"
                style={{
                  transform: `scaleX(${
                    totalCheckedWithCurrent > 0
                      ? Math.max(0.006, Math.min(1, fullKeyspaceProgressPct / 100))
                      : 0
                  })`,
                }}
              />
            </div>
            <p className="font-mono text-[11px] text-slate-500 tabular-nums">
              {formatLocalizedNumber(totalCheckedWithCurrent, locale)}{' '}
              {isCs ? 'z 1,18 × 10²¹ klíčů' : 'of 1.18 × 10²¹ keys'} ·{' '}
              {formatLocalizedNumber(sessionData.stats.completedBlocksCount, locale)}{' '}
              {isCs ? 'z' : 'of'} {formatLocalizedNumber(2_199_023_255_552, locale)}{' '}
              {isCs ? 'bloků' : 'blocks'}
            </p>
          </div>

          <div className="rounded-lg border border-[#1E2534] bg-[#0B0E15] p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                <Clock className="h-3.5 w-3.5 text-[#F7931A] shrink-0" aria-hidden="true" />
                <span>
                  {isCs ? 'Čas na projítí celého prostoru (100 %)' : 'Full Space Sweep ETA (100%)'}
                </span>
              </span>
              {effectiveRateForEstimate > 0 && (
                <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                  {formatRate(effectiveRateForEstimate)}
                </span>
              )}
            </div>
            {fullSpaceSeconds !== null ? (
              <>
                <p className="font-mono text-lg font-semibold tabular-nums text-[#F7931A]">
                  {formatDurationFromSeconds(fullSpaceSeconds, locale)}
                </p>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  {isRunning
                    ? isCs
                      ? 'Při aktuálním výkonu'
                      : 'At current speed'
                    : isCs
                      ? 'Při poslední změřené rychlosti'
                      : 'At last measured speed'}{' '}
                  · {isCs ? 'průměrná 50% pravděpodobnost nálezu:' : '50% median probability:'}{' '}
                  <span className="font-mono text-slate-200 tabular-nums">
                    ~{formatDurationFromSeconds(halfSpaceSeconds, locale)}
                  </span>
                </p>
              </>
            ) : (
              <>
                <p className="font-mono text-lg font-semibold text-slate-300">
                  {isCs ? 'Čeká na změření rychlosti' : 'Waiting for speed measurement'}
                </p>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  {isCs ? 'Orientačně při 3,00 MKeys/s:' : 'Reference at 3.00 MKeys/s:'}{' '}
                  <span className="font-mono text-slate-300 tabular-nums">
                    ~{formatDurationFromSeconds(reference3MSeconds, locale)}
                  </span>{' '}
                  ({isCs ? '50 % šance' : '50% odds'}: ~
                  {formatDurationFromSeconds(
                    reference3MSeconds !== null ? reference3MSeconds / 2 : null,
                    locale,
                  )}
                  )
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      {/* Live Keys/s Speed History & Stability Chart */}
      <SpeedHistoryChart
        history={speedHistory}
        isRunning={isRunning}
        onlineDevicesCount={onlineDevicesCount}
        fleetRateKps={fleetRateKps}
      />

      {/* Safe Demo Puzzle #5 Verification Card */}
      {onRunDemoPuzzle5 && (
        <section className="rounded-xl border border-[#222938] bg-[#11151E] p-6">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="space-y-1.5 max-w-2xl">
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-amber-300">
                <FlaskConical className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  {isCs
                    ? 'Testovací Demo Puzzle #5 (pouze ukázka nálezu klíče)'
                    : 'Verification Demo Puzzle #5 (Safe End-to-End Dry-Run)'}
                </span>
              </div>
              <h2 className="text-base font-semibold text-slate-100">
                {isCs
                  ? 'Vyzkoušet funkčnost celého řetězce na 5bitovém klíči'
                  : 'Verify the Full Key-Discovery & Signing Pipeline on a 5-Bit Key'}
              </h2>
              <p className="text-xs text-slate-400 leading-relaxed">
                {isCs ? (
                  <>
                    Kryptografické jádro skutečně prohledá malý rozsah{' '}
                    <span className="font-mono text-slate-300">0x10 → 0x1f</span> (16 klíčů) proti
                    adrese <span className="font-mono text-slate-300">{DEMO_PUZZLE_5_ADDRESS}</span>,
                    nalezne platný klíč, lokálně podepíše testovací transakci (85 % / 15 % z 0,005
                    BTC) a provede <strong>Dry-Run</strong> kontrolu privátních poolů. Vaše bloky
                    Puzzle #71 zůstanou nedotčené.
                  </>
                ) : (
                  <>
                    The compute engine actually scans{' '}
                    <span className="font-mono text-slate-300">0x10 → 0x1f</span> (16 keys) against{' '}
                    <span className="font-mono text-slate-300">{DEMO_PUZZLE_5_ADDRESS}</span>,
                    recovers the matching private key, locally signs a 0.005 BTC test payout (85% /
                    15%), and performs a <strong>Dry-Run</strong> private pool check. Your Puzzle
                    #71 blocks remain untouched.
                  </>
                )}
              </p>
            </div>

            <button
              type="button"
              disabled={!isHardwareReady || isRunning || isBusyStarting || isRunningDemo}
              onClick={onRunDemoPuzzle5}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#334155] bg-[#181E2B] px-5 py-3 text-xs font-semibold text-slate-100 hover:border-[#F7931A] hover:bg-[#1E2535] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-45"
            >
              {isRunningDemo ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin text-[#F7931A]" aria-hidden="true" />
                  <span>{isCs ? 'Prohledávám Puzzle #5…' : 'Scanning Puzzle #5…'}</span>
                </>
              ) : (
                <>
                  <FlaskConical className="h-3.5 w-3.5 text-[#F7931A]" aria-hidden="true" />
                  <span>{isCs ? 'Spustit Demo Puzzle #5' : 'Run Demo Puzzle #5'}</span>
                </>
              )}
            </button>
          </div>

          {demoScanStatus && (
            <div className="mt-4 border-t border-[#1D2432] pt-3 space-y-2">
              <div className="flex items-center justify-between text-xs font-mono text-slate-300">
                <span>
                  {isCs ? 'Testovaný klíč:' : 'Tested key:'}{' '}
                  <span className="text-[#F7931A]">{demoScanStatus.testedKeyHex}</span>
                </span>
                <span>
                  {demoScanStatus.progressPct}
                  {isCs ? ' % rozsahu' : '% of range'}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#0B0E15] border border-[#1E2534]">
                <div
                  className="h-full bg-emerald-400 transition-all duration-150"
                  style={{ width: `${demoScanStatus.progressPct}%` }}
                />
              </div>
            </div>
          )}

          {demoClaimState && (
            <div className="mt-5">
              <ClaimBanner
                inline
                isDemo
                puzzleNumber={DEMO_PUZZLE_5_NUMBER}
                foundKeyHex={demoClaimState.foundKeyHex}
                signedTx={demoClaimState.signedTx}
                broadcastResult={demoClaimState.broadcastResult}
                onDismiss={onDismissDemoClaim}
              />
            </div>
          )}
        </section>
      )}

      {/* Live Puzzle #71 UTXO & 85/15 Split Preview */}
      <section className="rounded-xl border border-[#222938] bg-[#11151E] p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              {isCs
                ? 'Při nalezení řešení: Automatické rozdělení odměny'
                : 'On Solution Match: Automatic Payout Split'}
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              {isCs ? 'Cíl:' : 'Target:'}{' '}
              <span className="font-mono text-slate-200">{PUZZLE_71_ADDRESS}</span>
              <span className="mx-2 text-slate-600">·</span>
              <span>
                {isCs ? 'Zdroj UTXO:' : 'UTXO source:'}{' '}
                {networkInfo?.source === 'live-mempool'
                  ? isCs
                    ? 'Live Bitcoin síť'
                    : 'Live Bitcoin network'
                  : isCs
                    ? 'Výchozí hodnota Puzzle #71'
                    : 'Default Puzzle #71 balance'}
              </span>
            </p>
          </div>
          <div className="font-mono text-xs text-slate-400 tabular-nums">
            {isCs ? 'Prioritní poplatek pro Slipstream:' : 'Slipstream priority fee:'}{' '}
            {payoutPreview.feeRate.toString()} sat/vB (
            {formatLocalizedNumber(Number(payoutPreview.feeSats), locale)} sat)
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-[#1D2432] pt-5">
          <div>
            <p className="text-xs text-slate-400">
              {isCs ? 'Aktuální zůstatek Puzzle #71' : 'Current Puzzle #71 Balance'}
            </p>
            <p className="mt-1 font-mono text-base font-semibold tabular-nums text-slate-100">
              {formatBtcFromSats(payoutPreview.totalAddressBalanceSats)}
            </p>
            {networkInfo && (
              <p className="mt-0.5 text-[11px] text-slate-500">
                {payoutPreview.utxoCount} {isCs ? 'UTXO celkem' : 'total UTXOs'} ·{' '}
                {payoutPreview.spendableCount} {isCs ? 'ke sloučení' : 'economical to sweep'}
              </p>
            )}
          </div>
          <div>
            <p className="text-xs text-slate-400">
              {isCs ? 'Váš podíl (85 % po odečtení poplatku)' : 'Your Share (85% after miner fee)'}
            </p>
            <p className="mt-1 font-mono text-base font-semibold tabular-nums text-emerald-400">
              {formatBtcFromSats(payoutPreview.userSats)}
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-slate-400">
              {isCs ? 'Podíl admina (15 %)' : 'Platform Share (15%)'}
            </p>
            <p className="mt-1 font-mono text-base font-semibold text-slate-200">
              {isCs ? 'zbytek' : 'remainder'}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
