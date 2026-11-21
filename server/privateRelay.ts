import {
  DEFAULT_FEE_RATE_SAT_VB,
  DEFAULT_PUZZLE_71_BALANCE_SATS,
  PUZZLE_71_ADDRESS,
} from '../src/shared/puzzle71.ts';

export interface Puzzle71UtxoItem {
  txid: string;
  vout: number;
  valueSats: string;
  confirmed: boolean;
}

export interface Puzzle71NetworkInfo {
  address: string;
  totalBalanceSats: string;
  utxoCount: number;
  utxo: Puzzle71UtxoItem;
  utxos: Puzzle71UtxoItem[];
  recommendedFeeRateSatVb: number;
  slipstreamFeeRateSatVb: number;
  source: 'live-mempool' | 'fallback';
  fetchedAt: number;
}

export interface PrivateRelayReceipt {
  provider: string;
  endpoint: string;
  accepted: boolean;
  statusCode: number;
  responseText: string;
}

export interface PrivateBroadcastResponse {
  dryRun: boolean;
  txidHint?: string;
  anyAccepted: boolean;
  receipts: PrivateRelayReceipt[];
}

let cachedNetworkInfo: { data: Puzzle71NetworkInfo; expiresAt: number } | null = null;

async function fetchFromExplorer(
  baseUrl: string,
  signal: AbortSignal,
): Promise<{
  addrInfo: {
    chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number; tx_count?: number };
    mempool_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
  } | null;
  rawUtxos: Array<{ txid: string; vout: number; value: number; status?: { confirmed?: boolean } }>;
  fastestFee: number;
}> {
  const isMempool = baseUrl.includes('mempool.space');
  const [addrRes, utxoRes, feesRes] = await Promise.all([
    fetch(`${baseUrl}/address/${PUZZLE_71_ADDRESS}`, { signal }),
    fetch(`${baseUrl}/address/${PUZZLE_71_ADDRESS}/utxo`, { signal }),
    fetch(isMempool ? `${baseUrl}/v1/fees/recommended` : `${baseUrl}/fee-estimates`, { signal }),
  ]);

  if (!utxoRes.ok) {
    throw new Error(`Explorer ${baseUrl} UTXO unavailable`);
  }

  const addrInfo = addrRes.ok
    ? ((await addrRes.json()) as {
        chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number; tx_count?: number };
        mempool_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
      })
    : null;

  const rawUtxos = (await utxoRes.json()) as Array<{
    txid: string;
    vout: number;
    value: number;
    status?: { confirmed?: boolean };
  }>;

  let fastestFee = DEFAULT_FEE_RATE_SAT_VB;
  if (feesRes.ok) {
    const feeData = (await feesRes.json()) as Record<string, number>;
    if (isMempool && typeof feeData.fastestFee === 'number') {
      fastestFee = Math.max(2, Math.round(feeData.fastestFee));
    } else if (!isMempool && typeof feeData['1'] === 'number') {
      fastestFee = Math.max(2, Math.round(feeData['1']));
    }
  }

  return { addrInfo, rawUtxos, fastestFee };
}

export async function fetchPuzzle71NetworkInfo(): Promise<Puzzle71NetworkInfo> {
  if (cachedNetworkInfo && Date.now() < cachedNetworkInfo.expiresAt) {
    return cachedNetworkInfo.data;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    let fetched: Awaited<ReturnType<typeof fetchFromExplorer>> | null = null;
    for (const baseUrl of ['https://mempool.space/api', 'https://blockstream.info/api']) {
      try {
        fetched = await fetchFromExplorer(baseUrl, controller.signal);
        break;
      } catch {
        // try next explorer
      }
    }

    if (!fetched) {
      throw new Error('Upstream explorers unavailable');
    }

    const { addrInfo, rawUtxos, fastestFee } = fetched;

    const sortedUtxos = [...rawUtxos]
      .sort((a, b) => b.value - a.value)
      .map((u) => ({
        txid: u.txid,
        vout: u.vout,
        valueSats: String(u.value),
        confirmed: Boolean(u.status?.confirmed ?? true),
      }));

    const utxoSumSats = rawUtxos.reduce((acc, u) => acc + BigInt(u.value), 0n);
    const chainSumSats = addrInfo?.chain_stats
      ? BigInt(
          (addrInfo.chain_stats.funded_txo_sum ?? 0) -
            (addrInfo.chain_stats.spent_txo_sum ?? 0) +
            (addrInfo.mempool_stats?.funded_txo_sum ?? 0) -
            (addrInfo.mempool_stats?.spent_txo_sum ?? 0),
        )
      : utxoSumSats;

    const totalBalanceSats = chainSumSats > 0n ? chainSumSats : utxoSumSats;
    const primaryUtxo = sortedUtxos[0] ?? {
      txid: '0'.repeat(64),
      vout: 0,
      valueSats: DEFAULT_PUZZLE_71_BALANCE_SATS.toString(),
      confirmed: true,
    };

    // MARA Slipstream requires at least 2x current priority fee or 4 sat/vB
    const slipstreamFee = Math.max(4, fastestFee * 2);

    const data: Puzzle71NetworkInfo = {
      address: PUZZLE_71_ADDRESS,
      totalBalanceSats: totalBalanceSats.toString(),
      utxoCount: sortedUtxos.length,
      utxo: primaryUtxo,
      utxos: sortedUtxos,
      recommendedFeeRateSatVb: fastestFee,
      slipstreamFeeRateSatVb: slipstreamFee,
      source: 'live-mempool',
      fetchedAt: Date.now(),
    };
    cachedNetworkInfo = { data, expiresAt: Date.now() + 30_000 };
    return data;
  } catch {
    const fallbackUtxo = {
      txid: 'a1b2c3d4e5f60718293a4b5c6d7e8f900112233445566778899aabbccddeeff0',
      vout: 0,
      valueSats: DEFAULT_PUZZLE_71_BALANCE_SATS.toString(),
      confirmed: true,
    };
    return {
      address: PUZZLE_71_ADDRESS,
      totalBalanceSats: DEFAULT_PUZZLE_71_BALANCE_SATS.toString(),
      utxoCount: 1,
      utxo: fallbackUtxo,
      utxos: [fallbackUtxo],
      recommendedFeeRateSatVb: DEFAULT_FEE_RATE_SAT_VB,
      slipstreamFeeRateSatVb: DEFAULT_FEE_RATE_SAT_VB * 2,
      source: 'fallback',
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function postJsonWithTimeout(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  locale: 'en' | 'cs' = 'en',
): Promise<{ status: number; text: string; ok: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text: text.slice(0, 500), ok: res.ok };
  } catch (err) {
    return {
      status: 0,
      text:
        err instanceof Error
          ? err.message
          : locale === 'cs'
            ? 'Síťová chyba při spojení s poolem.'
            : 'Network error while connecting to private pool.',
      ok: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Broadcasts a fully signed raw Bitcoin transaction EXCLUSIVELY through private
 * mining-pool endpoints (MARA Slipstream & Rebar Shield + optional custom pool RPC).
 * NEVER broadcasts to the public mempool to prevent RBF front-running.
 */
export async function broadcastPrivatePoolTransaction(params: {
  rawTxHex: string;
  dryRun?: boolean;
  locale?: 'en' | 'cs';
}): Promise<PrivateBroadcastResponse> {
  const locale = params.locale === 'cs' ? 'cs' : 'en';
  const isCs = locale === 'cs';
  const cleanHex = params.rawTxHex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(cleanHex) || cleanHex.length < 120 || cleanHex.length % 2 !== 0) {
    throw new Error(
      isCs ? 'Neplatný formát raw hex transakce.' : 'Invalid raw hex transaction format.',
    );
  }

  const slipstreamUrl =
    process.env.SLIPSTREAM_API_URL || 'https://slipstream.mara.com/rest-api/transactions';
  const rebarUrl = process.env.REBAR_SHIELD_RPC_URL || 'https://shield.rebarlabs.io/v1/rpc';
  const customRpcUrl = process.env.CUSTOM_POOL_RPC_URL?.trim();
  const customAuth = process.env.CUSTOM_POOL_AUTH_HEADER?.trim();

  const slipstreamName = isCs
    ? 'MARA Slipstream (Privátní pool)'
    : 'MARA Slipstream (Private Pool)';
  const rebarName = 'Rebar Shield (Private MEV RPC)';
  const customName = isCs ? 'Vlastní Pool RPC' : 'Custom Pool RPC';

  if (params.dryRun) {
    const receipts: PrivateRelayReceipt[] = [
      {
        provider: slipstreamName,
        endpoint: slipstreamUrl,
        accepted: true,
        statusCode: 200,
        responseText: isCs
          ? 'DRY-RUN: Formát raw transakce ověřen a připraven k odeslání do MARA Pool.'
          : 'DRY-RUN: Raw transaction format verified and ready for MARA Pool submission.',
      },
      {
        provider: rebarName,
        endpoint: rebarUrl,
        accepted: true,
        statusCode: 200,
        responseText: isCs
          ? 'DRY-RUN: JSON-RPC payload sendrawtransaction ověřen mimo veřejný mempool.'
          : 'DRY-RUN: JSON-RPC sendrawtransaction payload verified off the public mempool.',
      },
    ];
    if (customRpcUrl) {
      receipts.push({
        provider: customName,
        endpoint: customRpcUrl,
        accepted: true,
        statusCode: 200,
        responseText: isCs
          ? 'DRY-RUN: Vlastní pool endpoint nakonfigurován.'
          : 'DRY-RUN: Custom pool endpoint configured.',
      });
    }
    return {
      dryRun: true,
      anyAccepted: true,
      receipts,
    };
  }

  const tasks: Array<Promise<PrivateRelayReceipt>> = [
    postJsonWithTimeout(slipstreamUrl, { hex: cleanHex }, {}, locale).then((r) => ({
      provider: slipstreamName,
      endpoint: slipstreamUrl,
      accepted: r.ok,
      statusCode: r.status,
      responseText: r.text,
    })),
    postJsonWithTimeout(
      rebarUrl,
      {
        jsonrpc: '2.0',
        id: 'puzzle71-claim',
        method: 'sendrawtransaction',
        params: [cleanHex],
      },
      {},
      locale,
    ).then((r) => {
      let accepted = r.ok;
      try {
        const parsed = JSON.parse(r.text) as { error?: unknown; result?: unknown };
        if (parsed.error) accepted = false;
      } catch {
        // non-JSON response
      }
      return {
        provider: rebarName,
        endpoint: rebarUrl,
        accepted,
        statusCode: r.status,
        responseText: r.text,
      };
    }),
  ];

  if (customRpcUrl) {
    const headers: Record<string, string> = {};
    if (customAuth) headers.Authorization = customAuth;
    tasks.push(
      postJsonWithTimeout(
        customRpcUrl,
        {
          jsonrpc: '2.0',
          id: 'puzzle71-custom',
          method: 'sendrawtransaction',
          params: [cleanHex],
        },
        headers,
        locale,
      ).then((r) => ({
        provider: customName,
        endpoint: customRpcUrl,
        accepted: r.ok,
        statusCode: r.status,
        responseText: r.text,
      })),
    );
  }

  const receipts = await Promise.all(tasks);
  return {
    dryRun: false,
    anyAccepted: receipts.some((r) => r.accepted),
    receipts,
  };
}
