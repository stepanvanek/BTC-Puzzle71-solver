import { CheckCircle2, Copy, FlaskConical, X } from 'lucide-react';
import { useState } from 'react';
import { useLocale } from '../i18n/LocaleContext.tsx';
import { formatBtcFromSats } from '../shared/btcAddress.ts';
import type { SignedPuzzleTxResult } from '../shared/btcTx.ts';
import type { PrivateBroadcastResult } from '../types/api.ts';

interface ClaimBannerProps {
  foundKeyHex: string;
  signedTx: SignedPuzzleTxResult;
  broadcastResult: PrivateBroadcastResult | null;
  isDemo?: boolean;
  puzzleNumber?: number;
  inline?: boolean;
  onDismiss?: () => void;
}

export function ClaimBanner({
  foundKeyHex,
  signedTx,
  broadcastResult,
  isDemo = false,
  puzzleNumber = 71,
  inline = false,
  onDismiss,
}: ClaimBannerProps) {
  const { locale } = useLocale();
  const isCs = locale === 'cs';
  const [copiedHex, setCopiedHex] = useState(false);

  const handleCopyHex = async () => {
    try {
      await navigator.clipboard.writeText(signedTx.txHex);
      setCopiedHex(true);
      setTimeout(() => setCopiedHex(false), 2000);
    } catch {
      // ignore
    }
  };

  const card = (
    <div
      role="alert"
      className="rounded-xl border border-emerald-500/40 bg-emerald-950/30 p-5 sm:p-6 space-y-4"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 text-emerald-300">
          {isDemo ? (
            <FlaskConical className="h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
          )}
          <h2 className="font-display text-lg font-semibold">
            {isDemo
              ? isCs
                ? `DEMO NÁLEZ (Puzzle #${puzzleNumber}): Klíč vypočítán a transakce podepsána v režimu Dry-Run`
                : `DEMO MATCH (Puzzle #${puzzleNumber}): Key Derived & Transaction Signed in Dry-Run`
              : isCs
                ? `Nalezeno řešení Bitcoin Puzzle #${puzzleNumber}! Transakce podepsána a odeslána do privátních poolů`
                : `Bitcoin Puzzle #${puzzleNumber} Solved! Transaction Signed & Sent to Private Pools`}
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleCopyHex}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-900/40 px-3.5 py-2 text-xs font-medium text-emerald-200 hover:bg-emerald-900/60 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            <span>
              {copiedHex
                ? isCs
                  ? 'Raw Hex zkopírován'
                  : 'Raw Hex Copied'
                : isCs
                  ? 'Kopírovat Raw Tx Hex'
                  : 'Copy Raw Tx Hex'}
            </span>
          </button>
          {isDemo && onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#334155] bg-[#161D2B] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-[#1F293B] whitespace-nowrap shrink-0 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{isCs ? 'Zavřít demo' : 'Close Demo'}</span>
            </button>
          )}
        </div>
      </div>

      {isDemo && (
        <div className="rounded-lg border border-amber-500/35 bg-amber-950/25 px-4 py-2.5 text-xs text-amber-200">
          {isCs ? (
            <>
              <strong>Pouze testovací ukázka (Demo Puzzle #{puzzleNumber}):</strong> Výpočetní engine
              skutečně prohledal rozsah <span className="font-mono">0x10 → 0x1f</span> a nalezl
              správný klíč. Výplatní transakce pro vaši adresu byla podepsána na cvičném UTXO
              (0,005 BTC) a ověřena pouze v režimu <strong>Dry-Run</strong> — do sítě Bitcoin nebyla
              odeslána žádná reálná transakce a vaše rozpracované bloky Puzzle #71 zůstaly beze změny.
            </>
          ) : (
            <>
              <strong>Verification Demo Only (Demo Puzzle #{puzzleNumber}):</strong> The compute engine
              actually scanned <span className="font-mono">0x10 → 0x1f</span> and recovered the
              matching key. A payout transaction to your address was signed against a simulated
              0.005 BTC UTXO and checked in <strong>Dry-Run</strong> mode only — no mainnet
              transaction was broadcast and your active Puzzle #71 blocks remain untouched.
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
        <div>
          <p className="text-slate-400">
            {isCs ? 'Nalezený privátní klíč (Hex)' : 'Recovered Private Key (Hex)'}
          </p>
          <p className="mt-1 font-mono text-slate-100 break-all">{foundKeyHex}</p>
        </div>
        <div>
          <p className="text-slate-400">
            {isDemo
              ? isCs
                ? 'Simulovaný výstup (85 % po poplatku)'
                : 'Simulated Payout (85% net)'
              : isCs
                ? 'Váš výstup (85 %)'
                : 'Your Output (85%)'}
          </p>
          <p className="mt-1 font-mono text-emerald-300 tabular-nums">
            {formatBtcFromSats(signedTx.userSats)}
          </p>
        </div>
        <div>
          <p className="text-slate-400">
            {isDemo
              ? 'Demo TXID (Dry-Run)'
              : isCs
                ? 'TXID transakce'
                : 'Transaction TXID'}
          </p>
          <p className="mt-1 font-mono text-slate-100 break-all">{signedTx.txid}</p>
        </div>
      </div>

      {broadcastResult && (
        <div className="border-t border-emerald-500/20 pt-3 space-y-1.5 text-xs">
          <p className="font-medium text-slate-200">
            {isDemo
              ? isCs
                ? 'Stav testovacího předání do privátních poolů (Dry-Run):'
                : 'Private Pool Relay Check Status (Dry-Run):'
              : isCs
                ? 'Stav odeslání do privátních poolů:'
                : 'Private Pool Submission Status:'}
          </p>
          {broadcastResult.receipts.map((r) => (
            <div key={r.provider} className="flex items-center justify-between gap-4 text-slate-300">
              <span>{r.provider}</span>
              <span className={r.accepted ? 'text-emerald-400 text-right' : 'text-amber-300 text-right'}>
                {r.accepted
                  ? r.responseText || (isCs ? 'Přijato poolem' : 'Accepted by pool')
                  : `HTTP ${r.statusCode}: ${r.responseText}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (inline) {
    return card;
  }

  return <div className="mx-auto max-w-[1280px] px-6 pt-6">{card}</div>;
}
