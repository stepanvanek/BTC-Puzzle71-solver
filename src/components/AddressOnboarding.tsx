import { AlertTriangle, ArrowRight, CheckCircle2, Cpu, KeyRound, Lock, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useLocale } from '../i18n/LocaleContext.tsx';
import { validateBitcoinAddress } from '../shared/btcAddress.ts';
import { PUZZLE_71_ADDRESS, PUZZLE_71_HASH160_HEX } from '../shared/puzzle71.ts';
import { LeaderboardSection } from './LeaderboardSection.tsx';
import { PuzzleDirectorySection } from './PuzzleDirectorySection.tsx';

interface AddressOnboardingProps {
  onCreateSession: (btcAddress: string) => Promise<void>;
  isSubmitting: boolean;
  serverError: string | null;
  detectedKeysPerSec?: number;
  onOpenDocs?: () => void;
  onOpenTerms?: () => void;
  onOpenLeaderboard?: () => void;
  onOpenPuzzles?: () => void;
}

const SAMPLE_ADDRESSES = [
  {
    label: 'P2WPKH (bc1q...)',
    address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  },
  {
    label: 'Taproot P2TR (bc1p...)',
    address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
  },
  {
    label: 'Legacy P2PKH (1...)',
    address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
  },
  {
    label: 'P2SH (3...)',
    address: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
  },
];

export function AddressOnboarding({
  onCreateSession,
  isSubmitting,
  serverError,
  detectedKeysPerSec = 0,
  onOpenDocs,
  onOpenTerms,
  onOpenLeaderboard,
  onOpenPuzzles,
}: AddressOnboardingProps) {
  const { locale } = useLocale();
  const isCs = locale === 'cs';

  const [address, setAddress] = useState('');
  const [touched, setTouched] = useState(false);

  const validation = useMemo(() => {
    if (!address.trim()) return null;
    return validateBitcoinAddress(address, locale);
  }, [address, locale]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    const check = validateBitcoinAddress(address, locale);
    if (!check.valid) return;
    await onCreateSession(address.trim());
  };

  return (
    <div className="mx-auto max-w-[1040px] px-6 py-12 space-y-12">
      {/* Hero & Address Form */}
      <section aria-labelledby="hero-title">
        <div className="max-w-3xl">
          <p className="text-xs font-medium tracking-wide text-[#F7931A]">
            {isCs
              ? 'Bitcoin Puzzle 988,498 BTC výzva (#1–#160) · Puzzle #71 (7,10 BTC · rozsah 2⁷⁰ až 2⁷¹ − 1)'
              : 'Bitcoin Puzzle 988.498 BTC Challenge (#1–#160) · Puzzle #71 (7.10 BTC · Range 2⁷⁰ to 2⁷¹ − 1)'}
          </p>
          <h1
            id="hero-title"
            className="mt-3 font-display text-3xl sm:text-5xl font-semibold tracking-tight text-slate-100 text-balance leading-[1.12]"
          >
            {isCs
              ? 'Bitcoin Puzzle #71 — WebGPU řešič a přehled klíčů v prohlížeči'
              : 'Bitcoin Puzzle #71 — Browser WebGPU Solver & Key Directory'}
          </h1>
          <p className="mt-4 text-base text-slate-400 leading-relaxed max-w-2xl">
            {isCs
              ? 'Experimentální a vzdělávací nástroj pro výzkum Bitcoin Puzzle a eliptické křivky secp256k1. Zadejte svou veřejnou bitcoinovou adresu libovolné verze — bez instalace získáte sdílenou URL pro více zařízení, synchronizaci unikátních bloků a privátní ochranu případné transakce.'
              : 'Experimental & educational tool for exploring the Bitcoin Puzzle challenge and secp256k1 elliptic-curve cryptography. Enter any public Bitcoin address version — no installation required — to get a multi-device share URL, non-overlapping block sync, and private pool transaction protection.'}
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="mt-8 rounded-xl border border-[#222938] bg-[#11151E] p-6 sm:p-8"
        >
          <div className="flex flex-col gap-3">
            <label htmlFor="btc-address-input" className="text-sm font-medium text-slate-200">
              {isCs
                ? 'Vaše veřejná výplatní bitcoinová adresa (nikdy nezadávejte seed ani privátní klíč)'
                : 'Your public Bitcoin payout address (never enter a seed phrase or private key)'}
            </label>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                id="btc-address-input"
                type="text"
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  if (!touched) setTouched(true);
                }}
                placeholder={
                  isCs
                    ? 'bc1q..., bc1p..., 1..., 3..., nebo novější bc1... (v2–v16)'
                    : 'bc1q..., bc1p..., 1..., 3..., or newer bc1... (v2–v16)'
                }
                spellCheck={false}
                autoComplete="off"
                className="flex-1 rounded-lg border border-[#283144] bg-[#0B0E15] px-4 py-3 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-[#F7931A] focus:outline-none"
              />
              <button
                type="submit"
                disabled={isSubmitting || !validation?.valid}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#F7931A] px-6 py-3 text-sm font-semibold text-[#090B10] transition-colors hover:bg-[#ff9f2e] disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>
                  {isSubmitting
                    ? isCs
                      ? 'Vytvářím relaci...'
                      : 'Creating session...'
                    : isCs
                      ? 'Vytvořit URL a spustit'
                      : 'Create URL & Launch'}
                </span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Validation feedback */}
          <div className="mt-3 min-h-[24px] text-xs">
            {validation?.valid && validation.parsed ? (
              <div className="flex items-center gap-2 text-emerald-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  {isCs ? 'Platná adresa:' : 'Valid address:'}{' '}
                  <strong className="font-semibold">{validation.parsed.versionLabel}</strong> (
                  {validation.parsed.encoding})
                </span>
              </div>
            ) : touched && address.trim() && validation && !validation.valid ? (
              <div role="alert" className="flex items-center gap-2 text-red-400">
                <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{validation.error}</span>
              </div>
            ) : touched && !address.trim() ? (
              <div role="alert" className="flex items-center gap-2 text-red-400">
                <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  {isCs
                    ? 'Zadejte platnou bitcoinovou adresu pro pokračování.'
                    : 'Enter a valid Bitcoin address to continue.'}
                </span>
              </div>
            ) : (
              <p className="text-slate-500">
                {isCs
                  ? 'Podporované formáty: Legacy P2PKH (1…), P2SH (3…), SegWit v0 Bech32 (bc1q…), Taproot v1 Bech32m (bc1p…) i budoucí witness verze v2–v16.'
                  : 'Supported formats: Legacy P2PKH (1…), P2SH (3…), SegWit v0 Bech32 (bc1q…), Taproot v1 Bech32m (bc1p…), and future witness versions v2–v16.'}
              </p>
            )}
          </div>

          {serverError && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-xs text-red-300"
            >
              {serverError}
            </div>
          )}

          <div className="mt-5 border-t border-[#1D2432] pt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500">
            <span>
              {isCs
                ? 'Ukázkové formáty pro ověření validace:'
                : 'Sample formats to test validation:'}
            </span>
            {SAMPLE_ADDRESSES.map((sample) => (
              <button
                key={sample.label}
                type="button"
                onClick={() => {
                  setAddress(sample.address);
                  setTouched(true);
                }}
                className="text-slate-300 underline decoration-slate-600 underline-offset-4 hover:text-[#F7931A] hover:decoration-[#F7931A] transition-colors cursor-pointer"
              >
                {sample.label}
              </button>
            ))}
          </div>

          {/* Clear concise legal & educational notice directly under the form */}
          <div className="mt-4 rounded-lg border border-amber-500/25 bg-[#0B0E15] px-4 py-3 text-xs text-slate-400 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
              <span>
                <strong className="text-slate-200">
                  {isCs
                    ? 'Pouze edukativní nástroj bez záruky:'
                    : 'Educational tool without warranty:'}
                </strong>{' '}
                {isCs
                  ? 'Poskytováno „tak jak je“. Vytvořeno metodou vibecoding v Google AI Studio — celý kód byl tvořen AI a nebyl zatím revidován žádným programátorem. Veškerá rizika (včetně zátěže GPU/CPU a spotřeby elektřiny) nese uživatel.'
                  : 'Provided “as-is”. Built via vibecoding in Google AI Studio — all code was AI-generated and has not yet been reviewed by a human programmer. The user assumes all risks (including GPU/CPU wear and electricity costs).'}
              </span>
            </div>
            {onOpenTerms && (
              <button
                type="button"
                onClick={onOpenTerms}
                className="text-amber-300 underline underline-offset-4 hover:text-amber-200 whitespace-nowrap shrink-0 text-left cursor-pointer"
              >
                {isCs ? 'Podmínky a rizika' : 'Terms & Risks'}
              </button>
            )}
          </div>
        </form>

        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="rounded-xl border border-[#1E2534] bg-[#0E121A] p-5">
            <h2 className="text-sm font-semibold text-slate-100">
              {isCs ? '01. Sdílená URL bez opakování' : '01. Shared URL Without Overlap'}
            </h2>
            <p className="mt-2 text-xs text-slate-400 leading-relaxed">
              {isCs
                ? 'Po zadání adresy získáte unikátní odkaz. Otevřete jej na dalším PC nebo mobilu — server každému zařízení přidělí diskrétní náhodné nebo sekvenční bloky klíčů.'
                : 'After entering an address you receive a unique link. Open it on another PC or phone — the server leases distinct random or sequential key blocks per device.'}
            </p>
          </div>

          <div className="rounded-xl border border-[#1E2534] bg-[#0E121A] p-5">
            <h2 className="text-sm font-semibold text-slate-100">
              {isCs ? '02. Podpis v prohlížeči (85 % / 15 %)' : '02. In-Browser Signing (85% / 15%)'}
            </h2>
            <p className="mt-2 text-xs text-slate-400 leading-relaxed">
              {isCs
                ? 'Případný nalezený klíč nikdy neopustí váš prohlížeč. Po odečtení poplatku těžařům se výplata rozdělí 85 % na vaši adresu a 15 % na adresu provozovatele.'
                : 'Any discovered private key never leaves your browser. After deducting miner fees, the net reward is split 85% to your address and 15% to the platform.'}
            </p>
          </div>

          <div className="rounded-xl border border-[#1E2534] bg-[#0E121A] p-5">
            <h2 className="text-sm font-semibold text-slate-100">
              {isCs ? '03. Ochrana proti front-runningu' : '03. Front-Running & RBF Protection'}
            </h2>
            <p className="mt-2 text-xs text-slate-400 leading-relaxed">
              {isCs
                ? 'Podepsaná transakce se neodesílá do veřejného mempoolu, ale přímo do soukromého pool API (MARA Slipstream & Rebar Shield), takže ji nelze odhadnout ani ukrást přes RBF.'
                : 'Signed transactions never enter the public mempool. Instead, they go directly to private pool APIs (MARA Slipstream & Rebar Shield) to prevent RBF hijacking.'}
            </p>
          </div>
        </div>
      </section>

      {/* Interactive Bitcoin Puzzle #1-#160 Reference Directory & Odds Calculator */}
      <PuzzleDirectorySection
        compact
        detectedKeysPerSec={detectedKeysPerSec}
        onOpenFullDirectory={onOpenPuzzles}
        onOpenDocs={onOpenDocs}
      />

      {/* Public Anonymized Leaderboard */}
      <LeaderboardSection compact onOpenFullLeaderboard={onOpenLeaderboard} />

      {/* SEO & Educational Guide: What is Bitcoin Puzzle #71 */}
      <section
        aria-labelledby="puzzle71-explained"
        className="rounded-xl border border-[#222938] bg-[#11151E] p-6 sm:p-8 space-y-6"
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-3">
            <p className="text-xs font-medium tracking-wide text-[#F7931A]">
              {isCs ? 'Kryptografická výzva od roku 2015' : 'Cryptographic Challenge Since 2015'}
            </p>
            <h2 id="puzzle71-explained" className="font-display text-2xl font-semibold text-slate-100">
              {isCs
                ? 'Co je Bitcoin Puzzle #71 a proč se zkoumá?'
                : 'What Is Bitcoin Puzzle #71 and Why Study It?'}
            </h2>
            <p className="text-sm text-slate-400 leading-relaxed">
              {isCs ? (
                <>
                  Bitcoin Puzzle #71 je součástí legendární série 160 bitcoinových adres vytvořených v
                  roce 2015 jako praktická demonstrace síly kryptografie eliptických křivek (
                  <span className="font-mono text-slate-300">secp256k1</span>). Zatímco standardní
                  bitcoinový soukromý klíč využívá plný 256bitový prostor, autor této výzvy záměrně
                  omezil entropii jednotlivých klíčů na <span className="font-mono">1</span> až{' '}
                  <span className="font-mono">160</span> bitů — konkrétně u úrovně #71 přesně do 71bitového
                  intervalu.
                </>
              ) : (
                <>
                  Bitcoin Puzzle #71 belongs to the famous 2015 series of 160 Bitcoin addresses
                  created as a practical demonstration of elliptic-curve cryptography (<span className="font-mono text-slate-300">secp256k1</span>).
                  While standard Bitcoin private keys span the full 256-bit space, the creator
                  deliberately constrained each puzzle’s entropy between <span className="font-mono">1</span> and{' '}
                  <span className="font-mono">160</span> bits — locking level #71 within an exact 71-bit range.
                </>
              )}
            </p>
            <p className="text-sm text-slate-400 leading-relaxed">
              {isCs ? (
                <>
                  Protože veřejný klíč adresy{' '}
                  <span className="font-mono text-slate-200">{PUZZLE_71_ADDRESS}</span> dosud nikdy
                  nebyl zveřejněn v žádné odchozí transakci, nelze u ní přímo použít algoritmy typu
                  Pollardovo Kangaroo na zkrácení výpočtu na druhou odmocninu. Jedinou cestou k ověření
                  hypotézy je generování komprimovaného veřejného klíče pro konkrétní skalár{' '}
                  <span className="font-mono">k</span> a jeho následný převod pomocí{' '}
                  <span className="font-mono">SHA-256</span> a{' '}
                  <span className="font-mono">RIPEMD-160</span> na cílový otisk{' '}
                  <span className="font-mono">Hash160</span>.
                </>
              ) : (
                <>
                  Because the public key of{' '}
                  <span className="font-mono text-slate-200">{PUZZLE_71_ADDRESS}</span> has never been
                  revealed in an outgoing transaction, square-root ECDLP solvers like Pollard’s Kangaroo
                  cannot be applied directly. Checking any candidate requires computing the compressed
                  public key for scalar <span className="font-mono">k</span> and hashing it with{' '}
                  <span className="font-mono">SHA-256</span> +{' '}
                  <span className="font-mono">RIPEMD-160</span> to compare against its target{' '}
                  <span className="font-mono">Hash160</span>.
                </>
              )}
            </p>
          </div>

          <aside className="rounded-xl border border-[#1E2534] bg-[#0B0E15] p-5 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              {isCs ? 'Technické parametry Puzzle #71' : 'Puzzle #71 Technical Specs'}
            </h3>
            <dl className="space-y-2.5 text-xs">
              <div>
                <dt className="text-slate-500">
                  {isCs ? 'Cílová Bitcoin adresa (P2PKH)' : 'Target Bitcoin Address (P2PKH)'}
                </dt>
                <dd className="font-mono text-slate-200 break-all mt-0.5">{PUZZLE_71_ADDRESS}</dd>
              </div>
              <div>
                <dt className="text-slate-500">
                  {isCs ? 'Cílový Hash160 (RIPEMD-160)' : 'Target Hash160 (RIPEMD-160)'}
                </dt>
                <dd className="font-mono text-slate-300 break-all mt-0.5">{PUZZLE_71_HASH160_HEX}</dd>
              </div>
              <div>
                <dt className="text-slate-500">
                  {isCs ? 'Rozsah klíčů (71 bitů)' : 'Key Range (71-bit)'}
                </dt>
                <dd className="font-mono text-slate-200 mt-0.5">
                  0x400000000000000000 → 0x7fffffffffffffffff
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">
                  {isCs ? 'Celkový počet kombinací' : 'Total Keyspace Size'}
                </dt>
                <dd className="font-mono text-slate-200 mt-0.5">
                  {isCs ? '2⁷⁰ (≈ 1,18 × 10²¹ klíčů)' : '2⁷⁰ (≈ 1.18 × 10²¹ keys)'}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">
                  {isCs ? 'Velikost jednoho bloku' : 'Single Work Block Size'}
                </dt>
                <dd className="font-mono text-slate-200 mt-0.5">
                  {isCs ? '2²⁹ = 536 870 912 klíčů' : '2²⁹ = 536,870,912 keys'}
                </dd>
              </div>
            </dl>
          </aside>
        </div>
      </section>

      {/* Step-by-step Architecture */}
      <section aria-labelledby="how-web-works" className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2">
          <div>
            <h2 id="how-web-works" className="font-display text-2xl font-semibold text-slate-100">
              {isCs
                ? 'Jak tento web funguje od spuštění až po podpis transakce'
                : 'How It Works From Launch to Transaction Signing'}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              {isCs
                ? 'Veškeré kryptografické výpočty probíhají lokálně na vašem zařízení — server koordinuje pouze neprohledané bloky.'
                : 'All cryptographic computations run locally on your hardware — the server only coordinates unsearched blocks.'}
            </p>
          </div>
          {onOpenDocs && (
            <button
              type="button"
              onClick={onOpenDocs}
              className="text-xs font-medium text-[#F7931A] hover:underline whitespace-nowrap shrink-0 text-left cursor-pointer"
            >
              {isCs ? 'Podrobná technická dokumentace →' : 'Full technical documentation →'}
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <article className="rounded-xl border border-[#1E2534] bg-[#0E121A] p-5 space-y-2.5">
            <div className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#F7931A]/15 text-[#F7931A]">
              <Cpu className="h-4 w-4" aria-hidden="true" />
            </div>
            <h3 className="text-sm font-semibold text-slate-100">
              {isCs ? 'WebGPU výpočetní jádro v prohlížeči' : 'Browser WebGPU Compute Engine'}
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              {isCs
                ? 'Po spuštění aplikace otestuje WebGPU adaptér na testovacím vektoru. Pomocí Montgomeryho dávkové inverze a symetrických kroků na křivce secp256k1 kontroluje miliony klíčů za sekundu na grafické kartě (případně v CPU WebWorkerech).'
                : 'On startup, the app verifies your WebGPU adapter against a known vector. Using Montgomery batch inversion and symmetric secp256k1 steps, it scans millions of keys/sec on your GPU (or multi-thread CPU WebWorkers).'}
            </p>
          </article>

          <article className="rounded-xl border border-[#1E2534] bg-[#0E121A] p-5 space-y-2.5">
            <div className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#F7931A]/15 text-[#F7931A]">
              <KeyRound className="h-4 w-4" aria-hidden="true" />
            </div>
            <h3 className="text-sm font-semibold text-slate-100">
              {isCs ? 'Koordinace bloků, Pauza a PoW ochrana' : 'Block Coordination, Pause & PoW Proof'}
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              {isCs ? (
                <>
                  Bloky po 2²⁹ klíčích si lze nechat přidělovat náhodně nebo sekvenčně od libovolného
                  procenta rozsahu. Při stisknutí <strong>Pauzy</strong> se blok drží v prohlížeči a
                  každé dokončení bloku ověřuje server pomocí kryptografických PoW důkazů.
                </>
              ) : (
                <>
                  Leased 2²⁹ key blocks can be assigned randomly or sequentially from any percentage
                  offset. Pressing <strong>Pause</strong> holds the block via keep-alive heartbeats,
                  and block completions require verified cryptographic PoW shares.
                </>
              )}
            </p>
          </article>

          <article className="rounded-xl border border-[#1E2534] bg-[#0E121A] p-5 space-y-2.5">
            <div className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#F7931A]/15 text-[#F7931A]">
              <Lock className="h-4 w-4" aria-hidden="true" />
            </div>
            <h3 className="text-sm font-semibold text-slate-100">
              {isCs ? 'Lokální podpis a ochrana proti krádeži' : 'Local Signing & Theft Prevention'}
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              {isCs
                ? 'Pokud prohlížeč nalezne shodu, sestaví a podepíše raw transakci lokálně (85 % uživatel / 15 % provozovatel) a odešle ji přes soukromé pool rozhraní MARA Slipstream a Rebar Shield mimo veřejný mempool.'
                : 'If a match is found, your browser signs the raw payout transaction locally (85% user / 15% platform) and submits it exclusively to MARA Slipstream and Rebar Shield private pools outside the public mempool.'}
            </p>
          </article>
        </div>
      </section>

      {/* FAQ Section matching Schema.org JSON-LD */}
      <section
        aria-labelledby="faq-heading"
        className="rounded-xl border border-[#222938] bg-[#11151E] p-6 sm:p-8 space-y-5"
      >
        <h2 id="faq-heading" className="font-display text-xl sm:text-2xl font-semibold text-slate-100">
          {isCs ? 'Často kladené otázky (FAQ)' : 'Frequently Asked Questions (FAQ)'}
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs sm:text-sm">
          <div className="rounded-lg border border-[#1E2534] bg-[#0B0E15] p-4 space-y-1.5">
            <h3 className="font-semibold text-slate-100">
              {isCs
                ? 'Potřebuji něco stahovat nebo instalovat do počítače?'
                : 'Do I need to download or install any software?'}
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              {isCs
                ? 'Ne. Vše běží přímo v moderním prohlížeči (Chrome, Edge apod.) s podporou WebGPU. Pokud zařízení WebGPU nemá, automaticky se použijí vícevláknoví CPU WebWorkeři.'
                : 'No. Everything runs inside modern WebGPU-capable browsers (Chrome, Edge, etc.). If WebGPU is unavailable on your device, multi-threaded CPU WebWorkers activate automatically.'}
            </p>
          </div>

          <div className="rounded-lg border border-[#1E2534] bg-[#0B0E15] p-4 space-y-1.5">
            <h3 className="font-semibold text-slate-100">
              {isCs
                ? 'Existuje nějaká záruka, že klíč najdu nebo něco vydělám?'
                : 'Is there any guarantee of finding the key or making a profit?'}
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              {isCs
                ? 'Ne. Projekt je výhradně edukativní a výzkumný. Rozsah 2⁷⁰ klíčů je obrovský a není žádná garance úspěchu, návratnosti nákladů na elektřinu ani dostupnosti zůstatku na cílové adrese.'
                : 'No. This project is strictly educational and experimental. The 2⁷⁰ keyspace is vast, and there is zero guarantee of finding a key, covering electricity costs, or target balance availability.'}
            </p>
          </div>

          <div className="rounded-lg border border-[#1E2534] bg-[#0B0E15] p-4 space-y-1.5">
            <h3 className="font-semibold text-slate-100">
              {isCs
                ? 'Co se stane s rozpracovaným blokem při pauze nebo pomalém CPU?'
                : 'What happens to my active block when paused or on a slow CPU?'}
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              {isCs
                ? 'Při aktivním výpočtu se stav ukládá každých 2,5 s, takže ani velmi pomalý výpočet blok neztratí. V režimu Pauza prohlížeč drží blok pomocí keep-alive signálu, dokud zůstáváte na stránce.'
                : 'While running, progress checkpoints save every 2.5 seconds so even slow devices never lose progress. While Paused, the browser holds your lease via keep-alive signals as long as the tab stays open.'}
            </p>
          </div>

          <div className="rounded-lg border border-[#1E2534] bg-[#0B0E15] p-4 space-y-1.5">
            <h3 className="font-semibold text-slate-100">
              {isCs
                ? 'Jaké riziko na sebe uživatel přebírá?'
                : 'What risks does the user assume?'}
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              {isCs
                ? 'Uživatel využívá web na vlastní riziko — nese odpovědnost za opotřebení či přehřátí hardwaru, náklady na elektřinu, správnost zadané adresy i případné výpadky sítí a třetích stran.'
                : 'You use this site at your own risk — including hardware wear or thermal throttling, electricity costs, accuracy of the payout address you enter, and third-party network availability.'}
            </p>
          </div>

          <div className="rounded-lg border border-[#1E2534] bg-[#0B0E15] p-4 space-y-1.5">
            <h3 className="font-semibold text-slate-100">
              {isCs
                ? 'Kdo vytvořil Bitcoin Puzzle a kolik BTC je ve hře?'
                : 'Who created the Bitcoin Puzzle and how much BTC is locked?'}
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              {isCs ? (
                <>
                  Výzvu zveřejnil v lednu 2015 anonymní autor (přezdívka{' '}
                  <span className="font-mono">saatoshi_rising</span>). Série dnes zahrnuje 160
                  adres s celkovými odměnami 988,498 BTC — 83 úrovní již bylo vyřešeno a v 77
                  nevyřešených adresách stále zbývá přesně 903 BTC (z toho 7,10 BTC v #71).
                </>
              ) : (
                <>
                  Launched in January 2015 by anonymous creator{' '}
                  <span className="font-mono">saatoshi_rising</span>, the series totals 160 addresses
                  worth 988.498 BTC — 83 levels are solved (85.498 BTC) and 903 BTC remain across
                  77 unsolved puzzles (including 7.10 BTC in #71).
                </>
              )}
            </p>
          </div>

          <div className="rounded-lg border border-[#1E2534] bg-[#0B0E15] p-4 space-y-1.5">
            <h3 className="font-semibold text-slate-100">
              {isCs
                ? 'Proč u Puzzle #71 nejde použít Pollardovo Kangaroo jako u #140?'
                : 'Why can’t Pollard’s Kangaroo solve Puzzle #71 like #140?'}
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              {isCs ? (
                <>
                  U adresy <span className="font-mono">{PUZZLE_71_ADDRESS}</span> dosud nebyl na
                  blockchainu zveřejněn veřejný klíč, známe pouze její 160bitový otisk Hash160.
                  Algoritmy typu Kangaroo (použité např. u #130 a #135) vyžadují známý veřejný klíč —
                  pro #71 je tedy nutné počítat Hash160 pro jednotlivé kandidáty.
                </>
              ) : (
                <>
                  Address <span className="font-mono">{PUZZLE_71_ADDRESS}</span> has never spent an
                  output, so only its 160-bit Hash160 is public. Kangaroo algorithms (used on #130
                  and #135) require an exposed EC public key — for #71 each key must be hashed via Hash160.
                </>
              )}
            </p>
          </div>
        </div>
      </section>

      {/* Prominent Educational & Legal Disclaimer Summary */}
      <section
        aria-labelledby="legal-summary-heading"
        className="rounded-xl border border-amber-500/30 bg-[#12100E] p-6 space-y-3"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h2 id="legal-summary-heading" className="text-sm font-semibold text-amber-300">
            {isCs
              ? 'Právní prohlášení, edukativní charakter a vyloučení odpovědnosti'
              : 'Legal Notice, Educational Scope & Liability Disclaimer'}
          </h2>
          {onOpenTerms && (
            <button
              type="button"
              onClick={onOpenTerms}
              className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-3.5 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/25 transition-colors whitespace-nowrap shrink-0 self-start sm:self-auto cursor-pointer"
            >
              {isCs ? 'Úplné znění podmínek užití →' : 'Read full Terms of Use →'}
            </button>
          )}
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          {isCs
            ? 'Tato webová aplikace slouží výhradně pro vzdělávací a výzkumné účely v oblasti kryptografie a technologie Bitcoin. Projekt byl vytvořen metodou vibecoding pomocí aplikace Google AI Studio — celý zdrojový kód byl tvořen AI a nebyl zatím revidován žádným programátorem. Služba je poskytována „tak jak je“ (as-is) a „jak je dostupná“ bez jakýchkoli záruk či garance úspěchu. Provozovatel nenese žádnou odpovědnost za případné chyby kódu, škody na hardwaru, náklady na energii, ztrátu dat či průběh transakcí v síti Bitcoin. Uživatel používáním služby přebírá veškerá rizika v plném rozsahu.'
            : 'This web application is provided strictly for educational and cryptographic research purposes on an “as-is” and “as-available” basis without warranties or guarantees of any kind. It was built using the vibecoding workflow in Google AI Studio — the entire codebase was generated by AI and has not yet been reviewed by a human programmer. The operator accepts no liability for code bugs, hardware damage, energy costs, data loss, or Bitcoin network execution. By using this tool, you assume all risks in full.'}
        </p>
      </section>

      <div className="border-t border-[#19202D] pt-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-slate-500 font-mono">
        <span>
          {isCs ? 'Cíl:' : 'Target:'} {PUZZLE_71_ADDRESS}
        </span>
        <span>
          {isCs
            ? 'Rozdělení čisté odměny: 85 % uživatel / 15 % zbytek'
            : 'Net payout split: 85% user / 15% platform'}
        </span>
      </div>
    </div>
  );
}
