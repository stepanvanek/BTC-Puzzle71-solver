import { ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, Compass, Layers } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLocale } from '../i18n/LocaleContext.tsx';
import { formatLocalizedDecimal, formatLocalizedNumber } from '../i18n/locale.ts';
import type { SessionData } from '../types/api.ts';
import {
  type LiveActiveBlockOverlay,
  blockIndexToSectorIndex,
  buildKeyspaceSectors,
  formatSectorCompactTileBadge,
  formatSectorCoveragePercent,
} from '../utils/keyspaceSectors.ts';

interface KeyspaceSectorMapProps {
  sessionData: SessionData;
  liveActiveBlock?: LiveActiveBlockOverlay | null;
  isRunning?: boolean;
  isUpdatingStrategy?: boolean;
  onSelectSequentialSector?: (startPercent: number) => Promise<void>;
  onNavigateToCompute?: () => void;
}

export function KeyspaceSectorMap({
  sessionData,
  liveActiveBlock = null,
  isRunning = false,
  isUpdatingStrategy = false,
  onSelectSequentialSector,
  onNavigateToCompute,
}: KeyspaceSectorMapProps) {
  const { locale } = useLocale();
  const isCs = locale === 'cs';

  const sectors = useMemo(
    () =>
      buildKeyspaceSectors({
        persistedSectors: sessionData.sectors,
        recentBlocks: sessionData.recentBlocks,
        liveActiveBlock,
      }),
    [sessionData.sectors, sessionData.recentBlocks, liveActiveBlock],
  );

  const activeSeqSector = useMemo(() => {
    if (sessionData.strategy.blockMode !== 'sequential') return null;
    return blockIndexToSectorIndex(sessionData.strategy.seqCursor || '0');
  }, [sessionData.strategy.blockMode, sessionData.strategy.seqCursor]);

  const initialDefaultSector = useMemo(() => {
    if (activeSeqSector !== null) return activeSeqSector;
    const firstActive = sectors.find((s) => s.activeBlocksCount > 0);
    if (firstActive) return firstActive.sectorIndex;
    const firstPartial = sectors.find((s) => s.status === 'partial');
    if (firstPartial) return firstPartial.sectorIndex;
    return 0;
  }, [activeSeqSector, sectors]);

  const [selectedSectorIdx, setSelectedSectorIdx] = useState<number>(initialDefaultSector);
  const [strategyAppliedFeedback, setStrategyAppliedFeedback] = useState<number | null>(null);

  useEffect(() => {
    setStrategyAppliedFeedback(null);
  }, [sessionData.session.btcAddress]);

  const selected = sectors[selectedSectorIdx] ?? sectors[0];

  const counts = useMemo(() => {
    let completed = 0;
    let partial = 0;
    let unscanned = 0;
    for (const s of sectors) {
      if (s.status === 'completed') completed += 1;
      else if (s.status === 'partial') partial += 1;
      else unscanned += 1;
    }
    return { completed, partial, unscanned };
  }, [sectors]);

  const handleApplySectorAsSequentialStart = async () => {
    if (!onSelectSequentialSector || isRunning || isUpdatingStrategy) return;
    await onSelectSequentialSector(selected.startPercent);
    setStrategyAppliedFeedback(selected.sectorIndex);
  };

  const isExactSeqStartOnSelected =
    sessionData.strategy.blockMode === 'sequential' &&
    activeSeqSector === selected.sectorIndex &&
    Math.abs(sessionData.strategy.seqPercent - selected.startPercent) < 0.01;

  return (
    <section
      aria-labelledby="sector-map-heading"
      data-testid="keyspace-sector-map"
      className="rounded-xl border border-[#222938] bg-[#11151E] overflow-hidden"
    >
      <div className="border-b border-[#1D2432] px-6 py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <h2 id="sector-map-heading" className="text-sm font-semibold text-slate-100">
            {isCs
              ? 'Mapa prohledaného prostoru (100 sektorů · po 1 % rozsahu)'
              : 'Keyspace Coverage Map (100 Sectors · 1% Each)'}
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            {isCs
              ? 'Viditelné pouze pro vaši zadanou adresu. Kliknutím na libovolný čtvereček zobrazíte detail pokrytí nebo nastavíte začátek sekvenčního výpočtu.'
              : 'Visible only to your address session. Select any square to inspect sector progress or set the sequential scan start.'}
          </p>
        </div>

        {/* Accessible 3-state legend (swatch + explicit text + counts) */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-slate-300 shrink-0">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-3 w-3 rounded-[3px] border border-emerald-400/80 bg-emerald-500/35 shrink-0"
              aria-hidden="true"
            />
            <span>
              {isCs ? 'Projitý 100 %' : 'Completed 100%'}{' '}
              <span className="font-mono tabular-nums text-emerald-400">({counts.completed})</span>
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-3 w-3 rounded-[3px] border border-[#F7931A]/80 bg-[#F7931A]/30 shrink-0"
              aria-hidden="true"
            />
            <span>
              {isCs ? 'Částečně projitý' : 'Partially scanned'}{' '}
              <span className="font-mono tabular-nums text-[#F7931A]">({counts.partial})</span>
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-3 w-3 rounded-[3px] border border-[#2B354B] bg-[#131823] shrink-0"
              aria-hidden="true"
            />
            <span>
              {isCs ? 'Neprojitý' : 'Unscanned'}{' '}
              <span className="font-mono tabular-nums text-slate-400">({counts.unscanned})</span>
            </span>
          </span>
          {activeSeqSector !== null && (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-3 w-3 rounded-[3px] border border-sky-400 ring-1 ring-sky-400/60 bg-sky-500/20 shrink-0"
                aria-hidden="true"
              />
              <span className="text-sky-300">
                {isCs
                  ? `Aktivní sekvence (${formatLocalizedDecimal(sessionData.strategy.seqPercent, 1, locale)} %)`
                  : `Sequential start (${formatLocalizedDecimal(sessionData.strategy.seqPercent, 1, locale)}%)`}
              </span>
            </span>
          )}
        </div>
      </div>

      <div className="p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)] gap-6 items-start">
        {/* 10x10 Grid of 100 equal 1% keyspace sectors */}
        <div>
          <div
            role="grid"
            aria-label={
              isCs
                ? 'Mřížka 100 sektorů klíčového prostoru Puzzle #71'
                : '100-sector Puzzle #71 keyspace coverage grid'
            }
            data-testid="sector-grid-100"
            className="grid grid-cols-10 gap-1 sm:gap-1.5"
          >
            {sectors.map((sector) => {
              const isSelected = sector.sectorIndex === selected.sectorIndex;
              const isSeqHere = activeSeqSector === sector.sectorIndex;
              const compactBadge = formatSectorCompactTileBadge(sector, locale);

              const stateLabel =
                sector.status === 'completed'
                  ? isCs
                    ? 'kompletně projitý 100 %'
                    : 'completed 100%'
                  : sector.status === 'partial'
                    ? isCs
                      ? `částečně projitý (${formatSectorCoveragePercent(sector.coveragePercent, locale)})`
                      : `partially scanned (${formatSectorCoveragePercent(sector.coveragePercent, locale)})`
                    : isCs
                      ? 'neprojitý'
                      : 'unscanned';

              const surfaceClasses =
                sector.status === 'completed'
                  ? 'border-emerald-400/75 bg-emerald-500/20 text-emerald-100 hover:border-emerald-300 hover:bg-emerald-500/25'
                  : sector.status === 'partial'
                    ? 'border-[#F7931A]/75 bg-[#F7931A]/15 text-amber-100 hover:border-[#F7931A] hover:bg-[#F7931A]/20'
                    : 'border-[#232B3D] bg-[#131926] text-slate-400 hover:border-[#3A4863] hover:text-slate-200';

              const selectionRing = isSelected
                ? 'ring-2 ring-white/90 ring-offset-1 ring-offset-[#11151E]'
                : isSeqHere
                  ? 'ring-2 ring-sky-400/85 ring-offset-1 ring-offset-[#11151E]'
                  : '';

              return (
                <button
                  key={sector.sectorIndex}
                  type="button"
                  data-testid={`sector-cell-${sector.sectorIndex}`}
                  data-sector-status={sector.status}
                  aria-pressed={isSelected}
                  aria-label={
                    isCs
                      ? `Sektor ${sector.startPercent} až ${sector.endPercent} procent, ${stateLabel}${isSeqHere ? ', aktuální pozice sekvence' : ''}`
                      : `Sector ${sector.startPercent} to ${sector.endPercent} percent, ${stateLabel}${isSeqHere ? ', current sequential position' : ''}`
                  }
                  title={
                    isCs
                      ? `${sector.startPercent}–${sector.endPercent} % · ${formatSectorCoveragePercent(sector.coveragePercent, locale)} (${formatLocalizedNumber(sector.scannedKeys, locale)} klíčů)`
                      : `${sector.startPercent}–${sector.endPercent}% · ${formatSectorCoveragePercent(sector.coveragePercent, locale)} (${formatLocalizedNumber(sector.scannedKeys, locale)} keys)`
                  }
                  onClick={() => {
                    setSelectedSectorIdx(sector.sectorIndex);
                    setStrategyAppliedFeedback(null);
                  }}
                  className={`relative aspect-square rounded-[5px] border p-1 sm:p-1.5 flex flex-col justify-between text-left transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F7931A] ${surfaceClasses} ${selectionRing}`}
                >
                  <div className="flex items-start justify-between gap-0.5 leading-none">
                    <span className="font-mono tabular-nums text-[9px] sm:text-[10px] font-semibold">
                      {sector.startPercent}
                      <span className="hidden sm:inline">%</span>
                    </span>
                    {isSeqHere && (
                      <span
                        className="font-mono text-[8px] sm:text-[9px] font-bold text-sky-300 leading-none"
                        aria-hidden="true"
                      >
                        S
                      </span>
                    )}
                  </div>

                  {/* Numeric indicator for partial / completed on >= sm, plus bottom progress track on all screens */}
                  <div className="space-y-0.5 w-full">
                    {compactBadge && (
                      <div
                        className={`hidden sm:block font-mono tabular-nums text-[9px] leading-none truncate ${
                          sector.status === 'completed'
                            ? 'text-emerald-300 font-semibold'
                            : 'text-[#FFB35C] font-medium'
                        }`}
                      >
                        {compactBadge}
                      </div>
                    )}
                    <div className="h-1 w-full rounded-full bg-[#090C12]/90 overflow-hidden">
                      {sector.visualFillPercent > 0 && (
                        <div
                          className={`h-full ${
                            sector.status === 'completed' ? 'bg-emerald-400' : 'bg-[#F7931A]'
                          }`}
                          style={{ width: `${sector.visualFillPercent}%` }}
                        />
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-2.5 flex items-center justify-between text-[11px] text-slate-500 font-mono">
            <span>{isCs ? '0 % · Začátek rozsahu (2⁷⁰)' : '0% · Range start (2⁷⁰)'}</span>
            <span>
              {isCs ? 'Každý čtverec = 1 %' : 'Each square = 1%'}
            </span>
            <span>{isCs ? '100 % · Konec rozsahu' : '100% · Range end'}</span>
          </div>
        </div>

        {/* Selected Sector Detail Inspector & Sequential Start Selector */}
        <aside
          aria-label={isCs ? 'Detail vybraného sektoru' : 'Selected sector details'}
          data-testid="sector-inspector"
          className="border-t lg:border-t-0 lg:border-l border-[#1D2432] pt-5 lg:pt-0 lg:pl-6 space-y-4"
        >
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[11px] text-slate-400">
                {isCs
                  ? `Sektor ${selected.sectorIndex + 1} ze 100`
                  : `Sector ${selected.sectorIndex + 1} of 100`}
              </div>
              <h3 className="font-mono tabular-nums text-lg font-semibold text-slate-100">
                {selected.startPercent}–{selected.endPercent}
                {isCs ? ' % rozsahu' : '% of range'}
              </h3>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                aria-label={isCs ? 'Předchozí sektor' : 'Previous sector'}
                disabled={selected.sectorIndex <= 0}
                onClick={() => {
                  setSelectedSectorIdx((prev) => Math.max(0, prev - 1));
                  setStrategyAppliedFeedback(null);
                }}
                className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-[#252E42] bg-[#141925] text-slate-300 hover:border-[#3A4761] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={isCs ? 'Další sektor' : 'Next sector'}
                disabled={selected.sectorIndex >= sectors.length - 1}
                onClick={() => {
                  setSelectedSectorIdx((prev) => Math.min(sectors.length - 1, prev + 1));
                  setStrategyAppliedFeedback(null);
                }}
                className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-[#252E42] bg-[#141925] text-slate-300 hover:border-[#3A4761] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Explicit status + linear meter */}
          <div className="space-y-2 border-y border-[#1D2432] py-3.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 font-medium">
                {selected.status === 'completed' ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                    <span className="text-emerald-400">
                      {isCs ? 'Kompletně projitý (100 %)' : 'Completed (100%)'}
                    </span>
                  </>
                ) : selected.status === 'partial' ? (
                  <>
                    <Layers className="h-3.5 w-3.5 text-[#F7931A]" aria-hidden="true" />
                    <span className="text-[#F7931A]">
                      {isCs ? 'Částečně projitý' : 'Partially Scanned'}
                    </span>
                  </>
                ) : (
                  <span className="text-slate-400">
                    {isCs ? 'Zatím neprojitý prostor' : 'Not Yet Scanned'}
                  </span>
                )}
              </span>
              <span
                data-testid="selected-sector-coverage"
                className={`font-mono tabular-nums font-semibold ${
                  selected.status === 'completed'
                    ? 'text-emerald-400'
                    : selected.status === 'partial'
                      ? 'text-[#F7931A]'
                      : 'text-slate-400'
                }`}
              >
                {formatSectorCoveragePercent(selected.coveragePercent, locale)}
              </span>
            </div>

            <div className="h-2 w-full rounded-full bg-[#090B10] border border-[#1E2534] overflow-hidden">
              {selected.visualFillPercent > 0 && (
                <div
                  className={`h-full transition-all duration-300 ${
                    selected.status === 'completed' ? 'bg-emerald-400' : 'bg-[#F7931A]'
                  }`}
                  style={{ width: `${selected.visualFillPercent}%` }}
                />
              )}
            </div>
          </div>

          {/* Numeric key & block telemetry */}
          <dl className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-400">
                {isCs ? 'Prohledané klíče' : 'Scanned Keys'}
              </dt>
              <dd
                data-testid="selected-sector-keys"
                className="font-mono tabular-nums text-slate-200 font-medium text-right"
              >
                {formatLocalizedNumber(selected.scannedKeys, locale)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-400">
                {isCs ? 'Dokončené bloky (2²⁹)' : 'Completed Blocks (2²⁹)'}
              </dt>
              <dd className="font-mono tabular-nums text-slate-200 text-right">
                {formatLocalizedNumber(selected.completedBlocksCount, locale)}
                {selected.activeBlocksCount > 0 && (
                  <span className="text-[#F7931A]">
                    {' '}
                    (+{selected.activeBlocksCount} {isCs ? 'aktivní' : 'active'})
                  </span>
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-400">
                {isCs ? 'Velikost sektoru' : 'Sector Capacity'}
              </dt>
              <dd className="font-mono tabular-nums text-slate-400 text-right">
                {formatLocalizedNumber(selected.totalBlocks, locale)}{' '}
                {isCs ? 'bloků' : 'blocks'}
              </dd>
            </div>
            <div className="space-y-1 pt-1">
              <dt className="text-slate-400">
                {isCs ? 'Rozsah klíčů (Hex)' : 'Key Range (Hex)'}
              </dt>
              <dd className="font-mono text-[11px] text-slate-300 break-all">
                {selected.startKeyHex} → {selected.endKeyHex}
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-slate-400">
                {isCs ? 'Indexy bloků v sektoru' : 'Sector Block Range'}
              </dt>
              <dd className="font-mono tabular-nums text-[11px] text-slate-400 break-all">
                #{formatLocalizedNumber(Number(selected.startBlockIndexStr), locale)} – #
                {formatLocalizedNumber(Number(selected.endBlockIndexStr), locale)}
              </dd>
            </div>
          </dl>

          {/* Sequential Start Selector Action */}
          <div className="border-t border-[#1D2432] pt-4 space-y-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
              <Compass className="h-3.5 w-3.5 text-[#F7931A]" aria-hidden="true" />
              <span>
                {isCs ? 'Sekvenční výpočet od tohoto čtverečku' : 'Sequential Start from This Sector'}
              </span>
            </div>

            {sessionData.strategy.blockMode === 'random' && (
              <p className="text-[11px] text-slate-400 leading-relaxed">
                {isCs
                  ? 'Aktuálně máte nastavené Náhodné bloky. Potvrzením přepnete strategii na Sekvenční od začátku vybraného sektoru.'
                  : 'Currently set to Random blocks. Confirming switches strategy to Sequential from this sector’s start.'}
              </p>
            )}

            {isExactSeqStartOnSelected ? (
              <div className="space-y-2">
                <div className="rounded-lg border border-sky-500/40 bg-sky-950/25 px-3 py-2 text-xs text-sky-200">
                  {isCs
                    ? `Aktivní startovní pozice sekvence je na začátku tohoto sektoru (${selected.startPercent} %).`
                    : `Sequential scanning is set to start at this sector (${selected.startPercent}%).`}
                </div>
                {onNavigateToCompute && (
                  <button
                    type="button"
                    onClick={onNavigateToCompute}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-[#2C374F] bg-[#151B28] px-4 py-2 text-xs font-medium text-slate-200 hover:border-[#3D4C6E] cursor-pointer"
                  >
                    <span>{isCs ? 'Přejít na Výpočet' : 'Go to Compute'}</span>
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <button
                  type="button"
                  data-testid="set-sequential-sector-btn"
                  disabled={isRunning || isUpdatingStrategy || !onSelectSequentialSector}
                  onClick={handleApplySectorAsSequentialStart}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-[#F7931A] px-4 py-2.5 text-xs font-semibold text-[#090B10] hover:bg-[#ff9f2e] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span>
                    {isUpdatingStrategy
                      ? isCs
                        ? 'Ukládám pozici...'
                        : 'Saving position...'
                      : isCs
                        ? `Zahájit sekvenci od ${selected.startPercent} %`
                        : `Start Sequential at ${selected.startPercent}%`}
                  </span>
                </button>
                {isRunning && (
                  <p className="text-[11px] text-amber-300/80">
                    {isCs
                      ? 'Pro změnu začátku sekvence nejprve pozastavte výpočet v záložce Výpočet.'
                      : 'Pause scanning in the Compute tab before changing the sequential start sector.'}
                  </p>
                )}
                {strategyAppliedFeedback === selected.sectorIndex && (
                  <p className="text-[11px] text-emerald-400">
                    {isCs
                      ? `Sekvenční start uložen na ${selected.startPercent} %.`
                      : `Sequential start saved at ${selected.startPercent}%.`}
                  </p>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
