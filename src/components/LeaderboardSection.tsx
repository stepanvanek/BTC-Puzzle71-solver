import { RefreshCw, ShieldCheck, Trophy } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '../i18n/LocaleContext.tsx';
import { formatLocalizedNumber } from '../i18n/locale.ts';
import type { PublicLeaderboardResponse } from '../types/api.ts';
import { getPublicLeaderboardFromFirestore } from '../services/firestoreStore.ts';
import {
  formatKeyspaceProgressPercent,
  splitKeyspaceProgressPercent,
} from '../utils/keyspaceStats.ts';

interface LeaderboardSectionProps {
  compact?: boolean;
  currentMaskedAddress?: string | null;
  onOpenFullLeaderboard?: () => void;
}

export function LeaderboardSection({
  compact = false,
  currentMaskedAddress = null,
  onOpenFullLeaderboard,
}: LeaderboardSectionProps) {
  const { locale } = useLocale();
  const isCs = locale === 'cs';

  const [data, setData] = useState<PublicLeaderboardResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLeaderboard = useCallback(
    async (manual = false) => {
      if (manual) {
        setIsRefreshing(true);
      }
      try {
        const limit = compact ? 15 : 50;
        const json = await getPublicLeaderboardFromFirestore(limit);
        setData(json);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : isCs
              ? 'Nepodařilo se načíst veřejný žebříček.'
              : 'Failed to load public leaderboard.',
        );
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [compact, isCs],
  );

  useEffect(() => {
    void loadLeaderboard(false);
    const interval = setInterval(() => {
      void loadLeaderboard(false);
    }, 15_000);
    return () => clearInterval(interval);
  }, [loadLeaderboard]);

  const wrapperClass = compact
    ? 'rounded-xl border border-[#222938] bg-[#11151E] p-6 sm:p-8 space-y-5'
    : 'mx-auto max-w-[1280px] px-6 py-8 space-y-6';

  const entries = data?.entries ?? [];
  const summary = data?.summary ?? {
    participantsCount: 0,
    onlineDevicesCount: 0,
    topKeysChecked: 0,
    topCompletedBlocks: 0,
    topProgressPercent: 0,
  };

  return (
    <section aria-labelledby="public-leaderboard-heading" className={wrapperClass}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium text-[#F7931A]">
            <Trophy className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{isCs ? 'Veřejný přehled bez přihlášení' : 'Public Overview Without Sign-In'}</span>
          </div>
          <h2
            id="public-leaderboard-heading"
            className="font-display text-xl sm:text-2xl font-semibold text-slate-100"
          >
            {isCs
              ? 'Veřejný žebříček řešitelů Puzzle #71'
              : 'Public Puzzle #71 Solver Leaderboard'}
          </h2>
          <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
            {isCs
              ? 'Kvůli bezpečnosti a soukromí se zobrazuje pouze začátek a konec bitcoinové adresy (střed je vždy skrytý). Každá adresa si v sólo režimu prochází své vlastní unikátní bloky samostatně.'
              : 'For privacy and safety, only the prefix and suffix of each Bitcoin address are displayed (middle characters are masked). Every address scans its own independent solo blocks.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => void loadLeaderboard(true)}
            disabled={isRefreshing}
            className="inline-flex items-center gap-2 rounded-lg border border-[#283144] bg-[#141925] px-3.5 py-2 text-xs font-medium text-slate-200 hover:border-[#3A4761] hover:bg-[#1A2130] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>{isCs ? 'Obnovit žebříček' : 'Refresh Leaderboard'}</span>
          </button>

          {compact && onOpenFullLeaderboard && (
            <button
              type="button"
              onClick={onOpenFullLeaderboard}
              className="rounded-lg border border-[#323C52] bg-[#181E2B] px-3.5 py-2 text-xs font-medium text-[#F7931A] hover:border-[#F7931A]/60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isCs ? 'Otevřít celý žebříček' : 'View Full Leaderboard'}
            </button>
          )}
        </div>
      </div>

      {/* Solo-meaningful Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border border-[#1E2534] bg-[#0B0E15] p-4 space-y-1">
          <p className="text-xs text-slate-400">
            {isCs ? 'Aktivní BTC adresy v žebříčku' : 'Ranked BTC Addresses'}
          </p>
          <p className="font-mono text-xl font-semibold tabular-nums text-slate-100">
            {formatLocalizedNumber(summary.participantsCount, locale)}
          </p>
          <p className="text-[11px] text-slate-500">
            {isCs
              ? 'Samostatné sólo relace (každá má vlastní bloky)'
              : 'Independent solo sessions (separate block spaces)'}
          </p>
        </div>
        <div className="rounded-xl border border-[#1E2534] bg-[#0B0E15] p-4 space-y-1">
          <p className="text-xs text-slate-400">
            {isCs ? 'Právě počítající zařízení' : 'Currently Active Devices'}
          </p>
          <p className="font-mono text-xl font-semibold tabular-nums text-slate-100">
            {formatLocalizedNumber(summary.onlineDevicesCount, locale)}
          </p>
          <p className="text-[11px] text-slate-500">
            {isCs ? 'Uzly aktivní v posledních 45 sekundách' : 'Nodes active within the last 45s'}
          </p>
        </div>
        <div className="rounded-xl border border-[#1E2534] bg-[#0B0E15] p-4 space-y-1">
          <p className="text-xs text-slate-400">
            {isCs ? 'Nejvyšší sólo postup (TOP 1)' : 'Top Solo Progress (#1)'}
          </p>
          <p className="font-mono text-xl font-semibold tabular-nums text-emerald-400">
            {formatKeyspaceProgressPercent(summary.topKeysChecked, locale)}
          </p>
          <p className="font-mono text-[11px] text-slate-500 tabular-nums">
            {formatLocalizedNumber(summary.topKeysChecked, locale)} {isCs ? 'klíčů' : 'keys'} ·{' '}
            {formatLocalizedNumber(summary.topCompletedBlocks, locale)}{' '}
            {isCs ? 'dokončených bloků' : 'completed blocks'}
          </p>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-xs text-red-300"
        >
          {error}
        </div>
      )}

      {/* Leaderboard Table */}
      <div className="rounded-xl border border-[#1E2534] bg-[#0B0E15] overflow-hidden">
        {isLoading && !data ? (
          <div className="px-6 py-10 text-center text-xs text-slate-400">
            {isCs ? 'Načítám veřejný žebříček řešitelů…' : 'Loading public solver leaderboard…'}
          </div>
        ) : entries.length === 0 ? (
          <div className="px-6 py-10 text-center space-y-1.5">
            <p className="text-sm font-medium text-slate-200">
              {isCs
                ? 'Zatím nebyly zaznamenány žádné prohledané klíče'
                : 'No scanned keys recorded yet'}
            </p>
            <p className="text-xs text-slate-500">
              {isCs
                ? 'Zadejte svou bitcoinovou adresu a spusťte výpočet — po prvním uloženém průběhu se vaše maskovaná adresa objeví zde.'
                : 'Enter your Bitcoin address and start scanning — your masked address will appear here after your first checkpoint.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#1D2432] text-slate-400 font-medium">
                  <th className="py-3 px-4 sm:px-6">#</th>
                  <th className="py-3 px-4">
                    {isCs ? 'BTC adresa (maskovaná)' : 'BTC Address (Masked)'}
                  </th>
                  <th className="py-3 px-4 text-right">
                    {isCs ? 'Projeté klíče' : 'Scanned Keys'}
                  </th>
                  <th className="py-3 px-4 text-right">
                    {isCs ? 'Dokončené bloky' : 'Completed Blocks'}
                  </th>
                  <th colSpan={2} scope="colgroup" className="py-3 px-4 sm:px-6 text-right">
                    {isCs ? 'Sólo progres (2⁷⁰)' : 'Solo Progress (2⁷⁰)'}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#161C28]">
                {entries.map((entry) => {
                  const isCurrentUser =
                    Boolean(currentMaskedAddress) && entry.maskedAddress === currentMaskedAddress;
                  const progressParts = splitKeyspaceProgressPercent(entry.totalKeysChecked, locale);
                  return (
                    <tr
                      key={`${entry.rank}-${entry.maskedAddress}`}
                      className={`transition-colors ${
                        isCurrentUser ? 'bg-[#1D1810]' : 'hover:bg-[#131823]'
                      }`}
                    >
                      <td className="py-3 px-4 sm:px-6 font-mono tabular-nums font-semibold">
                        <span className={entry.rank === 1 ? 'text-[#F7931A]' : 'text-slate-300'}>
                          {isCs ? `${entry.rank}.` : `#${entry.rank}`}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-slate-100">{entry.maskedAddress}</span>
                          {isCurrentUser && (
                            <span className="text-[11px] font-medium text-[#F7931A]">
                              {isCs ? '(vaše adresa)' : '(your address)'}
                            </span>
                          )}
                          <span className="text-[11px] text-slate-500">{entry.addressType}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-100">
                        {formatLocalizedNumber(entry.totalKeysChecked, locale)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-200">
                        <span>{formatLocalizedNumber(entry.completedBlocksCount, locale)}</span>
                        {entry.activeBlocksCount > 0 && (
                          <span className="ml-1.5 text-[11px] text-slate-500">
                            (+{entry.activeBlocksCount} {isCs ? 'aktiv.' : 'active'})
                          </span>
                        )}
                      </td>
                      <td
                        aria-label={progressParts.fullText}
                        data-progress-int
                        className="py-3 pl-4 pr-0 text-right font-mono tabular-nums text-emerald-400 whitespace-nowrap"
                      >
                        {progressParts.integerPart}
                      </td>
                      <td
                        aria-hidden="true"
                        data-progress-frac
                        className="py-3 pl-0 pr-4 sm:pr-6 text-left font-mono tabular-nums text-emerald-400 whitespace-nowrap w-px"
                      >
                        {progressParts.fractionAndSuffix}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex items-start gap-2 text-[11px] text-slate-500">
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          {isCs
            ? 'Ochrana soukromí i férovost: API vrací pouze maskovaný začátek a konec adresy a započítává pouze skutečně ověřený průběh ze serverové databáze (dokončené bloky vyžadují kryptografický PoW důkaz).'
            : 'Privacy & fairness: The API exposes only masked address prefixes/suffixes and counts strictly server-verified progress (completed blocks require cryptographic PoW shares).'}
        </span>
      </div>
    </section>
  );
}
