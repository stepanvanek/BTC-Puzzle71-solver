import { Globe } from 'lucide-react';
import { useLocale } from '../i18n/LocaleContext.tsx';
import { pathnameForTab } from '../i18n/locale.ts';
import type { ActiveTab } from '../types/api.ts';

interface TopBarProps {
  hasSession: boolean;
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onResetSession: () => void;
}

export function TopBar({
  hasSession,
  activeTab,
  onSelectTab,
  onResetSession,
}: TopBarProps) {
  const { locale, setLocale } = useLocale();
  const isCs = locale === 'cs';

  const navItems: Array<{
    id: ActiveTab;
    label: string;
    mobileLabel: string;
    requiresSession: boolean;
  }> = [
    {
      id: 'compute',
      label: isCs ? 'Výpočet' : 'Compute',
      mobileLabel: isCs ? 'Výpočet' : 'Compute',
      requiresSession: true,
    },
    {
      id: 'ledger',
      label: isCs ? 'Bloky a zařízení' : 'Blocks & Devices',
      mobileLabel: isCs ? 'Bloky' : 'Blocks',
      requiresSession: true,
    },
    {
      id: 'puzzles',
      label: 'Puzzle #1–#160',
      mobileLabel: 'Puzzles',
      requiresSession: false,
    },
    {
      id: 'leaderboard',
      label: isCs ? 'Žebříček' : 'Leaderboard',
      mobileLabel: isCs ? 'Žebříček' : 'Ranks',
      requiresSession: false,
    },
    {
      id: 'relay',
      label: isCs ? 'Ochrana transakce' : 'Tx Protection',
      mobileLabel: isCs ? 'Transakce' : 'Relay',
      requiresSession: false,
    },
    {
      id: 'docs',
      label: isCs ? 'Jak to funguje' : 'How It Works',
      mobileLabel: isCs ? 'Návod' : 'Guide',
      requiresSession: false,
    },
    {
      id: 'terms',
      label: isCs ? 'Rizika' : 'Terms',
      mobileLabel: isCs ? 'Rizika' : 'Terms',
      requiresSession: false,
    },
  ];

  return (
    <header className="border-b border-[#1E2534] bg-[#0B0E15]">
      <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-3 sm:gap-5 px-4 sm:px-6 py-4">
        <a
          href={pathnameForTab('compute', locale)}
          onClick={(e) => {
            e.preventDefault();
            onSelectTab('compute');
          }}
          className="font-display text-lg font-semibold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          Puzzle71 WebGPU
        </a>

        <nav
          aria-label={isCs ? 'Hlavní navigace' : 'Primary navigation'}
          className="hidden md:flex items-center gap-4 lg:gap-5 text-sm font-medium"
        >
          {navItems.map((item) => {
            const disabled = item.requiresSession && !hasSession;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                disabled={disabled}
                onClick={() => onSelectTab(item.id)}
                className={`whitespace-nowrap shrink-0 pb-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F7931A] rounded-sm ${
                  disabled
                    ? 'text-slate-600 cursor-not-allowed'
                    : isActive
                      ? 'text-[#F7931A] border-b-2 border-[#F7931A]'
                      : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {/* Accessible Language Switcher (EN primary / CS secondary) */}
          <div
            role="group"
            aria-label={isCs ? 'Přepínač jazyka' : 'Language switcher'}
            className="inline-flex items-center rounded-lg border border-[#283144] bg-[#11151E] p-0.5 text-[11px] font-semibold shrink-0"
          >
            <Globe className="h-3.5 w-3.5 text-slate-400 mx-1.5 hidden sm:block shrink-0" aria-hidden="true" />
            <button
              type="button"
              lang="en"
              aria-pressed={locale === 'en'}
              aria-label="Switch language to English"
              onClick={() => setLocale('en')}
              className={`rounded-md px-2 py-1 transition-colors cursor-pointer whitespace-nowrap ${
                locale === 'en'
                  ? 'bg-[#F7931A] text-[#090B10]'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              EN
            </button>
            <button
              type="button"
              lang="cs"
              aria-pressed={locale === 'cs'}
              aria-label="Přepnout jazyk do češtiny"
              onClick={() => setLocale('cs')}
              className={`rounded-md px-2 py-1 transition-colors cursor-pointer whitespace-nowrap ${
                locale === 'cs'
                  ? 'bg-[#F7931A] text-[#090B10]'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              CS
            </button>
          </div>

          {hasSession ? (
            <button
              type="button"
              onClick={onResetSession}
              className="rounded-lg border border-[#283144] bg-[#141925] px-3 sm:px-4 py-2 text-xs font-medium text-slate-200 hover:border-[#3A4761] hover:bg-[#1A2130] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isCs ? 'Změnit BTC adresu' : 'Change BTC Address'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onSelectTab('compute')}
              className="rounded-lg bg-[#F7931A] px-3 sm:px-4 py-2 text-xs font-semibold text-[#090B10] hover:bg-[#ff9f2e] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isCs ? 'Nastavit adresu' : 'Set Address'}
            </button>
          )}
        </div>
      </div>

      {/* Mobile compact nav */}
      <div className="flex md:hidden flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-[#171C28] px-4 py-2.5 text-[11px] font-medium">
        {navItems.map((item) => {
          const disabled = item.requiresSession && !hasSession;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              onClick={() => onSelectTab(item.id)}
              className={`whitespace-nowrap shrink-0 ${
                disabled
                  ? 'text-slate-600'
                  : isActive
                    ? 'text-[#F7931A]'
                    : 'text-slate-400'
              }`}
            >
              {item.mobileLabel}
            </button>
          );
        })}
      </div>
    </header>
  );
}
