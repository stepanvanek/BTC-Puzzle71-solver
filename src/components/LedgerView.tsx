import { RefreshCw } from 'lucide-react';
import { useLocale } from '../i18n/LocaleContext.tsx';
import { formatLocalizedDecimal, formatLocalizedNumber } from '../i18n/locale.ts';
import type { SessionData } from '../types/api.ts';
import { formatKeyspaceProgressPercent } from '../utils/keyspaceStats.ts';

interface LedgerViewProps {
  sessionData: SessionData;
  currentDeviceId: string;
  onRefresh: () => Promise<void>;
  isRefreshing: boolean;
}

function formatTime(ts: number, isCs: boolean): string {
  return new Date(ts).toLocaleTimeString(isCs ? 'cs-CZ' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function LedgerView({
  sessionData,
  currentDeviceId,
  onRefresh,
  isRefreshing,
}: LedgerViewProps) {
  const { locale } = useLocale();
  const isCs = locale === 'cs';

  return (
    <div className="mx-auto max-w-[1280px] px-6 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-100">
            {isCs
              ? 'Zařízení a historie prohledaných bloků'
              : 'Connected Devices & Scanned Block Ledger'}
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            {isCs
              ? 'Každý přidělený blok je v databázi unikátní pouze pro vaši adresu (sólo režim) · Celkový progres:'
              : 'Every leased block is unique to your session address (solo mode) · Total progress:'}{' '}
            <span className="font-mono text-emerald-400">
              {formatKeyspaceProgressPercent(sessionData.stats.totalKeysChecked, locale)}
            </span>{' '}
            {isCs ? 'z rozsahu 2⁷⁰' : 'of 2⁷⁰ range'}
          </p>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          className="inline-flex items-center gap-2 rounded-lg border border-[#283144] bg-[#141925] px-4 py-2 text-xs font-medium text-slate-200 hover:border-[#3A4761] hover:bg-[#1A2130] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          <span>{isCs ? 'Obnovit přehled' : 'Refresh Ledger'}</span>
        </button>
      </div>

      {/* Connected Devices Table */}
      <section className="rounded-xl border border-[#222938] bg-[#11151E] overflow-hidden">
        <div className="border-b border-[#1D2432] px-6 py-4">
          <h2 className="text-sm font-semibold text-slate-100">
            {isCs
              ? `Zařízení připojená k této URL (${sessionData.devices.length})`
              : `Devices Connected to This URL (${sessionData.devices.length})`}
          </h2>
        </div>

        {sessionData.devices.length === 0 ? (
          <div className="px-6 py-10 text-center text-xs text-slate-500">
            {isCs
              ? 'Zatím nebylo spuštěno žádné zařízení. Spusťte výpočet v záložce Výpočet.'
              : 'No device has started scanning yet. Start scanning from the Compute tab.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#1D2432] text-slate-400 font-medium">
                  <th className="py-3 px-6">{isCs ? 'Zařízení' : 'Device'}</th>
                  <th className="py-3 px-4">{isCs ? 'Hardware / Režim' : 'Hardware / Mode'}</th>
                  <th className="py-3 px-4 text-right">
                    {isCs ? 'Poslední rychlost' : 'Last Hashrate'}
                  </th>
                  <th className="py-3 px-4 text-right">
                    {isCs ? 'Prohledané klíče' : 'Scanned Keys'}
                  </th>
                  <th className="py-3 px-4 text-right">
                    {isCs ? 'Dokončené bloky' : 'Completed Blocks'}
                  </th>
                  <th className="py-3 px-6 text-right">{isCs ? 'Stav' : 'Status'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#181E2B]">
                {sessionData.devices.map((dev) => {
                  const isThisDevice = dev.id === currentDeviceId;
                  return (
                    <tr key={dev.id} className="hover:bg-[#151A25] transition-colors">
                      <td className="py-3 px-6 text-slate-200 font-medium">
                        {dev.label}
                        {isThisDevice && (
                          <span className="ml-2 text-[#F7931A] font-normal">
                            {isCs ? '(toto zařízení)' : '(this device)'}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-slate-400">
                        {dev.computeMode === 'webgpu' ? 'WebGPU' : 'CPU Fallback'} · {dev.gpuName}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-200">
                        {formatLocalizedNumber(Math.round(dev.lastRateKps), locale)} Keys/s
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-200">
                        {formatLocalizedNumber(dev.keysChecked, locale)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-200">
                        {formatLocalizedNumber(dev.blocksCompleted, locale)}
                      </td>
                      <td className="py-3 px-6 text-right">
                        <span className={dev.isOnline ? 'text-emerald-400' : 'text-slate-500'}>
                          {dev.isOnline
                            ? isCs
                              ? 'Aktivní'
                              : 'Online'
                            : isCs
                              ? `Naposledy ${formatTime(dev.lastSeenAt, true)}`
                              : `Last seen ${formatTime(dev.lastSeenAt, false)}`}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Non-overlapping Blocks Ledger */}
      <section className="rounded-xl border border-[#222938] bg-[#11151E] overflow-hidden">
        <div className="border-b border-[#1D2432] px-6 py-4">
          <h2 className="text-sm font-semibold text-slate-100">
            {isCs
              ? 'Poslední přidělené bloky (bez překryvu)'
              : 'Recent Leased Keyspace Blocks (Non-Overlapping)'}
          </h2>
        </div>

        {sessionData.recentBlocks.length === 0 ? (
          <div className="px-6 py-10 text-center text-xs text-slate-500">
            {isCs
              ? 'Zatím nebyly přiděleny žádné bloky prostoru klíčů.'
              : 'No keyspace blocks have been leased yet.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#1D2432] text-slate-400 font-medium">
                  <th className="py-3 px-6">{isCs ? 'Blok #' : 'Block #'}</th>
                  <th className="py-3 px-4">{isCs ? 'Rozsah klíčů (Hex)' : 'Key Range (Hex)'}</th>
                  <th className="py-3 px-4 text-right">{isCs ? 'Průběh' : 'Progress'}</th>
                  <th className="py-3 px-4 text-right">{isCs ? 'Přiděleno' : 'Leased'}</th>
                  <th className="py-3 px-6 text-right">{isCs ? 'Stav' : 'Status'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#181E2B]">
                {sessionData.recentBlocks.map((b) => {
                  const pct = b.totalKeys > 0 ? (b.progressOffset / b.totalKeys) * 100 : 0;
                  return (
                    <tr key={b.id} className="hover:bg-[#151A25] transition-colors">
                      <td className="py-3 px-6 font-mono tabular-nums text-slate-200">
                        #{b.blockIndex}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-400">
                        {b.startKeyHex} → {b.endKeyHex}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-300">
                        {formatLocalizedDecimal(pct, 1, locale)}
                        {isCs ? ' %' : '%'} ({formatLocalizedNumber(b.progressOffset, locale)})
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-400">
                        {formatTime(b.leasedAt, isCs)}
                      </td>
                      <td className="py-3 px-6 text-right font-medium">
                        {b.status === 'completed' ? (
                          <span className="text-emerald-400">
                            {isCs ? 'Dokončeno' : 'Completed'}
                          </span>
                        ) : (
                          <span className="text-[#F7931A]">
                            {isCs ? 'Probíhá' : 'In Progress'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
