import { Calculator, CheckCircle2, ExternalLink, Lock, Search, Sparkles, Unlock } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  BITCOIN_PUZZLE_CHALLENGE_SUMMARY,
  BITCOIN_PUZZLE_LIST,
  calculatePuzzleOddsAndEta,
  formatBitRangeLabel,
  getBitcoinPuzzleTimeline,
  getPuzzleNote,
} from '../data/bitcoinPuzzles.ts';
import { useLocale } from '../i18n/LocaleContext.tsx';
import {
  formatLocalizedDecimal,
  formatLocalizedFloatString,
  formatLocalizedNumber,
} from '../i18n/locale.ts';
import { formatCalculatorDuration } from '../utils/keyspaceStats.ts';

interface PuzzleDirectorySectionProps {
  compact?: boolean;
  detectedKeysPerSec?: number;
  onOpenFullDirectory?: () => void;
  onOpenDocs?: () => void;
}

type DirectoryFilter =
  | 'highlights'
  | 'all'
  | 'range1_65'
  | 'range66_80'
  | 'unsolved'
  | 'solved'
  | 'exposed_unsolved';

export function PuzzleDirectorySection({
  compact = false,
  detectedKeysPerSec = 0,
  onOpenFullDirectory,
  onOpenDocs,
}: PuzzleDirectorySectionProps) {
  const { locale } = useLocale();
  const isCs = locale === 'cs';

  const [filter, setFilter] = useState<DirectoryFilter>(compact ? 'highlights' : 'all');
  const [query, setQuery] = useState('');
  const [selectedBits, setSelectedBits] = useState<number>(71);
  const [speedMKeys, setSpeedMKeys] = useState<string>('120');

  const speedPresets = [
    { label: 'CPU (250 kKeys/s)', mkeys: 0.25 },
    { label: isCs ? 'GPU notebook (3 MKeys/s)' : 'Laptop GPU (3 MKeys/s)', mkeys: 3 },
    { label: 'RTX 4090 (120 MKeys/s)', mkeys: 120 },
    { label: 'Cluster (10 GKeys/s)', mkeys: 10_000 },
  ];

  const timelineEvents = useMemo(() => getBitcoinPuzzleTimeline(locale), [locale]);

  const selectedPuzzleRecord = useMemo(
    () => BITCOIN_PUZZLE_LIST.find((p) => p.bits === selectedBits),
    [selectedBits],
  );

  const parsedSpeedKeysPerSec = useMemo(() => {
    const num = Number(speedMKeys.replace(',', '.'));
    return Number.isFinite(num) && num > 0 ? num * 1_000_000 : 0;
  }, [speedMKeys]);

  const etaResult = useMemo(
    () =>
      calculatePuzzleOddsAndEta({
        bitWidth: selectedBits,
        keysPerSec: parsedSpeedKeysPerSec,
      }),
    [selectedBits, parsedSpeedKeysPerSec],
  );

  const filteredPuzzles = useMemo(() => {
    const q = query.trim().toLowerCase();
    return BITCOIN_PUZZLE_LIST.filter((item) => {
      if (q) {
        const localizedNote = getPuzzleNote(item, locale);
        const hay =
          `#${item.bits} ${item.bits} ${item.address} ${item.hexStart} ${item.hexEnd} ${item.solvedKeyHex ?? ''} ${localizedNote} ${item.note}`.toLowerCase();
        return hay.includes(q);
      }

      switch (filter) {
        case 'highlights':
          return (
            (item.bits >= 1 && item.bits <= 5) ||
            (item.bits >= 64 && item.bits <= 75) ||
            item.bits === 125 ||
            item.bits === 130 ||
            item.bits === 135 ||
            item.bits === 140 ||
            item.bits === 160
          );
        case 'range1_65':
          return item.bits >= 1 && item.bits <= 65;
        case 'range66_80':
          return item.bits >= 66 && item.bits <= 80;
        case 'unsolved':
          return item.status !== 'solved';
        case 'solved':
          return item.status === 'solved';
        case 'exposed_unsolved':
          return item.status !== 'solved' && item.pubkeyExposed;
        default:
          return true;
      }
    });
  }, [filter, query, locale]);

  const wrapperClass = compact
    ? 'rounded-xl border border-[#222938] bg-[#11151E] p-6 sm:p-8 space-y-6'
    : 'mx-auto max-w-[1040px] px-6 py-8 space-y-8';

  return (
    <section aria-labelledby="puzzle-directory-heading" className={wrapperClass}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-[#F7931A]">
            {isCs
              ? `Ověřená databáze Bitcoin Puzzle Transaction (#1–#160 · ${formatLocalizedFloatString(BITCOIN_PUZZLE_CHALLENGE_SUMMARY.totalSeriesBtc, locale)} BTC v sérii)`
              : `Verified Bitcoin Puzzle Transaction Dataset (#1–#160 · ${formatLocalizedFloatString(BITCOIN_PUZZLE_CHALLENGE_SUMMARY.totalSeriesBtc, locale)} BTC Total)`}
          </p>
          {compact ? (
            <h2
              id="puzzle-directory-heading"
              className="mt-1 font-display text-2xl font-semibold text-slate-100"
            >
              {isCs
                ? 'Přehled všech 160 Bitcoin Puzzle a kalkulačka pravděpodobnosti'
                : 'Bitcoin Puzzle #1–#160 Directory & Odds Calculator'}
            </h2>
          ) : (
            <h1
              id="puzzle-directory-heading"
              className="mt-1 font-display text-2xl sm:text-3xl font-semibold text-slate-100"
            >
              {isCs
                ? 'Bitcoin Puzzle #1–#160: Kompletní seznam adres, klíčů a kalkulačka'
                : 'Bitcoin Puzzle #1–#160: Full Address List, Hex Keys & Calculator'}
            </h1>
          )}
          <p className="mt-1.5 text-sm text-slate-400 max-w-2xl leading-relaxed">
            {isCs ? (
              <>
                Kompletní seznam všech 160 adres legendární výzvy od{' '}
                <span className="font-mono text-slate-300">
                  {BITCOIN_PUZZLE_CHALLENGE_SUMMARY.creatorAlias}
                </span>{' '}
                (15. 1. 2015) s kryptograficky ověřenými klíči vyřešených úrovní, přesnými HEX
                rozsahy a výpočtem časové náročnosti.
              </>
            ) : (
              <>
                Complete list of all 160 addresses from the historic{' '}
                <span className="font-mono text-slate-300">
                  {BITCOIN_PUZZLE_CHALLENGE_SUMMARY.creatorAlias}
                </span>{' '}
                challenge (Jan 15, 2015) with cryptographically verified solved keys, exact HEX
                ranges, and keyspace ETA estimates.
              </>
            )}
          </p>
        </div>

        {compact && onOpenFullDirectory && (
          <button
            type="button"
            onClick={onOpenFullDirectory}
            className="rounded-lg bg-[#F7931A] px-4 py-2 text-xs font-semibold text-[#090B10] hover:bg-[#ff9f2e] transition-colors whitespace-nowrap shrink-0 self-start sm:self-auto cursor-pointer"
          >
            {isCs ? 'Otevřít všech 160 puzzle →' : 'View All 160 Puzzles →'}
          </button>
        )}
      </div>

      {/* Verified Summary KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-[#1E2534] bg-[#0B0E15] p-4">
          <p className="text-xs text-slate-500">
            {isCs ? 'Celkem adres v sérii' : 'Total Series Addresses'}
          </p>
          <p className="mt-1 font-mono text-xl font-semibold text-slate-100">
            {BITCOIN_PUZZLE_CHALLENGE_SUMMARY.totalPuzzles}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            {isCs
              ? `Rozsah #1–#160 (vznik ${BITCOIN_PUZZLE_CHALLENGE_SUMMARY.createdDate})`
              : `Range #1–#160 (created ${BITCOIN_PUZZLE_CHALLENGE_SUMMARY.createdDate})`}
          </p>
        </div>
        <div className="rounded-xl border border-[#1E2534] bg-[#0B0E15] p-4">
          <p className="text-xs text-slate-500">
            {isCs ? 'Vyřešeno / Nevyřešeno' : 'Solved / Unsolved'}
          </p>
          <p className="mt-1 font-mono text-xl font-semibold text-emerald-400">
            {BITCOIN_PUZZLE_CHALLENGE_SUMMARY.solvedCount} /{' '}
            {BITCOIN_PUZZLE_CHALLENGE_SUMMARY.unsolvedCount}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            {isCs
              ? `Průměrná pozice nálezu: ${formatLocalizedDecimal(BITCOIN_PUZZLE_CHALLENGE_SUMMARY.averageFoundPercent, 2, locale)} %`
              : `Mean key position: ${formatLocalizedDecimal(BITCOIN_PUZZLE_CHALLENGE_SUMMARY.averageFoundPercent, 2, locale)}%`}
          </p>
        </div>
        <div className="rounded-xl border border-[#1E2534] bg-[#0B0E15] p-4">
          <p className="text-xs text-slate-500">
            {isCs ? 'Zbývající odměny' : 'Remaining Bounties'}
          </p>
          <p className="mt-1 font-mono text-xl font-semibold text-slate-100">
            {BITCOIN_PUZZLE_CHALLENGE_SUMMARY.remainingBtc} BTC
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            {isCs
              ? `Vyplaceno v #1–#135: ${formatLocalizedFloatString(BITCOIN_PUZZLE_CHALLENGE_SUMMARY.solvedBtc, locale)} BTC`
              : `Claimed in #1–#135: ${formatLocalizedFloatString(BITCOIN_PUZZLE_CHALLENGE_SUMMARY.solvedBtc, locale)} BTC`}
          </p>
        </div>
        <div className="rounded-xl border border-[#F7931A]/35 bg-[#16130E] p-4">
          <p className="text-xs text-[#F7931A]">{isCs ? 'Hlavní aktivní cíl' : 'Primary Active Target'}</p>
          <p className="mt-1 font-mono text-xl font-semibold text-slate-100">
            {isCs ? '#71 · 7,10 BTC' : '#71 · 7.10 BTC'}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">
            {isCs ? 'Nejnižší nevyřešená Hash160 adresa' : 'Lowest unsolved Hash160 address'}
          </p>
        </div>
      </div>

      {/* Interactive Probability & Time Calculator covering ANY puzzle #1-#160 */}
      <div className="rounded-xl border border-[#1E2534] bg-[#0B0E15] p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Calculator className="h-4 w-4 text-[#F7931A]" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-slate-100">
              {isCs
                ? `Kalkulačka obtížnosti a času pro Bitcoin Puzzle #${selectedBits}`
                : `Difficulty & ETA Calculator for Bitcoin Puzzle #${selectedBits}`}
            </h3>
          </div>
          {detectedKeysPerSec > 0 && (
            <button
              type="button"
              onClick={() => setSpeedMKeys((detectedKeysPerSec / 1_000_000).toFixed(2))}
              className="text-xs text-[#F7931A] hover:underline text-left cursor-pointer"
            >
              {isCs ? 'Použít zjištěnou rychlost zařízení' : 'Use measured device speed'}
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="puzzle-bits-select" className="block text-xs text-slate-400 mb-1.5">
              {isCs ? 'Vyberte libovolné puzzle (#1–#160)' : 'Select any puzzle (#1–#160)'}
            </label>
            <select
              id="puzzle-bits-select"
              value={selectedBits}
              onChange={(e) => setSelectedBits(Number(e.target.value))}
              className="w-full rounded-lg border border-[#283144] bg-[#11151E] px-3 py-2 text-xs font-mono text-slate-100 focus:border-[#F7931A] focus:outline-none"
            >
              {BITCOIN_PUZZLE_LIST.map((p) => {
                const rewardStr = p.rewardBtc > 0 ? formatLocalizedFloatString(p.rewardBtc, locale) : '';
                const stateTag =
                  p.status === 'active'
                    ? isCs
                      ? 'Aktivní cíl · 7,10 BTC'
                      : 'Active target · 7.10 BTC'
                    : p.status === 'solved'
                      ? isCs
                        ? `Vyřešeno${rewardStr ? ` · ${rewardStr} BTC` : ''}`
                        : `Solved${rewardStr ? ` · ${rewardStr} BTC` : ''}`
                      : `${rewardStr ? `${rewardStr} BTC` : ''}${p.pubkeyExposed ? ' · PubKey' : ''}`;
                return (
                  <option key={p.bits} value={p.bits}>
                    Puzzle #{p.bits} ({formatBitRangeLabel(p.bits)}
                    {stateTag ? ` · ${stateTag}` : ''})
                  </option>
                );
              })}
            </select>
          </div>

          <div>
            <label htmlFor="puzzle-speed-input" className="block text-xs text-slate-400 mb-1.5">
              {isCs
                ? 'Výkon skenování (MKeys/s — milionů klíčů za sekundu)'
                : 'Scan rate (MKeys/s — million keys per second)'}
            </label>
            <input
              id="puzzle-speed-input"
              type="number"
              min="0.001"
              step="any"
              value={speedMKeys}
              onChange={(e) => setSpeedMKeys(e.target.value)}
              className="w-full rounded-lg border border-[#283144] bg-[#11151E] px-3 py-2 text-xs font-mono text-slate-100 focus:border-[#F7931A] focus:outline-none"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-slate-500">{isCs ? 'Rychlé předvolby:' : 'Quick presets:'}</span>
          {speedPresets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => setSpeedMKeys(String(preset.mkeys))}
              className="rounded-md border border-[#283144] bg-[#11151E] px-2.5 py-1 text-slate-300 hover:border-[#F7931A]/50 hover:text-[#F7931A] transition-colors cursor-pointer"
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border-t border-[#1D2432] pt-4 text-xs">
          <div>
            <p className="text-slate-500">
              {etaResult.fitsInsideSingleBlock
                ? isCs
                  ? `Velikost puzzle (${formatLocalizedNumber(etaResult.effectiveBlockKeys, locale)} klíčů)`
                  : `Puzzle size (${formatLocalizedNumber(etaResult.effectiveBlockKeys, locale)} keys)`
                : isCs
                  ? 'Jeden blok (2²⁹ = 536,87 mil. klíčů)'
                  : 'One block (2²⁹ = 536.87M keys)'}
            </p>
            <p className="mt-1 font-mono text-sm font-semibold text-slate-100">
              {formatCalculatorDuration(etaResult.secondsPerBlock, locale)}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {etaResult.fitsInsideSingleBlock
                ? isCs
                  ? 'Menší než 1 standardní blok'
                  : 'Smaller than 1 standard block'
                : isCs
                  ? `Celkem bloků: ${formatLocalizedNumber(etaResult.blockCount, locale)}`
                  : `Total blocks: ${formatLocalizedNumber(etaResult.blockCount, locale)}`}
            </p>
          </div>
          <div>
            <p className="text-slate-500">
              {isCs ? 'Mediánová doba (50 % prostoru)' : 'Median time (50% keyspace)'}
            </p>
            <p className="mt-1 font-mono text-sm font-semibold text-[#F7931A]">
              {formatCalculatorDuration(etaResult.medianSeconds50Pct, locale)}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {isCs ? 'Statistická střední hodnota' : 'Statistical midpoint'}
            </p>
          </div>
          <div>
            <p className="text-slate-500">
              {isCs ? 'Projít celý prostor (100 %)' : 'Full space traversal (100%)'}
            </p>
            <p className="mt-1 font-mono text-sm font-semibold text-slate-100">
              {formatCalculatorDuration(etaResult.fullSeconds100Pct, locale)}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {isCs
                ? `Rozsah ${formatBitRangeLabel(selectedBits)} (Hash160)`
                : `Range ${formatBitRangeLabel(selectedBits)} (Hash160)`}
            </p>
          </div>
        </div>

        {selectedPuzzleRecord?.pubkeyExposed && selectedPuzzleRecord.status !== 'solved' && (
          <div className="rounded-lg border border-amber-500/25 bg-[#15120D] px-3.5 py-2.5 text-[11px] text-amber-200/90">
            {isCs ? (
              <>
                <strong>Poznámka k odhalenému PubKey:</strong> Puzzle #{selectedBits} má od roku 2019
                zveřejněný veřejný klíč. Algoritmy ECDLP (Pollardovo Kangaroo) snižují počet kroků z
                celého rozsahu na zhruba{' '}
                <span className="font-mono">O(√N) ≈ {etaResult.kangarooOpsEstimate.toExponential(2)}</span>{' '}
                operací (u #{selectedBits} tedy řádově{' '}
                <span className="font-mono">
                  {formatCalculatorDuration(etaResult.kangarooSecondsEstimate, locale)}
                </span>{' '}
                při dané rychlosti skoků).
              </>
            ) : (
              <>
                <strong>Exposed PubKey Note:</strong> Puzzle #{selectedBits} has had an exposed public
                key since 2019. ECDLP solvers (Pollard’s Kangaroo) reduce work from brute force to
                roughly <span className="font-mono">O(√N) ≈ {etaResult.kangarooOpsEstimate.toExponential(2)}</span>{' '}
                operations (~<span className="font-mono">{formatCalculatorDuration(etaResult.kangarooSecondsEstimate, locale)}</span>{' '}
                for #{selectedBits} at this step rate).
              </>
            )}
          </div>
        )}
      </div>

      {/* Filters & Search across ALL 160 puzzles */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {(
            [
              ...(compact
                ? [{ id: 'highlights' as const, label: isCs ? 'Klíčové' : 'Highlights' }]
                : []),
              {
                id: 'all' as const,
                label: isCs
                  ? `Všech ${BITCOIN_PUZZLE_CHALLENGE_SUMMARY.totalPuzzles}`
                  : `All ${BITCOIN_PUZZLE_CHALLENGE_SUMMARY.totalPuzzles}`,
              },
              { id: 'range1_65' as const, label: '#1–#65' },
              { id: 'range66_80' as const, label: '#66–#80' },
              {
                id: 'unsolved' as const,
                label: isCs
                  ? `Nevyřešené (${BITCOIN_PUZZLE_CHALLENGE_SUMMARY.unsolvedCount})`
                  : `Unsolved (${BITCOIN_PUZZLE_CHALLENGE_SUMMARY.unsolvedCount})`,
              },
              {
                id: 'solved' as const,
                label: isCs
                  ? `Vyřešené (${BITCOIN_PUZZLE_CHALLENGE_SUMMARY.solvedCount})`
                  : `Solved (${BITCOIN_PUZZLE_CHALLENGE_SUMMARY.solvedCount})`,
              },
              {
                id: 'exposed_unsolved' as const,
                label: `Kangaroo (${BITCOIN_PUZZLE_CHALLENGE_SUMMARY.exposedUnsolvedCount})`,
              },
            ] satisfies Array<{ id: DirectoryFilter; label: string }>
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilter(tab.id)}
              className={`rounded-lg px-2.5 py-1.5 font-medium transition-colors cursor-pointer ${
                filter === tab.id && !query.trim()
                  ? 'bg-[#F7931A] text-[#090B10]'
                  : 'border border-[#283144] bg-[#0B0E15] text-slate-300 hover:border-[#3A4761]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full lg:w-64">
          <Search
            className="h-3.5 w-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              isCs
                ? 'Hledat např. #3, #38, #71, 1PWo...'
                : 'Search e.g. #3, #38, #71, 1PWo...'
            }
            aria-label={
              isCs
                ? 'Hledat v tabulce všech 160 Bitcoin Puzzle'
                : 'Search all 160 Bitcoin Puzzles'
            }
            className="w-full rounded-lg border border-[#283144] bg-[#0B0E15] pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-[#F7931A] focus:outline-none"
          />
        </div>
      </div>

      {/* Responsive Reference Table */}
      <div className="overflow-x-auto rounded-xl border border-[#1E2534] bg-[#0B0E15]">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-[#1E2534] text-[11px] uppercase tracking-wider text-slate-500 bg-[#0E121A]">
              <th className="py-2.5 px-3 font-semibold whitespace-nowrap">Puzzle</th>
              <th className="py-2.5 px-3 font-semibold whitespace-nowrap">
                {isCs ? 'Bitcoin adresa' : 'Bitcoin Address'}
              </th>
              <th className="py-2.5 px-3 font-semibold whitespace-nowrap">
                {isCs ? 'Rozsah (HEX)' : 'Range (HEX)'}
              </th>
              <th className="py-2.5 px-3 font-semibold text-right whitespace-nowrap">
                {isCs ? 'Odměna' : 'Reward'}
              </th>
              <th className="py-2.5 px-3 font-semibold whitespace-nowrap">
                {isCs ? 'Klíč' : 'Key Type'}
              </th>
              <th className="py-2.5 px-3 font-semibold">
                {isCs ? 'Stav a ověřený klíč' : 'Status & Verified Key'}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#171C28]">
            {filteredPuzzles.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-8 px-4 text-center text-slate-500">
                  {isCs
                    ? 'Zadanému filtru neodpovídá žádná položka.'
                    : 'No puzzles match the selected filter or query.'}
                </td>
              </tr>
            ) : (
              filteredPuzzles.map((puzzle) => {
                const isActiveTarget = puzzle.status === 'active';
                return (
                  <tr
                    key={puzzle.bits}
                    className={
                      isActiveTarget
                        ? 'bg-[#19140E] hover:bg-[#201910]'
                        : 'hover:bg-[#111622] transition-colors'
                    }
                  >
                    <td className="py-2.5 px-3 align-top whitespace-nowrap">
                      <div className="flex items-center gap-1.5 font-mono font-semibold text-slate-100">
                        <span>#{puzzle.bits}</span>
                        {isActiveTarget && (
                          <span className="inline-flex items-center gap-1 rounded bg-[#F7931A]/20 px-1.5 py-0.5 text-[10px] font-medium text-[#F7931A]">
                            <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
                            {isCs ? 'Cíl' : 'Target'}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                        {formatBitRangeLabel(puzzle.bits)}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 align-top font-mono text-[11px] text-slate-200 whitespace-nowrap">
                      <a
                        href={`https://mempool.space/address/${puzzle.address}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 hover:text-[#F7931A] transition-colors"
                        title={
                          isCs
                            ? `Zobrazit adresu ${puzzle.address} na mempool.space`
                            : `View address ${puzzle.address} on mempool.space`
                        }
                      >
                        <span>{puzzle.address}</span>
                        <ExternalLink className="h-3 w-3 opacity-60 shrink-0" aria-hidden="true" />
                      </a>
                    </td>
                    <td className="py-2.5 px-3 align-top font-mono text-[11px] text-slate-400">
                      <div
                        className="truncate max-w-[140px]"
                        title={`${puzzle.hexStart} → ${puzzle.hexEnd}`}
                      >
                        {puzzle.hexStart}
                      </div>
                      <div className="truncate max-w-[140px] text-slate-500" title={puzzle.hexEnd}>
                        → {puzzle.hexEnd}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 align-top font-mono text-right whitespace-nowrap text-slate-100 font-semibold">
                      {formatLocalizedDecimal(puzzle.rewardBtc, puzzle.rewardBtc < 1 ? 3 : 2, locale)}{' '}
                      BTC
                    </td>
                    <td className="py-2.5 px-3 align-top whitespace-nowrap text-[11px]">
                      {puzzle.pubkeyExposed ? (
                        <span
                          className="inline-flex items-center gap-1 text-amber-300"
                          title={isCs ? 'Odhalený veřejný klíč' : 'Exposed Public Key'}
                        >
                          <Unlock className="h-3 w-3 shrink-0" aria-hidden="true" />
                          <span>PubKey</span>
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 text-emerald-400"
                          title={isCs ? 'Skrytý pod Hash160' : 'Hidden behind Hash160'}
                        >
                          <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
                          <span>Hash160</span>
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 align-top">
                      <div className="flex flex-wrap items-center gap-1.5 font-medium">
                        {puzzle.status === 'solved' ? (
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span>
                              {isCs ? 'Vyřešeno' : 'Solved'}
                              {puzzle.solvedPercent !== undefined
                                ? ` (${formatLocalizedFloatString(puzzle.solvedPercent, locale)}${isCs ? ' %' : '%'})`
                                : ''}
                            </span>
                          </span>
                        ) : puzzle.status === 'active' ? (
                          <span className="text-[#F7931A] font-semibold">
                            {isCs ? 'Aktivní sólo cíl' : 'Active Solo Target'}
                          </span>
                        ) : (
                          <span className="text-slate-300">
                            {isCs ? 'Nevyřešeno' : 'Unsolved'}
                          </span>
                        )}
                        {puzzle.solvedDate && (
                          <span className="text-[11px] text-slate-500 font-mono">
                            · {puzzle.solvedDate}
                          </span>
                        )}
                      </div>
                      {puzzle.solvedKeyHex && (
                        <p className="mt-1 font-mono text-[11px] text-slate-300 break-all">
                          k = {puzzle.solvedKeyHex}
                        </p>
                      )}
                      <p className="mt-0.5 text-[11px] text-slate-400 leading-relaxed">
                        {getPuzzleNote(puzzle, locale)}
                      </p>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Historical Timeline & Tooling Comparison */}
      {!compact && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-xl border border-[#222938] bg-[#11151E] p-6 space-y-4">
            <h2 className="font-display text-lg font-semibold text-slate-100">
              {isCs
                ? 'Historická časová osa Bitcoin Puzzle (2015–2026)'
                : 'Bitcoin Puzzle Historical Timeline (2015–2026)'}
            </h2>
            <ol className="space-y-4 text-xs border-l border-[#283144] pl-4">
              {timelineEvents.map((event) => (
                <li key={event.date} className="space-y-1">
                  <div className="font-mono text-[11px] text-[#F7931A]">{event.date}</div>
                  <div className="font-semibold text-slate-200">{event.title}</div>
                  <p className="text-slate-400 leading-relaxed">{event.description}</p>
                </li>
              ))}
            </ol>
          </div>

          <div className="rounded-xl border border-[#222938] bg-[#11151E] p-6 space-y-4">
            <h2 className="font-display text-lg font-semibold text-slate-100">
              {isCs
                ? 'WebGPU v prohlížeči vs. BitCrack, KeyHunt a RCKangaroo'
                : 'Browser WebGPU vs. BitCrack, KeyHunt & RCKangaroo'}
            </h2>
            <p className="text-xs text-slate-400 leading-relaxed">
              {isCs
                ? 'V komunitě existuje několik specializovaných nástrojů podle toho, zda má daná puzzle adresa odhalený veřejný klíč nebo je chráněná pod Hash160:'
                : 'The community uses distinct solvers depending on whether a puzzle exposes its public key on-chain or remains shielded by Hash160:'}
            </p>
            <dl className="space-y-3 text-xs">
              <div className="rounded-lg border border-[#1E2534] bg-[#0B0E15] p-3">
                <dt className="font-semibold text-[#F7931A]">
                  {isCs
                    ? 'Puzzle71 WebGPU (tento web) — nulová instalace, sólo izolace bloků'
                    : 'Puzzle71 WebGPU (This App) — Zero Install, Solo Block Isolation'}
                </dt>
                <dd className="mt-1 text-slate-400 leading-relaxed">
                  {isCs ? (
                    <>
                      Běží přímo v prohlížeči přes WebGPU WGSL shadery (secp256k1 + SHA-256 +
                      RIPEMD-160), synchronizuje vlastní unikátní bloky{' '}
                      <span className="font-mono">2²⁹</span> mezi více zařízeními a chrání nález
                      privátním odesláním mimo mempool.
                    </>
                  ) : (
                    <>
                      Runs directly in the browser via WebGPU WGSL shaders (secp256k1 + SHA-256 +
                      RIPEMD-160), syncs non-overlapping <span className="font-mono">2²⁹</span>{' '}
                      blocks across your devices, and protects claims via private pool relay.
                    </>
                  )}
                </dd>
              </div>
              <div className="rounded-lg border border-[#1E2534] bg-[#0B0E15] p-3">
                <dt className="font-semibold text-slate-200">
                  {isCs
                    ? 'BitCrack / VanitySearch / KeyHunt — nativní CUDA & CPU pro #71'
                    : 'BitCrack / VanitySearch / KeyHunt — Native CUDA & CPU for #71'}
                </dt>
                <dd className="mt-1 text-slate-400 leading-relaxed">
                  {isCs
                    ? 'Nativní C++/CUDA programy pro vyhrazené GPU rigy zaměřené na Hash160 adresy (#71–#74) bez odhaleného veřejného klíče. Vyžadují instalaci, ovladače a vlastní správu rozsahů i transakcí.'
                    : 'Native C++/CUDA tools for dedicated GPU rigs targeting unexposed Hash160 addresses (#71–#74). Require local setup, GPU drivers, and manual range & claim-tx management.'}
                </dd>
              </div>
              <div className="rounded-lg border border-[#1E2534] bg-[#0B0E15] p-3">
                <dt className="font-semibold text-slate-200">
                  {isCs
                    ? 'RCKangaroo / Pollard’s Kangaroo — pro #140 a vyšší s veřejným klíčem'
                    : 'RCKangaroo / Pollard’s Kangaroo — For #140+ With Exposed PubKey'}
                </dt>
                <dd className="mt-1 text-slate-400 leading-relaxed">
                  {isCs ? (
                    <>
                      U adres s veřejným klíčem odhaleným v odchozí transakci (#140, #145, #150,
                      #155, #160) snižuje složitost na druhou odmocninu (
                      <span className="font-mono">O(√N)</span>), u #71 však algoritmus nelze použít.
                    </>
                  ) : (
                    <>
                      When an address has spent an output and revealed its public key (#140, #145,
                      #150, #155, #160), complexity drops to square-root (
                      <span className="font-mono">O(√N)</span>) — impossible for #71.
                    </>
                  )}
                </dd>
              </div>
            </dl>
            {onOpenDocs && (
              <button
                type="button"
                onClick={onOpenDocs}
                className="text-xs font-medium text-[#F7931A] hover:underline cursor-pointer"
              >
                {isCs
                  ? 'Zobrazit podrobnou dokumentaci WebGPU a PoW →'
                  : 'Read full WebGPU & PoW documentation →'}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
