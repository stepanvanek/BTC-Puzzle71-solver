import type { Locale } from '../i18n/locale.ts';
import { PUZZLE_71_TOTAL_KEYS } from '../shared/puzzle71.ts';

const SECONDS_PER_YEAR = 365.25 * 86_400; // 31,557,600 s
const PUZZLE_71_TOTAL_FLOAT = Number(PUZZLE_71_TOTAL_KEYS); // 2^70 ≈ 1.1805916207174113e21

/**
 * Computes percentage [0, 100] of the entire Puzzle #71 (2^70) keyspace covered by `keysChecked`.
 */
export function calculateKeyspaceProgressPercent(keysChecked: number | bigint): number {
  const val = typeof keysChecked === 'bigint' ? Number(keysChecked) : Number(keysChecked);
  if (!Number.isFinite(val) || val <= 0) return 0;
  const pct = (val / PUZZLE_71_TOTAL_FLOAT) * 100;
  return Math.max(0, Math.min(100, pct));
}

function formatDecimalForLocale(raw: string, locale: Locale): string {
  return locale === 'cs' ? raw.replace('.', ',') : raw;
}

/**
 * Formats keyspace percentage as a full standard decimal percentage (no scientific notation),
 * preserving 2 significant digits past the leading fractional zeros for tiny keyspace slices.
 */
export function formatKeyspaceProgressPercent(
  keysChecked: number | bigint,
  locale: Locale = 'en',
): string {
  const pct = calculateKeyspaceProgressPercent(keysChecked);
  if (pct <= 0) return locale === 'cs' ? '0 %' : '0%';
  const pctSuffix = locale === 'cs' ? ' %' : '%';
  if (pct >= 1) {
    return `${formatDecimalForLocale(pct.toFixed(2), locale)}${pctSuffix}`;
  }
  if (pct >= 0.001) {
    return `${formatDecimalForLocale(pct.toFixed(4), locale)}${pctSuffix}`;
  }
  const exp = Math.floor(Math.log10(pct));
  const decimals = Math.min(25, Math.max(4, Math.abs(exp) + 1));
  return `${formatDecimalForLocale(pct.toFixed(decimals), locale)}${pctSuffix}`;
}

export interface KeyspaceProgressPercentParts {
  fullText: string;
  integerPart: string;
  fractionAndSuffix: string;
}

/**
 * Splits a formatted keyspace progress percentage at its decimal separator so
 * table rows can align cleanly by the decimal comma/point.
 */
export function splitKeyspaceProgressPercent(
  keysChecked: number | bigint,
  locale: Locale = 'en',
): KeyspaceProgressPercentParts {
  const fullText = formatKeyspaceProgressPercent(keysChecked, locale);
  const sep = locale === 'cs' ? ',' : '.';
  const sepIdx = fullText.indexOf(sep);
  if (sepIdx !== -1) {
    return {
      fullText,
      integerPart: fullText.slice(0, sepIdx),
      fractionAndSuffix: fullText.slice(sepIdx),
    };
  }
  const suffixIdx = fullText.indexOf(locale === 'cs' ? ' %' : '%');
  if (suffixIdx !== -1) {
    return {
      fullText,
      integerPart: fullText.slice(0, suffixIdx),
      fractionAndSuffix: fullText.slice(suffixIdx),
    };
  }
  return {
    fullText,
    integerPart: fullText,
    fractionAndSuffix: '',
  };
}

/**
 * Estimates total seconds required to traverse the remaining Puzzle #71 keyspace at `rateKps` (Keys/s).
 */
export function estimateFullKeyspaceSeconds(
  rateKps: number,
  keysAlreadyChecked: number | bigint = 0,
): number | null {
  if (!Number.isFinite(rateKps) || rateKps <= 0) return null;
  const checked =
    typeof keysAlreadyChecked === 'bigint' ? Number(keysAlreadyChecked) : Number(keysAlreadyChecked);
  const safeChecked = Number.isFinite(checked) && checked > 0 ? checked : 0;
  const remaining = Math.max(0, PUZZLE_71_TOTAL_FLOAT - safeChecked);
  return remaining / rateKps;
}

function formatYearsCount(
  years: number,
  locale: Locale,
  enUnit: 'yr' | 'yrs',
  subThousandDecimalThreshold = 1000,
): string {
  const cs = locale === 'cs';
  const unit = cs ? 'let' : enUnit;

  if (years < subThousandDecimalThreshold) {
    return `${formatDecimalForLocale(years.toFixed(1), locale)} ${unit}`;
  }
  if (years < 1_000_000) {
    const formatted = new Intl.NumberFormat(cs ? 'cs-CZ' : 'en-US').format(Math.round(years));
    return `${formatted} ${unit}`;
  }
  if (years < 1_000_000_000) {
    return `${formatDecimalForLocale((years / 1_000_000).toFixed(2), locale)} ${cs ? 'mil. let' : `M ${enUnit}`}`;
  }
  if (years < 1_000_000_000_000) {
    return `${formatDecimalForLocale((years / 1_000_000_000).toFixed(2), locale)} ${cs ? 'mld. let' : `B ${enUnit}`}`;
  }
  if (years < 1_000_000_000_000_000) {
    return `${formatDecimalForLocale((years / 1_000_000_000_000).toFixed(2), locale)} ${cs ? 'bil. let' : `T ${enUnit}`}`;
  }
  if (years < 1e18) {
    return `${formatDecimalForLocale((years / 1e15).toFixed(2), locale)} ${cs ? 'bld. let' : `Qa ${enUnit}`}`;
  }
  if (years < 1e21) {
    return `${formatDecimalForLocale((years / 1e18).toFixed(2), locale)} ${cs ? 'tril. let' : `Qi ${enUnit}`}`;
  }
  return `${formatDecimalForLocale(years.toExponential(2), locale)} ${unit}`;
}

/**
 * Formats arbitrarily large or small durations into readable units in the selected locale.
 */
export function formatDurationFromSeconds(
  seconds: number | null,
  locale: Locale = 'en',
): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  if (seconds < 60) {
    return `${Math.max(1, Math.round(seconds))} s`;
  }
  if (seconds < 3600) {
    return `${formatDecimalForLocale((seconds / 60).toFixed(1), locale)} min`;
  }
  if (seconds < 86_400) {
    return `${formatDecimalForLocale((seconds / 3600).toFixed(1), locale)} ${locale === 'cs' ? 'hod' : 'hr'}`;
  }
  if (seconds < SECONDS_PER_YEAR) {
    return `${formatDecimalForLocale((seconds / 86_400).toFixed(1), locale)} ${locale === 'cs' ? 'dní' : 'days'}`;
  }

  return formatYearsCount(seconds / SECONDS_PER_YEAR, locale, 'yr', 1000);
}

/**
 * Formats Puzzle #1–#160 odds calculator durations with sub-second precision,
 * localized decimals, and readable multi-million/billion/trillion year units.
 */
export function formatCalculatorDuration(seconds: number, locale: Locale = 'en'): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '∞';
  if (seconds < 1) return locale === 'cs' ? '< 1 s' : '< 1s';
  if (seconds < 60) return `${formatDecimalForLocale(seconds.toFixed(1), locale)} s`;
  const mins = seconds / 60;
  if (mins < 60) return `${formatDecimalForLocale(mins.toFixed(1), locale)} min`;
  const hours = mins / 60;
  if (hours < 24) {
    return `${formatDecimalForLocale(hours.toFixed(1), locale)} ${locale === 'cs' ? 'hod' : 'hrs'}`;
  }
  const days = hours / 24;
  if (days < 365.25) {
    return `${formatDecimalForLocale(days.toFixed(1), locale)} ${locale === 'cs' ? 'dní' : 'days'}`;
  }
  return formatYearsCount(days / 365.25, locale, 'yrs', 100);
}

export function formatCzechDurationFromSeconds(seconds: number | null): string {
  return formatDurationFromSeconds(seconds, 'cs');
}
