import { AlertTriangle } from 'lucide-react';
import { useLocale } from '../i18n/LocaleContext.tsx';
import { PUZZLE_71_ADDRESS, PUZZLE_71_HASH160_HEX } from '../shared/puzzle71.ts';

interface HowItWorksProps {
  onOpenTerms?: () => void;
}

export function HowItWorks({ onOpenTerms }: HowItWorksProps) {
  const { locale } = useLocale();
  const isCs = locale === 'cs';

  return (
    <div className="mx-auto max-w-[960px] px-6 py-8 space-y-6">
      <article className="rounded-xl border border-[#222938] bg-[#11151E] p-6 sm:p-8 space-y-6">
        <div>
          <p className="text-xs font-medium tracking-wide text-[#F7931A]">
            {isCs
              ? 'Technická a vzdělávací dokumentace · Bitcoin Puzzle #71'
              : 'Technical & Educational Documentation · Bitcoin Puzzle #71'}
          </p>
          <h1 className="mt-2 font-display text-2xl sm:text-3xl font-semibold text-slate-100">
            {isCs
              ? 'Co je Bitcoin Puzzle #71 a jak funguje Puzzle71 WebGPU'
              : 'What Is Bitcoin Puzzle #71 & How Puzzle71 WebGPU Works'}
          </h1>
          <p className="mt-2 text-sm text-slate-400 leading-relaxed">
            {isCs
              ? 'Podrobný průvodce historií kryptografické výzvy Bitcoin Puzzle, architekturou paralelního WebGPU výpočtu v prohlížeči, koordinací bloků bez opakování a obranou proti krádeži transakce ve veřejném mempoolu.'
              : 'A detailed guide to the history of the Bitcoin Puzzle cryptographic challenge, in-browser parallel WebGPU compute architecture, non-overlapping block coordination, and protection against public mempool front-running.'}
          </p>
        </div>

        <div className="space-y-6 border-t border-[#1D2432] pt-6 text-sm text-slate-300 leading-relaxed">
          <section className="space-y-2">
            <h2 className="text-base font-semibold text-slate-100">
              {isCs
                ? '1. Co je Bitcoin Puzzle #71 a odkud pochází?'
                : '1. What Is Bitcoin Puzzle #71 & Where Did It Come From?'}
            </h2>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
              {isCs ? (
                <>
                  V roce 2015 vytvořil neznámý autor na bitcoinovém blockchainu sérii kryptografických
                  výzev (tzv. <em>Bitcoin Puzzle Transaction</em>), v níž uzamkl postupně rostoucí
                  částky BTC na adresy s uměle omezeným počtem bitů soukromého klíče — od 1bitového
                  klíče #1 až po 160bitové adresy. Účelem bylo názorně demonstrovat exponenciální
                  nárůst obtížnosti hrubé síly (<em>brute-force</em>) u eliptické křivky{' '}
                  <span className="font-mono text-slate-300">secp256k1</span>.
                </>
              ) : (
                <>
                  In 2015, an anonymous creator published a series of cryptographic challenges on the
                  Bitcoin blockchain (known as the <em>Bitcoin Puzzle Transaction</em>), locking
                  progressively larger BTC rewards under private keys constrained to specific bit
                  lengths — from 1-bit puzzle #1 up to 160-bit addresses. The goal was to
                  demonstrate the exponential scaling of brute-force difficulty across the{' '}
                  <span className="font-mono text-slate-300">secp256k1</span> elliptic curve.
                </>
              )}
            </p>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
              {isCs ? (
                <>
                  <strong>Puzzle #71</strong> představuje nejnižší dosud nevyřešenou adresu bez
                  odhaleného veřejného klíče. Její soukromý klíč leží v přesném intervalu{' '}
                  <span className="font-mono text-slate-200">2⁷⁰</span> až{' '}
                  <span className="font-mono text-slate-200">2⁷¹ − 1</span> (hexadecimálně{' '}
                  <span className="font-mono text-slate-300">0x400000000000000000</span> až{' '}
                  <span className="font-mono text-slate-300">0x7fffffffffffffffff</span>), což
                  znamená přesně{' '}
                  <span className="font-mono text-slate-200">1 180 591 620 717 411 303 424</span>{' '}
                  možných soukromých klíčů. Cílová adresa{' '}
                  <span className="font-mono text-slate-200">{PUZZLE_71_ADDRESS}</span> typu Legacy
                  P2PKH nikdy neutratila jediný výstup, takže z blockchainu známe pouze její{' '}
                  <span className="font-mono text-slate-300">Hash160</span> (
                  <span className="font-mono text-slate-300">{PUZZLE_71_HASH160_HEX}</span>).
                </>
              ) : (
                <>
                  <strong>Puzzle #71</strong> is the lowest unsolved address whose public key has not
                  yet been revealed. Its private key lies strictly between{' '}
                  <span className="font-mono text-slate-200">2⁷⁰</span> and{' '}
                  <span className="font-mono text-slate-200">2⁷¹ − 1</span> (hexadecimal{' '}
                  <span className="font-mono text-slate-300">0x400000000000000000</span> to{' '}
                  <span className="font-mono text-slate-300">0x7fffffffffffffffff</span>),
                  comprising exactly{' '}
                  <span className="font-mono text-slate-200">1,180,591,620,717,411,303,424</span>{' '}
                  possible private keys. Target Legacy P2PKH address{' '}
                  <span className="font-mono text-slate-200">{PUZZLE_71_ADDRESS}</span> has never
                  spent an output, meaning only its{' '}
                  <span className="font-mono text-slate-300">Hash160</span> (
                  <span className="font-mono text-slate-300">{PUZZLE_71_HASH160_HEX}</span>) is
                  publicly known on-chain.
                </>
              )}
            </p>
          </section>

          <section className="space-y-2 border-t border-[#1D2432] pt-5">
            <h2 className="text-base font-semibold text-slate-100">
              {isCs
                ? '2. WebGPU Compute Shader (secp256k1 + SHA-256 + RIPEMD-160)'
                : '2. WebGPU Compute Shader (secp256k1 + SHA-256 + RIPEMD-160)'}
            </h2>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
              {isCs ? (
                <>
                  Namísto nutnosti instalovat nativní CUDA/OpenCL programy využívá tato webová
                  aplikace moderní rozhraní <strong>WebGPU</strong> přímo v prohlížeči. Výpočetní
                  shadery v jazyce WGSL spouštějí tisíce paralelních vláken na grafické kartě.
                  Každé vlákno využívá předpočítané tabulky násobků generátoru{' '}
                  <span className="font-mono">G</span>, symetrické sčítání bodů (
                  <span className="font-mono">P ± k·G</span>) a Montgomeryho dávkovou modulární
                  inverzi, takže na jedno drahé dělení v konečném tělese připadá velké množství
                  zkontrolovaných klíčů.
                </>
              ) : (
                <>
                  Instead of requiring native CUDA or OpenCL binaries, this web application runs{' '}
                  <strong>WebGPU</strong> directly in your browser. WGSL compute shaders launch
                  thousands of parallel GPU threads, combining precomputed generator{' '}
                  <span className="font-mono">G</span> lookup tables, symmetric point addition (
                  <span className="font-mono">P ± k·G</span>), and Montgomery batch modular
                  inversion to amortize finite-field division across large key batches.
                </>
              )}
            </p>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
              {isCs ? (
                <>
                  Z výsledných souřadnic komprimovaného veřejného klíče se v témže shaderu okamžitě
                  počítá <span className="font-mono">SHA-256</span> a{' '}
                  <span className="font-mono">RIPEMD-160</span>. Před ostrým skenováním vždy
                  proběhne kryptografický selftest na známém testovacím klíči, který ověří 100%
                  přesnost GPU či záložního CPU jádra.
                </>
              ) : (
                <>
                  From the resulting compressed public key coordinates, the same shader computes{' '}
                  <span className="font-mono">SHA-256</span> and{' '}
                  <span className="font-mono">RIPEMD-160</span> inline. Before scanning begins, a
                  cryptographic self-test runs against a known reference key to guarantee 100%
                  accuracy on both GPU and fallback CPU cores.
                </>
              )}
            </p>
          </section>

          <section className="space-y-2 border-t border-[#1D2432] pt-5">
            <h2 className="text-base font-semibold text-slate-100">
              {isCs
                ? '3. Unikátní bloky (2²⁹), sekvenční/náhodný výběr, Pauza a ochrana PoW'
                : '3. Unique 2²⁹ Blocks, Sequential/Random Allocation, Pause & PoW Integrity'}
            </h2>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
              {isCs ? (
                <>
                  Celý 71bitový prostor je rozdělen na <span className="font-mono">2⁴¹</span>{' '}
                  jednotných bloků o velikosti <span className="font-mono">2²⁹</span> (
                  <span className="font-mono">536 870 912</span> klíčů — přibližně 3–5 minut výpočtu
                  na běžné GPU při rychlosti kolem 2–3 MKeys/s). Pro výkonné grafické karty (nad 5
                  MKeys/s) server automaticky přiděluje v jednom požadavku souvislé dávky{' '}
                  <span className="font-mono">2, 4 až 8</span> navazujících bloků najednou, takže
                  mezi bloky nedochází k žádným síťovým prostojům a mřížka bloků zůstává čistá bez
                  drobení. Uživatel si může vybrat mezi <strong>náhodným přidělováním</strong>{' '}
                  napříč rozsahem a <strong>sekvenčním postupem</strong> od libovolného procenta
                  rozsahu (0 % až 99,9 %).
                </>
              ) : (
                <>
                  The entire 71-bit keyspace is divided into <span className="font-mono">2⁴¹</span>{' '}
                  uniform <span className="font-mono">2²⁹</span> blocks (
                  <span className="font-mono">536,870,912</span> keys — roughly 3–5 minutes on a
                  typical GPU at 2–3 MKeys/s). For faster GPUs (above 5 MKeys/s), the server leases
                  contiguous batches of <span className="font-mono">2, 4, or 8</span> consecutive
                  blocks per request so there are zero network stalls between blocks and minimal
                  keyspace fragmentation. You can choose between <strong>random allocation</strong>{' '}
                  across the range or <strong>sequential scanning</strong> starting at any percentage
                  (0% to 99.9%).
                </>
              )}
            </p>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
              {isCs ? (
                <>
                  Přes unikátní URL můžete připojit libovolný počet vlastních zařízení bez rizika
                  duplicitní práce. Pokud stisknete tlačítko <strong>Pauza</strong> a zůstanete v
                  prohlížeči, aplikace udržuje rozpracovaný blok i navazující frontu v dávce aktivní
                  pomocí pravidelného keep-alive signálu. Uzavření každého{' '}
                  <span className="font-mono">2²⁹</span> bloku navíc vyžaduje serverové ověření
                  kryptografických <em>Proof-of-Work</em> podílů (
                  <span className="font-mono">Hash160</span> začínající na{' '}
                  <span className="font-mono">000000</span>), takže žádný uživatel nemůže falšovat
                  průběh ani zneužívat databázi.
                </>
              ) : (
                <>
                  Using your unique session URL, you can connect any number of your own devices with
                  zero duplicate work. Clicking <strong>Pause</strong> while keeping the browser tab
                  open sends periodic keep-alive heartbeats to hold your leased block and batch queue.
                  Completing each <span className="font-mono">2²⁹</span> block requires server-side
                  verification of cryptographic <em>Proof-of-Work</em> shares (keys whose{' '}
                  <span className="font-mono">Hash160</span> starts with{' '}
                  <span className="font-mono">000000</span>), preventing progress spoofing or
                  database abuse.
                </>
              )}
            </p>
          </section>

          <section className="space-y-2 border-t border-[#1D2432] pt-5">
            <h2 className="text-base font-semibold text-slate-100">
              {isCs
                ? '4. Proč se transakce nesmí poslat do veřejného mempoolu (ochrana proti RBF)'
                : '4. Why Transactions Must Never Enter the Public Mempool (RBF Protection)'}
            </h2>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
              {isCs ? (
                <>
                  U adresy <span className="font-mono text-slate-200">{PUZZLE_71_ADDRESS}</span>{' '}
                  zatím nebyl na blockchainu odhalen veřejný klíč. Jakmile by se však výplatní
                  transakce objevila ve veřejném mempoolu, automatizovaní boti by z podpisu přečetli
                  veřejný klíč, pomocí Pollardova algoritmu (Kangaroo) během několika sekund
                  dopočítali 71bitový privátní klíč a nahradili transakci vlastní s vyšším poplatkem
                  (útok <em>front-running / RBF</em>, ke kterému došlo např. u puzzle #66 a #67).
                  Proto se transakce podepíše výhradně lokálně v prohlížeči a odešle přímo do
                  privátních těžebních poolů (MARA Slipstream a Rebar Shield), které ji nešíří do
                  veřejného mempoolu.
                </>
              ) : (
                <>
                  The public key for{' '}
                  <span className="font-mono text-slate-200">{PUZZLE_71_ADDRESS}</span> has not yet
                  been exposed on the Bitcoin blockchain. If a spending transaction entered the
                  public mempool, automated bots would immediately extract the public key from its
                  signature, compute the 71-bit private key in seconds via Pollard&apos;s Kangaroo,
                  and replace the transaction with a higher-fee sweep (an{' '}
                  <em>RBF front-running</em> attack, as seen on Puzzle #66 and #69). Therefore, the
                  payout transaction is signed locally in your browser and submitted directly to
                  private mining pools (MARA Slipstream and Rebar Shield) that bypass the public
                  mempool.
                </>
              )}
            </p>
          </section>

          <section className="space-y-2 border-t border-[#1D2432] pt-5">
            <h2 className="text-base font-semibold text-slate-100">
              {isCs
                ? '5. Podpora všech bitcoinových adres a dělení 85 % / 15 %'
                : '5. Full Bitcoin Address Support & 85% / 15% Payout Split'}
            </h2>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
              {isCs ? (
                <>
                  Validátor podporuje Legacy P2PKH (<span className="font-mono">1…</span>), P2SH (
                  <span className="font-mono">3…</span>), SegWit v0 Bech32 P2WPKH/P2WSH (
                  <span className="font-mono">bc1q…</span>), Taproot v1 Bech32m (
                  <span className="font-mono">bc1p…</span>) i budoucí witness verze v2–v16. Po
                  odečtení prioritního těžebního poplatku je ve výstupu podepsané transakce
                  připraveno rozdělení 85 % pro zadanou adresu uživatele a zbývajících 15 % na
                  provozní adresu platformy.
                </>
              ) : (
                <>
                  The address validator supports Legacy P2PKH (<span className="font-mono">1…</span>
                  ), P2SH (<span className="font-mono">3…</span>), SegWit v0 Bech32 P2WPKH/P2WSH (
                  <span className="font-mono">bc1q…</span>), Taproot v1 Bech32m (
                  <span className="font-mono">bc1p…</span>), and future witness versions v2–v16.
                  After deducting the priority mining fee, the signed transaction outputs distribute
                  85% to your configured payout address and 15% to the platform maintenance address.
                </>
              )}
            </p>
          </section>
        </div>

        <div className="rounded-lg border border-amber-500/35 bg-amber-950/20 p-4 text-xs text-amber-200/90 leading-relaxed flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
            <p>
              {isCs ? (
                <>
                  <strong>Pouze edukativní nástroj bez záruky:</strong> Aplikace je poskytována
                  „tak jak je“ bez záruky nálezu klíče či finančního zisku. Používáním přebíráte
                  veškerá hardwarová, energetická i síťová rizika.
                </>
              ) : (
                <>
                  <strong>Educational Tool With No Warranty:</strong> This application is provided
                  &ldquo;as-is&rdquo; with zero guarantee of finding any private key or financial
                  return. By using it, you assume all hardware, electricity, and network risks.
                </>
              )}
            </p>
          </div>
          {onOpenTerms && (
            <button
              type="button"
              onClick={onOpenTerms}
              className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-3.5 py-2 text-xs font-medium text-amber-200 hover:bg-amber-500/25 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isCs ? 'Přečíst podmínky a rizika' : 'Read Terms & Risks'}
            </button>
          )}
        </div>
      </article>
    </div>
  );
}
