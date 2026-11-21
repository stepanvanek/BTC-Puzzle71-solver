export interface SpeedSample {
  timestamp: number;
  timeLabel: string;
  rateKps: number;
}

export interface RateScale {
  divisor: number;
  unitLabel: string;
  decimals: number;
}

export interface SpeedStats {
  currentKps: number;
  avgKps: number;
  minKps: number;
  maxKps: number;
  stabilityPct: number | null;
}

export const DEFAULT_MAX_SPEED_SAMPLES = 90;

export function formatTimeLabelCs(timestamp: number): string {
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function selectRateScale(maxKps: number): RateScale {
  if (maxKps >= 1_000_000) {
    return { divisor: 1_000_000, unitLabel: 'MKeys/s', decimals: 2 };
  }
  if (maxKps >= 1_000) {
    return { divisor: 1_000, unitLabel: 'kKeys/s', decimals: 2 };
  }
  return { divisor: 1, unitLabel: 'Keys/s', decimals: 0 };
}

export function formatKeysRate(kps: number): string {
  if (!Number.isFinite(kps) || kps <= 0) return '0 Keys/s';
  if (kps >= 1_000_000) return `${(kps / 1_000_000).toFixed(2)} MKeys/s`;
  if (kps >= 1_000) return `${(kps / 1_000).toFixed(2)} kKeys/s`;
  return `${Math.round(kps)} Keys/s`;
}

export function appendSpeedSample(
  history: SpeedSample[],
  rateKps: number,
  timestamp: number,
  maxSamples = DEFAULT_MAX_SPEED_SAMPLES,
  minIntervalMs = 950,
): SpeedSample[] {
  if (!Number.isFinite(rateKps) || rateKps < 0 || !Number.isFinite(timestamp)) {
    return history;
  }

  const last = history[history.length - 1];
  if (last && timestamp - last.timestamp < minIntervalMs) {
    return history;
  }

  const nextSample: SpeedSample = {
    timestamp,
    timeLabel: formatTimeLabelCs(timestamp),
    rateKps: Math.round(rateKps),
  };

  const next = [...history, nextSample];
  if (next.length > maxSamples) {
    return next.slice(next.length - maxSamples);
  }
  return next;
}

export function computeSpeedStats(history: SpeedSample[]): SpeedStats {
  const active = history.filter((s) => Number.isFinite(s.rateKps) && s.rateKps > 0);
  if (active.length === 0) {
    return {
      currentKps: 0,
      avgKps: 0,
      minKps: 0,
      maxKps: 0,
      stabilityPct: null,
    };
  }

  let sum = 0;
  let minKps = Infinity;
  let maxKps = -Infinity;
  for (const s of active) {
    sum += s.rateKps;
    if (s.rateKps < minKps) minKps = s.rateKps;
    if (s.rateKps > maxKps) maxKps = s.rateKps;
  }

  const avgKps = sum / active.length;
  const currentKps = history[history.length - 1]?.rateKps ?? 0;

  let stabilityPct: number | null = null;
  if (active.length >= 2 && avgKps > 0) {
    let varianceSum = 0;
    for (const s of active) {
      const diff = s.rateKps - avgKps;
      varianceSum += diff * diff;
    }
    const stdDev = Math.sqrt(varianceSum / active.length);
    const cv = stdDev / avgKps;
    stabilityPct = Math.max(0, Math.min(100, Math.round((1 - cv) * 100)));
  } else if (active.length === 1) {
    stabilityPct = 100;
  }

  return {
    currentKps,
    avgKps,
    minKps,
    maxKps,
    stabilityPct,
  };
}
