import type { ActiveTab } from '../types/api.ts';

export type Locale = 'en' | 'cs';

export const DEFAULT_LOCALE: Locale = 'en';

export interface RouteState {
  locale: Locale;
  tab: ActiveTab;
}

const EN_PATHS: Record<ActiveTab, string> = {
  compute: '/',
  ledger: '/blocks',
  puzzles: '/puzzles',
  leaderboard: '/leaderboard',
  relay: '/transaction-protection',
  docs: '/how-it-works',
  terms: '/terms',
};

const CS_PATHS: Record<ActiveTab, string> = {
  compute: '/cs',
  ledger: '/cs/bloky',
  puzzles: '/cs/tabulka-puzzle',
  leaderboard: '/cs/zebricek',
  relay: '/cs/ochrana-transakce',
  docs: '/cs/jak-to-funguje',
  terms: '/cs/podminky',
};

const LEGACY_CS_PATHS: Record<string, ActiveTab> = {
  '/tabulka-puzzle': 'puzzles',
  '/zebricek': 'leaderboard',
  '/jak-to-funguje': 'docs',
  '/ochrana-transakce': 'relay',
  '/podminky': 'terms',
};

export function normalizePathname(pathname: string): string {
  const clean = pathname.replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

export function parseRoute(pathname: string, search = ''): RouteState {
  const [rawPath, inlineQuery] = pathname.split('?', 2);
  const clean = normalizePathname(rawPath);
  const effectiveSearch = search || (inlineQuery ? `?${inlineQuery}` : '');
  const params = new URLSearchParams(effectiveSearch);
  const langParam = params.get('lang')?.toLowerCase();

  let tab: ActiveTab = 'compute';
  let pathLocale: Locale | null = null;

  if (clean === '/cs' || clean.startsWith('/cs/')) {
    pathLocale = 'cs';
    for (const [k, v] of Object.entries(CS_PATHS) as Array<[ActiveTab, string]>) {
      if (clean === v) {
        tab = k;
        break;
      }
    }
  } else if (LEGACY_CS_PATHS[clean]) {
    pathLocale = 'cs';
    tab = LEGACY_CS_PATHS[clean];
  } else {
    for (const [k, v] of Object.entries(EN_PATHS) as Array<[ActiveTab, string]>) {
      if (clean === v) {
        tab = k;
        if (k !== 'compute') {
          pathLocale = 'en';
        }
        break;
      }
    }
  }

  const locale: Locale =
    langParam === 'cs' || langParam === 'en'
      ? langParam
      : (pathLocale ?? DEFAULT_LOCALE);

  return { locale, tab };
}

export function pathnameForTab(tab: ActiveTab, locale: Locale): string {
  return locale === 'cs' ? CS_PATHS[tab] : EN_PATHS[tab];
}

export function buildUrlForRoute(
  tab: ActiveTab,
  locale: Locale,
  shareToken?: string | null,
): string {
  const path = pathnameForTab(tab, locale);
  if (shareToken) {
    return `${path}?u=${encodeURIComponent(shareToken)}`;
  }
  return path;
}

export function getHtmlLang(locale: Locale): string {
  return locale === 'cs' ? 'cs' : 'en';
}

export function getOgLocale(locale: Locale): { current: string; alternate: string } {
  return locale === 'cs'
    ? { current: 'cs_CZ', alternate: 'en_US' }
    : { current: 'en_US', alternate: 'cs_CZ' };
}

export function formatLocalizedNumber(n: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'cs' ? 'cs-CZ' : 'en-US').format(n);
}

export function formatLocalizedDecimal(
  value: number,
  decimals: number,
  locale: Locale,
): string {
  const fixed = value.toFixed(decimals);
  return locale === 'cs' ? fixed.replace('.', ',') : fixed;
}

export function formatLocalizedFloatString(value: number, locale: Locale): string {
  const str = String(value);
  return locale === 'cs' ? str.replace('.', ',') : str;
}

export interface RouteSeoMeta {
  title: string;
  description: string;
}

export function getRouteSeoMeta(tab: ActiveTab, locale: Locale): RouteSeoMeta {
  if (locale === 'cs') {
    const csMeta: Record<ActiveTab, RouteSeoMeta> = {
      compute: {
        title: 'Bitcoin Puzzle #71 — WebGPU řešič a tabulka klíčů',
        description:
          'Bitcoin Puzzle #71 WebGPU řešič v prohlížeči. Přehled 160 puzzle adres (988,498 BTC celkem, 903 BTC zbývá), kalkulačka pravděpodobnosti a privátní relay.',
      },
      ledger: {
        title: 'Zařízení a prohledané bloky — Bitcoin Puzzle #71 WebGPU',
        description:
          'Přehled připojených zařízení, aktuální rychlost WebGPU/CPU a seznam dokončených 2²⁹ bloků pro Bitcoin Puzzle #71.',
      },
      puzzles: {
        title: 'Bitcoin Puzzle #1–#160: Seznam adres, rozsahy a kalkulačka',
        description:
          'Kompletní přehled adres, HEX rozsahů klíčů, vyřešených pozic a kalkulačka času pro 988,498 BTC sérii Bitcoin Puzzle včetně Puzzle #71.',
      },
      leaderboard: {
        title: 'Veřejný žebříček řešitelů Bitcoin Puzzle #71',
        description:
          'Anonymizovaný veřejný žebříček aktivních řešitelů Bitcoin Puzzle #71 s počtem prohledaných klíčů, bloků a sólo postupem.',
      },
      relay: {
        title: 'Ochrana transakce: MARA Slipstream & Rebar Shield',
        description:
          'Jak chránit vyřešený Bitcoin Puzzle #71 před krádeží RBF boty ve veřejném mempoolu pomocí lokálního podpisu a privátních poolů.',
      },
      docs: {
        title: 'Co je Bitcoin Puzzle #71 a jak funguje WebGPU řešič',
        description:
          'Technický průvodce Bitcoin Puzzle #71: eliptická křivka secp256k1, WebGPU WGSL shadery, PoW bloky a srovnání s BitCrack a Kangaroo.',
      },
      terms: {
        title: 'Podmínky užití a rizika — Bitcoin Puzzle #71 WebGPU',
        description:
          'Edukativní charakter projektu Puzzle71 WebGPU, vyloučení záruk (as-is), rozdělení odměny 85 % / 15 % a převzetí veškerých uživatelských rizik.',
      },
    };
    return csMeta[tab] ?? csMeta.compute;
  }

  const enMeta: Record<ActiveTab, RouteSeoMeta> = {
    compute: {
      title: 'Bitcoin Puzzle #71 — WebGPU Solver & Key Directory',
      description:
        'Browser WebGPU solver for Bitcoin Puzzle #71. Full #1–#160 directory (988.498 BTC total, 903 BTC remaining), odds calculator, and private pool relay.',
    },
    ledger: {
      title: 'Devices & Scanned Blocks — Bitcoin Puzzle #71 WebGPU',
      description:
        'Monitor connected devices, live WebGPU/CPU key rates, and completed non-overlapping 2²⁹ blocks for Bitcoin Puzzle #71.',
    },
    puzzles: {
      title: 'Bitcoin Puzzle #1–#160: Address List, Hex Ranges & ETA',
      description:
        'Verified directory of all 160 Bitcoin Puzzle Transaction addresses, private key hex bounds, solved positions, and interactive ETA calculator.',
    },
    leaderboard: {
      title: 'Public Bitcoin Puzzle #71 Solver Leaderboard',
      description:
        'Anonymized public leaderboard of Bitcoin Puzzle #71 solo sessions tracking verified scanned keys, completed blocks, and keyspace progress.',
    },
    relay: {
      title: 'Transaction Protection (MARA Slipstream & Rebar Shield)',
      description:
        'Prevent RBF front-running bots from stealing Puzzle #71 funds using local browser signing and private mining-pool submission.',
    },
    docs: {
      title: 'What Is Bitcoin Puzzle #71 & How WebGPU Solving Works',
      description:
        'Technical guide to Bitcoin Puzzle #71: secp256k1 elliptic curve, WebGPU WGSL compute shaders, PoW blocks, and BitCrack/Kangaroo comparison.',
    },
    terms: {
      title: 'Terms of Use & Risk Disclaimer — Puzzle71 WebGPU',
      description:
        'Educational research scope, as-is warranty disclaimer, 85% / 15% payout split rules, and user hardware and financial risk disclosure.',
    },
  };
  return enMeta[tab] ?? enMeta.compute;
}

export const SITEMAP_TAB_PAIRS: Array<{
  tab: ActiveTab;
  changefreq: string;
  priority: string;
}> = [
  { tab: 'compute', changefreq: 'daily', priority: '1.0' },
  { tab: 'puzzles', changefreq: 'weekly', priority: '0.9' },
  { tab: 'leaderboard', changefreq: 'hourly', priority: '0.8' },
  { tab: 'docs', changefreq: 'monthly', priority: '0.8' },
  { tab: 'relay', changefreq: 'monthly', priority: '0.7' },
  { tab: 'terms', changefreq: 'yearly', priority: '0.5' },
];
