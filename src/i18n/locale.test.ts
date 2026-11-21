import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LOCALE,
  buildUrlForRoute,
  formatLocalizedDecimal,
  formatLocalizedNumber,
  getHtmlLang,
  getOgLocale,
  getRouteSeoMeta,
  parseRoute,
  pathnameForTab,
} from './locale.ts';

test('English is the default primary locale and resolves canonical root paths', () => {
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.deepEqual(parseRoute('/'), { locale: 'en', tab: 'compute' });
  assert.deepEqual(parseRoute('/puzzles'), { locale: 'en', tab: 'puzzles' });
  assert.deepEqual(parseRoute('/leaderboard'), { locale: 'en', tab: 'leaderboard' });
  assert.deepEqual(parseRoute('/how-it-works'), { locale: 'en', tab: 'docs' });
  assert.deepEqual(parseRoute('/transaction-protection'), { locale: 'en', tab: 'relay' });
  assert.deepEqual(parseRoute('/terms'), { locale: 'en', tab: 'terms' });
  assert.deepEqual(parseRoute('/blocks'), { locale: 'en', tab: 'ledger' });
});

test('Czech routes and legacy Czech paths resolve cleanly to cs locale', () => {
  assert.deepEqual(parseRoute('/cs'), { locale: 'cs', tab: 'compute' });
  assert.deepEqual(parseRoute('/cs/'), { locale: 'cs', tab: 'compute' });
  assert.deepEqual(parseRoute('/cs/tabulka-puzzle'), { locale: 'cs', tab: 'puzzles' });
  assert.deepEqual(parseRoute('/cs/zebricek'), { locale: 'cs', tab: 'leaderboard' });
  assert.deepEqual(parseRoute('/cs/jak-to-funguje'), { locale: 'cs', tab: 'docs' });
  assert.deepEqual(parseRoute('/cs/ochrana-transakce'), { locale: 'cs', tab: 'relay' });
  assert.deepEqual(parseRoute('/cs/podminky'), { locale: 'cs', tab: 'terms' });
  assert.deepEqual(parseRoute('/cs/bloky'), { locale: 'cs', tab: 'ledger' });

  // Legacy Czech URLs remain supported
  assert.deepEqual(parseRoute('/tabulka-puzzle'), { locale: 'cs', tab: 'puzzles' });
  assert.deepEqual(parseRoute('/?lang=cs'), { locale: 'cs', tab: 'compute' });
  assert.deepEqual(parseRoute('/', '?lang=cs'), { locale: 'cs', tab: 'compute' });
});

test('buildUrlForRoute preserves session token across language switches', () => {
  assert.equal(pathnameForTab('puzzles', 'en'), '/puzzles');
  assert.equal(pathnameForTab('puzzles', 'cs'), '/cs/tabulka-puzzle');
  assert.equal(buildUrlForRoute('compute', 'en', 'abc123'), '/?u=abc123');
  assert.equal(buildUrlForRoute('compute', 'cs', 'abc123'), '/cs?u=abc123');
  assert.equal(buildUrlForRoute('terms', 'cs'), '/cs/podminky');
});

test('SEO metadata meets title/description lengths and alternate og:locale rules', () => {
  const tabs = ['compute', 'ledger', 'puzzles', 'leaderboard', 'relay', 'docs', 'terms'] as const;
  for (const locale of ['en', 'cs'] as const) {
    for (const tab of tabs) {
      const meta = getRouteSeoMeta(tab, locale);
      assert.ok(meta.title.length >= 30 && meta.title.length <= 70, `Title length for ${locale}/${tab}: ${meta.title.length}`);
      assert.ok(meta.description.length >= 110 && meta.description.length <= 165, `Description length for ${locale}/${tab}: ${meta.description.length}`);
    }
  }
  assert.equal(getHtmlLang('en'), 'en');
  assert.equal(getHtmlLang('cs'), 'cs');
  assert.deepEqual(getOgLocale('en'), { current: 'en_US', alternate: 'cs_CZ' });
  assert.deepEqual(getOgLocale('cs'), { current: 'cs_CZ', alternate: 'en_US' });
  assert.equal(formatLocalizedDecimal(7.1, 2, 'en'), '7.10');
  assert.equal(formatLocalizedDecimal(7.1, 2, 'cs'), '7,10');
  assert.equal(formatLocalizedNumber(1000, 'en'), '1,000');
});
