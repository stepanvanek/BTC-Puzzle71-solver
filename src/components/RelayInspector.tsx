import { CheckCircle2, Play, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useLocale } from '../i18n/LocaleContext.tsx';
import { formatLocalizedNumber } from '../i18n/locale.ts';
import { formatBtcFromSats } from '../shared/btcAddress.ts';
import { buildAndSignPuzzle71Tx, type SignedPuzzleTxResult } from '../shared/btcTx.ts';
import {
  ADMIN_PAYOUT_ADDRESS,
  DEFAULT_FEE_RATE_SAT_VB,
  DEFAULT_PUZZLE_71_BALANCE_SATS,
} from '../shared/puzzle71.ts';
import type { PrivateBroadcastResult, PuzzleNetworkInfo, SessionData } from '../types/api.ts';

interface RelayInspectorProps {
  sessionData: SessionData | null;
  networkInfo: PuzzleNetworkInfo | null;
}

export function RelayInspector({ sessionData, networkInfo }: RelayInspectorProps) {
  const { locale } = useLocale();
  const isCs = locale === 'cs';
  const [signedResult, setSignedResult] = useState<SignedPuzzleTxResult | null>(null);
  const [dryRunResult, setDryRunResult] = useState<PrivateBroadcastResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const userAddress =
    sessionData?.session.btcAddress ?? 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

  const handleRunDrySigningTest = async () => {
    setError(null);
    setIsTesting(true);
    try {
      const deterministicTestKey = 0x4123456789abcdef01n;
      const feeRate = networkInfo?.slipstreamFeeRateSatVb ?? DEFAULT_FEE_RATE_SAT_VB * 2;
      const utxos =
        networkInfo?.utxos && networkInfo.utxos.length > 0
          ? networkInfo.utxos.map((u) => ({
              txid: u.txid,
              vout: u.vout,
              valueSats: BigInt(u.valueSats),
            }))
          : [
              {
                txid: networkInfo?.utxo.txid ?? 'a'.repeat(64),
                vout: networkInfo?.utxo.vout ?? 0,
                valueSats: BigInt(
                  networkInfo?.totalBalanceSats ?? DEFAULT_PUZZLE_71_BALANCE_SATS.toString(),
                ),
              },
            ];

      const signed = buildAndSignPuzzle71Tx({
        privateKey: deterministicTestKey,
        utxos,
        userAddress,
        adminAddress: ADMIN_PAYOUT_ADDRESS,
        feeRateSatPerVb: feeRate,
      });

      setSignedResult(signed);

      const res = await fetch('/api/broadcast-private', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawTxHex: signed.txHex,
          dryRun: true,
          locale,
          shareToken: sessionData?.session.shareToken ?? '',
          txid: signed.txid,
          userSats: signed.userSats.toString(),
          adminSats: signed.adminSats.toString(),
          feeSats: signed.feeSats.toString(),
        }),
      });

      const raw = await res.text();
      let payload: PrivateBroadcastResult & { error?: string };
      try {
        payload = JSON.parse(raw) as PrivateBroadcastResult & { error?: string };
      } catch {
        throw new Error(
          isCs
            ? 'Server vrátil neplatnou odpověď při ověření privátního relaye.'
            : 'The server returned an invalid response while verifying the private relay.',
        );
      }
      if (!res.ok) {
        throw new Error(
          payload.error ||
            (isCs
              ? 'Chyba při ověření privátního relaye.'
              : 'Private relay verification failed.'),
        );
      }
      setDryRunResult(payload);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : isCs
            ? 'Testovací podpis selhal.'
            : 'Dry-run signing test failed.',
      );
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1040px] px-6 py-8 space-y-6">
      <section className="rounded-xl border border-[#222938] bg-[#11151E] p-6 sm:p-8">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2 max-w-2xl">
            <div className="flex items-center gap-2 text-xs font-medium text-[#F7931A]">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              <span>
                {isCs
                  ? 'Ochrana před front-runningem · Podpis v prohlížeči + Privátní pool API'
                  : 'Front-Running Protection · Local Browser Signing + Private Pool API'}
              </span>
            </div>
            <h1 className="font-display text-2xl font-semibold text-slate-100">
              {isCs
                ? 'Ověření podpisu transakce 85 % / 15 % a privátních poolů'
                : 'Verify 85% / 15% Transaction Signing & Private Pool Relays'}
            </h1>
            <p className="text-xs text-slate-400 leading-relaxed">
              {isCs ? (
                <>
                  Zde si můžete nanečisto (Dry-Run na testovacím klíči, bez odeslání do mainnetu)
                  ověřit, že váš prohlížeč dokáže správně sestavit a podepsat výplatní transakci (85
                  % pro vaši adresu{' '}
                  <span className="font-mono text-slate-300 break-all">{userAddress}</span> a 15 %
                  zbytek pro provozovatele) a předat ji do MARA Slipstream a Rebar Shield mimo
                  veřejný mempool.
                </>
              ) : (
                <>
                  Run a safe Dry-Run test using a deterministic test key (never broadcast to Bitcoin
                  mainnet) to verify that your browser can build and sign the payout transaction (85%
                  to your address{' '}
                  <span className="font-mono text-slate-300 break-all">{userAddress}</span> and the
                  15% remainder to the platform fee address) and submit it to MARA Slipstream and
                  Rebar Shield outside the public mempool.
                </>
              )}
            </p>
          </div>

          <button
            type="button"
            onClick={handleRunDrySigningTest}
            disabled={isTesting}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#F7931A] px-5 py-3 text-xs font-semibold text-[#090B10] hover:bg-[#ff9f2e] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            <span>
              {isTesting
                ? isCs
                  ? 'Ověřuji podpis...'
                  : 'Verifying signature...'
                : isCs
                  ? 'Spustit test podpisu (Dry-Run)'
                  : 'Run Signing Test (Dry-Run)'}
            </span>
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-5 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-xs text-red-300"
          >
            {error}
          </div>
        )}

        {signedResult && (
          <div className="mt-7 space-y-5 border-t border-[#1D2432] pt-6">
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-400">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              <span>
                {isCs
                  ? 'Testovací ECDSA podpis (SIGHASH_ALL, low-S) vytvořen a ověřen přímo v prohlížeči'
                  : 'Test ECDSA signature (SIGHASH_ALL, low-S) created and verified directly in browser'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
              <div>
                <p className="text-slate-400">{isCs ? 'Vstupní UTXO' : 'Input UTXO'}</p>
                <p className="mt-1 font-mono tabular-nums text-slate-100">
                  {formatBtcFromSats(signedResult.totalInputSats)}
                </p>
              </div>
              <div>
                <p className="text-slate-400">
                  {isCs ? 'Poplatek těžařům (před dělením)' : 'Miner Fee (before split)'}
                </p>
                <p className="mt-1 font-mono tabular-nums text-slate-100">
                  {formatLocalizedNumber(Number(signedResult.feeSats), locale)} sat (
                  {signedResult.inputCount} {isCs ? 'vstupů' : 'inputs'} · {signedResult.vbytes} vB)
                </p>
              </div>
              <div>
                <p className="text-slate-400">
                  {isCs ? 'Výstup uživatel (85 %)' : 'User Output (85%)'}
                </p>
                <p className="mt-1 font-mono tabular-nums text-emerald-400">
                  {formatBtcFromSats(signedResult.userSats)}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">{signedResult.userAddressType}</p>
              </div>
              <div>
                <p className="text-slate-400">
                  {isCs ? 'Výstup admin (15 %)' : 'Admin Output (15%)'}
                </p>
                <p className="mt-1 font-mono text-slate-200">{isCs ? 'zbytek' : 'remainder'}</p>
              </div>
            </div>

            <div>
              <p className="text-xs text-slate-400 mb-1.5">
                {isCs
                  ? 'Testovací TXID (Dry-Run) a surová podepsaná hex transakce:'
                  : 'Test TXID (Dry-Run) and raw signed hex transaction:'}
              </p>
              <div className="rounded-lg border border-[#1E2534] bg-[#0B0E15] p-3 font-mono text-[11px] text-slate-300 break-all space-y-1.5">
                <div>
                  <span className="text-slate-500">TXID: </span>
                  {signedResult.txid}
                </div>
                <div>
                  <span className="text-slate-500">RAW HEX: </span>
                  {signedResult.txHex}
                </div>
              </div>
            </div>

            {dryRunResult && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-300">
                  {isCs
                    ? 'Stav připravenosti privátních poolů (mimo veřejný mempool):'
                    : 'Private mining pool readiness (off public mempool):'}
                </p>
                <div className="divide-y divide-[#1D2432] rounded-lg border border-[#1E2534] bg-[#0B0E15]">
                  {dryRunResult.receipts.map((r) => (
                    <div
                      key={r.provider}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-3 text-xs"
                    >
                      <div>
                        <p className="font-medium text-slate-200">{r.provider}</p>
                        <p className="font-mono text-[11px] text-slate-500">{r.endpoint}</p>
                      </div>
                      <div className="text-emerald-400 text-right">{r.responseText}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
