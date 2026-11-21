import { Activity } from 'lucide-react';
import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useLocale } from '../i18n/LocaleContext.tsx';
import {
  type SpeedSample,
  computeSpeedStats,
  formatKeysRate,
  selectRateScale,
} from '../utils/speedHistory.ts';

interface SpeedHistoryChartProps {
  history: SpeedSample[];
  isRunning: boolean;
  onlineDevicesCount?: number;
  fleetRateKps?: number;
}

interface ChartPoint extends SpeedSample {
  scaledRate: number;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: ChartPoint }>;
}

function SpeedTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0 || !payload[0]?.payload) {
    return null;
  }
  const point = payload[0].payload;
  return (
    <div className="rounded-lg border border-[#2B354B] bg-[#0B0E15] px-3 py-2 text-xs shadow-lg">
      <p className="font-mono text-[11px] text-slate-400">{point.timeLabel}</p>
      <p className="mt-0.5 font-mono text-sm font-semibold text-[#F7931A] tabular-nums">
        {formatKeysRate(point.rateKps)}
      </p>
    </div>
  );
}

export function SpeedHistoryChart({
  history,
  isRunning,
  onlineDevicesCount = 0,
  fleetRateKps = 0,
}: SpeedHistoryChartProps) {
  const { locale } = useLocale();
  const isCs = locale === 'cs';

  const stats = useMemo(() => computeSpeedStats(history), [history]);
  const scale = useMemo(
    () => selectRateScale(Math.max(stats.maxKps, stats.currentKps)),
    [stats.maxKps, stats.currentKps],
  );

  const chartData = useMemo<ChartPoint[]>(
    () =>
      history.map((s) => ({
        ...s,
        scaledRate: Number((s.rateKps / scale.divisor).toFixed(scale.decimals)),
      })),
    [history, scale.divisor, scale.decimals],
  );

  const scaledAvg = useMemo(
    () => Number((stats.avgKps / scale.divisor).toFixed(scale.decimals)),
    [stats.avgKps, scale.divisor, scale.decimals],
  );

  const stabilityTone =
    stats.stabilityPct === null
      ? 'text-slate-400'
      : stats.stabilityPct >= 85
        ? 'text-emerald-400'
        : stats.stabilityPct >= 65
          ? 'text-amber-300'
          : 'text-red-400';

  return (
    <section
      aria-label={
        isCs ? 'Historie výpočetní rychlosti v čase' : 'Compute speed history over time'
      }
      className="rounded-xl border border-[#222938] bg-[#11151E] p-6"
    >
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Activity className="h-4 w-4 text-[#F7931A]" aria-hidden="true" />
            <h2 className="text-base font-semibold text-slate-100">
              {isCs
                ? `Historie rychlosti tohoto zařízení (${scale.unitLabel})`
                : `Device Hashrate History (${scale.unitLabel})`}
            </h2>
          </div>
          <p className="text-xs text-slate-400">
            {isCs
              ? `Živý průběh výkonu tohoto prohlížeče (${scale.unitLabel}) pro přesnou kontrolu stability GPU/CPU bez síťových prodlev ostatních zařízení.`
              : `Live throughput of this browser (${scale.unitLabel}) for accurate GPU/CPU stability monitoring without network jitter from other nodes.`}
            {onlineDevicesCount > 1 && fleetRateKps > 0 && (
              <span className="ml-1.5 text-slate-300 font-mono">
                ·{' '}
                {isCs
                  ? `Celkem ze ${onlineDevicesCount} aktivních zařízení:`
                  : `Total across ${onlineDevicesCount} active devices:`}{' '}
                {formatKeysRate(fleetRateKps)}
              </span>
            )}
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-5 text-xs border-t lg:border-t-0 border-[#1D2432] pt-3 lg:pt-0">
          <div>
            <p className="text-slate-500">{isCs ? 'Průměr' : 'Average'}</p>
            <p className="mt-0.5 font-mono font-semibold tabular-nums text-slate-200">
              {stats.avgKps > 0 ? formatKeysRate(stats.avgKps) : '—'}
            </p>
          </div>
          <div>
            <p className="text-slate-500">{isCs ? 'Minimum' : 'Min'}</p>
            <p className="mt-0.5 font-mono font-semibold tabular-nums text-slate-300">
              {stats.minKps > 0 ? formatKeysRate(stats.minKps) : '—'}
            </p>
          </div>
          <div>
            <p className="text-slate-500">{isCs ? 'Maximum' : 'Max'}</p>
            <p className="mt-0.5 font-mono font-semibold tabular-nums text-slate-200">
              {stats.maxKps > 0 ? formatKeysRate(stats.maxKps) : '—'}
            </p>
          </div>
          <div>
            <p className="text-slate-500">{isCs ? 'Stabilita' : 'Stability'}</p>
            <p className={`mt-0.5 font-mono font-semibold tabular-nums ${stabilityTone}`}>
              {stats.stabilityPct !== null ? `${stats.stabilityPct}${isCs ? ' %' : '%'}` : '—'}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-5 h-[220px] w-full min-w-0 rounded-lg border border-[#1B2230] bg-[#0B0E15] p-3">
        {chartData.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center px-4">
            <p className="text-xs font-medium text-slate-300">
              {isRunning
                ? isCs
                  ? 'Sbírám první vzorky výpočetní rychlosti...'
                  : 'Collecting initial hashrate samples...'
                : isCs
                  ? 'Zatím nejsou zaznamenány žádné vzorky rychlosti'
                  : 'No speed samples recorded yet'}
            </p>
            <p className="mt-1 text-[11px] text-slate-500 max-w-md">
              {isCs
                ? 'Po spuštění výpočtu se zde každou sekundu vykreslí průběh aktuální rychlosti tohoto zařízení v Keys/s včetně průměrné linie.'
                : 'Once scanning starts, real-time throughput in Keys/s and the rolling average line plot every second.'}
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <AreaChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="puzzleSpeedGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#F7931A" stopOpacity={0.38} />
                  <stop offset="95%" stopColor="#F7931A" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1A2232" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="timeLabel"
                stroke="#475569"
                tick={{ fill: '#64748B', fontSize: 11, fontFamily: 'monospace' }}
                tickLine={false}
                axisLine={{ stroke: '#1E2638' }}
                minTickGap={28}
              />
              <YAxis
                stroke="#475569"
                tick={{ fill: '#64748B', fontSize: 11, fontFamily: 'monospace' }}
                tickLine={false}
                axisLine={false}
                width={56}
                domain={[0, 'auto']}
                tickFormatter={(val: number) => `${val}`}
              />
              <Tooltip
                content={<SpeedTooltip />}
                cursor={{ stroke: '#334155', strokeDasharray: '3 3' }}
              />
              {scaledAvg > 0 && (
                <ReferenceLine
                  y={scaledAvg}
                  stroke="#38BDF8"
                  strokeDasharray="4 4"
                  strokeOpacity={0.65}
                />
              )}
              <Area
                type="monotone"
                dataKey="scaledRate"
                name={scale.unitLabel}
                stroke="#F7931A"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#puzzleSpeedGradient)"
                isAnimationActive={false}
                dot={chartData.length <= 2}
                activeDot={{ r: 4, fill: '#F7931A', stroke: '#0B0E15', strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {chartData.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 font-mono">
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5 text-slate-400">
              <span className="inline-block h-2 w-3 rounded-xs bg-[#F7931A]" aria-hidden="true" />
              {isCs ? 'Okamžitá rychlost' : 'Instant rate'} ({scale.unitLabel})
            </span>
            <span className="inline-flex items-center gap-1.5 text-sky-400/90">
              <span
                className="inline-block h-0.5 w-3 border-t border-dashed border-sky-400"
                aria-hidden="true"
              />
              {isCs ? 'Průměr' : 'Average'} ({formatKeysRate(stats.avgKps)})
            </span>
          </div>
          <span>
            {isCs
              ? `Toto zařízení · Vzorky: ${chartData.length} / 90`
              : `This device · Samples: ${chartData.length} / 90`}
          </span>
        </div>
      )}
    </section>
  );
}
