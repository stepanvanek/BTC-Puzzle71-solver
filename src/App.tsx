import { useCallback, useEffect, useRef, useState } from 'react';
import { AddressOnboarding } from './components/AddressOnboarding.tsx';
import { ClaimBanner } from './components/ClaimBanner.tsx';
import { ComputeConsole } from './components/ComputeConsole.tsx';
import { HowItWorks } from './components/HowItWorks.tsx';
import { LeaderboardSection } from './components/LeaderboardSection.tsx';
import { LedgerView } from './components/LedgerView.tsx';
import { LegalTerms } from './components/LegalTerms.tsx';
import { PuzzleDirectorySection } from './components/PuzzleDirectorySection.tsx';
import { RelayInspector } from './components/RelayInspector.tsx';
import { TopBar } from './components/TopBar.tsx';
import { LocaleContext } from './i18n/LocaleContext.tsx';
import {
  DEFAULT_LOCALE,
  type Locale,
  buildUrlForRoute,
  getHtmlLang,
  getOgLocale,
  getRouteSeoMeta,
  parseRoute,
  pathnameForTab,
} from './i18n/locale.ts';
import { maskBtcAddress } from './shared/btcAddress.ts';
import {
  WEBGPU_INITIAL_SLICE,
  WEBGPU_MAX_SLICE,
  WEBGPU_MIN_SLICE,
  WEBGPU_UNIT_SLICE,
  type WebGPUPendingDispatch,
  detectAndVerifyComputeHardware,
  runComputeSlice,
  submitWebGPUSlice,
  type HardwareCapabilities,
} from './engine/computeEngine.ts';
import {
  type ComputeProfile,
  MAX_CALIBRATION_STORAGE_KEY,
  SMOOTH_CALIBRATION_STORAGE_KEY,
  computeNextDispatchKeys,
  getComputeProfileConfig,
  loadSavedComputeProfile,
  saveComputeProfile,
} from './engine/computeProfile.ts';
import { buildAndSignPuzzle71Tx, type SignedPuzzleTxResult } from './shared/btcTx.ts';
import {
  ADMIN_PAYOUT_ADDRESS,
  DEFAULT_FEE_RATE_SAT_VB,
  DEFAULT_PUZZLE_71_BALANCE_SATS,
  DEMO_PUZZLE_5_HASH160_HEX,
  DEMO_PUZZLE_5_MIN_KEY,
  DEMO_PUZZLE_5_TOTAL_KEYS,
  DEMO_PUZZLE_5_UTXO_SATS,
  formatPrivateKeyHex,
  PUZZLE_71_HASH160_HEX,
} from './shared/puzzle71.ts';
import type {
  ActiveTab,
  LeaseBlocksResponse,
  LeasedBlockPayload,
  PrivateBroadcastResult,
  PuzzleNetworkInfo,
  SessionData,
} from './types/api.ts';
import { detectDeviceLabel, getOrCreateDeviceId, getOrCreateDeviceSecret } from './utils/deviceId.ts';
import {
  DEFAULT_MAX_SPEED_SAMPLES,
  type SpeedSample,
  appendSpeedSample,
} from './utils/speedHistory.ts';

const CALIBRATION_RATE_KEY = 'puzzle71.measuredRateKps_v1';

function loadSavedRateKps(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const val = Number(localStorage.getItem(CALIBRATION_RATE_KEY) ?? '0');
    return Number.isFinite(val) && val > 0 ? val : 0;
  } catch {
    return 0;
  }
}

function saveMeasuredRateKps(rateKps: number): void {
  if (typeof window === 'undefined' || !Number.isFinite(rateKps) || rateKps <= 0) return;
  try {
    localStorage.setItem(CALIBRATION_RATE_KEY, String(Math.round(rateKps)));
  } catch {
    // ignore storage errors
  }
}

function extractShareTokenFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const qToken = params.get('u')?.trim();
  if (qToken) return qToken;
  const pathMatch = window.location.pathname.match(/^\/u\/([A-Za-z0-9_-]+)/);
  return pathMatch ? pathMatch[1] : null;
}

async function safeParseJson<T>(res: Response, fallbackErr: string): Promise<T> {
  const raw = await res.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(fallbackErr);
  }
}

async function yieldToBrowserUi(): Promise<void> {
  const navScheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof navScheduler?.yield === 'function') {
    await navScheduler.yield();
    return;
  }
  await new Promise<void>((r) => setTimeout(r, 0));
}

export default function App() {
  const initialRoute =
    typeof window !== 'undefined'
      ? parseRoute(window.location.pathname, window.location.search)
      : { locale: DEFAULT_LOCALE, tab: 'compute' as ActiveTab };

  const [locale, setLocale] = useState<Locale>(initialRoute.locale);
  const [deviceId] = useState(() => getOrCreateDeviceId());
  const [deviceSecret] = useState(() => getOrCreateDeviceSecret());
  const deviceLabel = detectDeviceLabel(locale);

  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(() => Boolean(extractShareTokenFromUrl()));
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);

  const [activeTab, setActiveTab] = useState<ActiveTab>(initialRoute.tab);
  const [hardware, setHardware] = useState<HardwareCapabilities | null>(null);
  const [networkInfo, setNetworkInfo] = useState<PuzzleNetworkInfo | null>(null);

  const [isRunning, setIsRunning] = useState(false);
  const [isBusyStarting, setIsBusyStarting] = useState(false);
  const [currentBlock, setCurrentBlock] = useState<LeasedBlockPayload | null>(null);
  const [currentOffsetInBlock, setCurrentOffsetInBlock] = useState(0);
  const [currentKeyHex, setCurrentKeyHex] = useState('');
  const [liveKeysPerSec, setLiveKeysPerSec] = useState(0);
  const [dispatchTelemetry, setDispatchTelemetry] = useState<{
    checked: number;
    workgroups: number;
    elapsedMs: number;
  } | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [isRefreshingLedger, setIsRefreshingLedger] = useState(false);
  const [batchStatus, setBatchStatus] = useState<{ current: number; total: number } | null>(null);
  const [speedHistory, setSpeedHistory] = useState<SpeedSample[]>([]);

  const [claimState, setClaimState] = useState<{
    foundKeyHex: string;
    signedTx: SignedPuzzleTxResult;
    broadcastResult: PrivateBroadcastResult | null;
  } | null>(null);
  const [demoClaimState, setDemoClaimState] = useState<{
    foundKeyHex: string;
    signedTx: SignedPuzzleTxResult;
    broadcastResult: PrivateBroadcastResult | null;
  } | null>(null);
  const [isRunningDemo, setIsRunningDemo] = useState(false);
  const [demoScanStatus, setDemoScanStatus] = useState<{
    testedKeyHex: string;
    progressPct: number;
  } | null>(null);

  const runningRef = useRef(false);
  const checkpointInFlightRef = useRef(false);
  const pendingPowOffsetsRef = useRef<Set<number>>(new Set());
  const activeBlockRef = useRef<{ block: LeasedBlockPayload; offset: number; rateKps: number } | null>(
    null,
  );
  const queuedBlocksRef = useRef<LeasedBlockPayload[]>([]);
  const batchTotalRef = useRef(0);
  const batchIndexRef = useRef(0);
  const lastMeasuredRateRef = useRef<number>(loadSavedRateKps());
  const lastHistoryAtRef = useRef(0);

  const [computeProfile, setComputeProfile] = useState<ComputeProfile>(() =>
    loadSavedComputeProfile(),
  );
  const computeProfileRef = useRef<ComputeProfile>(computeProfile);

  const handleChangeComputeProfile = useCallback((nextProfile: ComputeProfile) => {
    computeProfileRef.current = nextProfile;
    setComputeProfile(nextProfile);
    saveComputeProfile(nextProfile);
  }, []);

  const [isProbingHardware, setIsProbingHardware] = useState(false);
  const [isUpdatingStrategy, setIsUpdatingStrategy] = useState(false);

  // 1. Hardware detection & cryptographic self-test
  const probeHardware = useCallback(async () => {
    setIsProbingHardware(true);
    try {
      const caps = await detectAndVerifyComputeHardware(locale);
      setHardware(caps);
    } finally {
      setIsProbingHardware(false);
    }
  }, [locale]);

  useEffect(() => {
    let cancelled = false;
    detectAndVerifyComputeHardware(locale).then((caps) => {
      if (!cancelled) setHardware(caps);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  // 2. Fetch live Puzzle #71 UTXO & fee metadata
  useEffect(() => {
    let cancelled = false;
    fetch('/api/puzzle71/network')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: PuzzleNetworkInfo | null) => {
        if (!cancelled && data) setNetworkInfo(data);
      })
      .catch(() => {
        // fallback handled server-side
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchSessionByToken = useCallback(
    async (token: string) => {
      setIsLoadingSession(true);
      setSessionError(null);
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(token)}`);
        const data = await safeParseJson<SessionData & { error?: string }>(
          res,
          locale === 'cs'
            ? 'Server vrátil neplatnou odpověď při načítání relace.'
            : 'The server returned an invalid response while loading the session.',
        );
        if (!res.ok) {
          throw new Error(
            data.error ||
              (locale === 'cs' ? 'Odkaz relace nebyl nalezen.' : 'Session link was not found.'),
          );
        }
        setSessionData(data);
        const ownLeased = data.recentBlocks
          .filter((b) => b.deviceId === deviceId && b.status === 'leased')
          .sort((a, b) => a.leasedAt - b.leasedAt || a.id - b.id);
        if (ownLeased.length > 0 && !runningRef.current) {
          setCurrentBlock(ownLeased[0]);
          setCurrentOffsetInBlock(ownLeased[0].progressOffset);
          queuedBlocksRef.current = ownLeased.slice(1);
          batchTotalRef.current = ownLeased.length;
          batchIndexRef.current = 1;
          setBatchStatus(ownLeased.length > 1 ? { current: 1, total: ownLeased.length } : null);
        }
      } catch (err) {
        setSessionData(null);
        setSessionError(
          err instanceof Error
            ? err.message
            : locale === 'cs'
              ? 'Nepodařilo se načíst relaci.'
              : 'Failed to load session.',
        );
        window.history.replaceState(null, '', pathnameForTab('compute', locale));
      } finally {
        setIsLoadingSession(false);
      }
    },
    [deviceId, locale],
  );

  // 3. Load session automatically if URL contains ?u=<token> or /u/<token>
  useEffect(() => {
    const token = extractShareTokenFromUrl();
    if (token) {
      fetchSessionByToken(token);
    }
  }, [fetchSessionByToken]);

  const refreshSession = useCallback(async () => {
    if (!sessionData) return;
    setIsRefreshingLedger(true);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionData.session.shareToken)}`,
      );
      if (res.ok) {
        const updated = (await res.json()) as SessionData;
        setSessionData(updated);
      }
    } finally {
      setIsRefreshingLedger(false);
    }
  }, [sessionData]);

  // Periodic background refresh when viewing ledger or running
  useEffect(() => {
    if (!sessionData) return;
    const interval = setInterval(() => {
      if (runningRef.current || activeTab === 'ledger') {
        refreshSession();
      }
    }, 8000);
    return () => clearInterval(interval);
  }, [sessionData, activeTab, refreshSession]);

  const selectTabWithRoute = useCallback(
    (tab: ActiveTab) => {
      setActiveTab(tab);
      if (typeof window === 'undefined') return;
      const token = sessionData?.session.shareToken ?? extractShareTokenFromUrl();
      const targetUrl = buildUrlForRoute(tab, locale, token);
      if (`${window.location.pathname}${window.location.search}` !== targetUrl) {
        window.history.pushState(null, '', targetUrl);
      }
    },
    [sessionData, locale],
  );

  const handleSetLocale = useCallback(
    (nextLocale: Locale) => {
      if (nextLocale === locale) return;
      setLocale(nextLocale);
      if (typeof window === 'undefined') return;
      const token = sessionData?.session.shareToken ?? extractShareTokenFromUrl();
      const targetUrl = buildUrlForRoute(activeTab, nextLocale, token);
      if (`${window.location.pathname}${window.location.search}` !== targetUrl) {
        window.history.pushState(null, '', targetUrl);
      }
    },
    [locale, activeTab, sessionData],
  );

  useEffect(() => {
    const onPopState = () => {
      const next = parseRoute(window.location.pathname, window.location.search);
      setActiveTab(next.tab);
      setLocale(next.locale);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Dynamic multilingual SEO title, description, og:locale, canonical & hreflang tags per SPA route
  useEffect(() => {
    const meta = getRouteSeoMeta(activeTab, locale);
    const ogLocale = getOgLocale(locale);
    document.documentElement.lang = getHtmlLang(locale);
    document.title = meta.title;

    const setMetaContent = (
      selector: string,
      attrName: string,
      attrValue: string,
      content: string,
    ) => {
      let el = document.querySelector(selector);
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attrName, attrValue);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };

    const setLinkHref = (rel: string, href: string, hreflang?: string) => {
      const selector = hreflang
        ? `link[rel="${rel}"][hreflang="${hreflang}"]`
        : `link[rel="${rel}"]`;
      let el = document.querySelector(selector);
      if (!el) {
        el = document.createElement('link');
        el.setAttribute('rel', rel);
        if (hreflang) el.setAttribute('hreflang', hreflang);
        document.head.appendChild(el);
      }
      el.setAttribute('href', href);
    };

    setMetaContent('meta[name="description"]', 'name', 'description', meta.description);
    setMetaContent('meta[property="og:locale"]', 'property', 'og:locale', ogLocale.current);
    setMetaContent(
      'meta[property="og:locale:alternate"]',
      'property',
      'og:locale:alternate',
      ogLocale.alternate,
    );
    setMetaContent('meta[property="og:title"]', 'property', 'og:title', meta.title);
    setMetaContent(
      'meta[property="og:description"]',
      'property',
      'og:description',
      meta.description,
    );
    setMetaContent('meta[name="twitter:title"]', 'name', 'twitter:title', meta.title);
    setMetaContent(
      'meta[name="twitter:description"]',
      'name',
      'twitter:description',
      meta.description,
    );

    const origin = window.location.origin;
    const canonicalPath = pathnameForTab(activeTab, locale);
    const canonicalUrl = `${origin}${canonicalPath}`;
    const enUrl = `${origin}${pathnameForTab(activeTab, 'en')}`;
    const csUrl = `${origin}${pathnameForTab(activeTab, 'cs')}`;

    setLinkHref('canonical', canonicalUrl);
    setLinkHref('alternate', enUrl, 'en');
    setLinkHref('alternate', csUrl, 'cs');
    setLinkHref('alternate', enUrl, 'x-default');
    setMetaContent('meta[property="og:url"]', 'property', 'og:url', canonicalUrl);
  }, [activeTab, locale]);

  // Keep-alive heartbeat while paused on page so the active block is held indefinitely until user resumes or leaves
  useEffect(() => {
    if (!sessionData || !currentBlock || isRunning) return;
    const token = sessionData.session.shareToken;
    const blockId = currentBlock.id;
    let cancelled = false;

    const sendHeartbeat = async () => {
      if (cancelled || runningRef.current) return;
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(token)}/blocks/${blockId}/heartbeat`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-device-secret': deviceSecret,
            },
            body: JSON.stringify({ deviceId, deviceSecret }),
          },
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          active?: boolean;
          status?: 'leased' | 'completed' | 'reclaimed';
        };
        if (!cancelled && data.active === false) {
          setCurrentBlock(null);
          setCurrentOffsetInBlock(0);
          setCurrentKeyHex('');
          activeBlockRef.current = null;
          queuedBlocksRef.current = [];
          batchTotalRef.current = 0;
          batchIndexRef.current = 0;
          setBatchStatus(null);
          pendingPowOffsetsRef.current.clear();
          void refreshSession();
        }
      } catch {
        // transient network issue - retry on next heartbeat
      }
    };

    const interval = setInterval(() => {
      void sendHeartbeat();
    }, 45_000);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void sendHeartbeat();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [sessionData, currentBlock, isRunning, deviceId, deviceSecret, refreshSession]);

  const handleCreateSession = async (btcAddress: string) => {
    setIsCreatingSession(true);
    setSessionError(null);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ btcAddress, locale }),
      });
      const data = await safeParseJson<SessionData & { error?: string }>(
        res,
        locale === 'cs'
          ? 'Server vrátil neplatnou odpověď při vytváření relace.'
          : 'The server returned an invalid response while creating the session.',
      );
      if (!res.ok) {
        throw new Error(
          data.error ||
            (locale === 'cs' ? 'Chyba při vytváření relace.' : 'Failed to create session.'),
        );
      }
      setSessionData(data);
      setActiveTab('compute');
      window.history.pushState(
        null,
        '',
        buildUrlForRoute('compute', locale, data.session.shareToken),
      );
    } catch (err) {
      setSessionError(
        err instanceof Error
          ? err.message
          : locale === 'cs'
            ? 'Nepodařilo se vytvořit relaci.'
            : 'Failed to create session.',
      );
    } finally {
      setIsCreatingSession(false);
    }
  };

  const handleUpdateStrategy = async (
    blockMode: 'random' | 'sequential',
    startPercent?: number,
  ): Promise<void> => {
    if (!sessionData || runningRef.current) return;
    setIsUpdatingStrategy(true);
    setEngineError(null);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionData.session.shareToken)}/strategy`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'x-device-secret': deviceSecret,
          },
          body: JSON.stringify({
            blockMode,
            startPercent,
            deviceId,
            deviceSecret,
          }),
        },
      );
      const data = await safeParseJson<SessionData & { error?: string }>(
        res,
        locale === 'cs'
          ? 'Server vrátil neplatnou odpověď při ukládání strategie.'
          : 'The server returned an invalid response while saving block strategy.',
      );
      if (!res.ok) {
        throw new Error(
          data.error ||
            (locale === 'cs'
              ? 'Nepodařilo se uložit strategii bloků.'
              : 'Failed to save block strategy.'),
        );
      }
      setSessionData(data);
      // Server released all unstarted (0-progress) queued blocks for this device
      queuedBlocksRef.current = [];
      if (currentBlock && currentOffsetInBlock === 0 && currentBlock.progressOffset === 0) {
        setCurrentBlock(null);
        setCurrentOffsetInBlock(0);
        setCurrentKeyHex('');
        activeBlockRef.current = null;
        batchTotalRef.current = 0;
        batchIndexRef.current = 0;
        setBatchStatus(null);
        pendingPowOffsetsRef.current.clear();
      } else if (currentBlock) {
        batchTotalRef.current = 1;
        batchIndexRef.current = 1;
        setBatchStatus(null);
      }
    } catch (err) {
      setEngineError(
        err instanceof Error
          ? err.message
          : locale === 'cs'
            ? 'Chyba při změně strategie.'
            : 'Error updating block strategy.',
      );
    } finally {
      setIsUpdatingStrategy(false);
    }
  };

  const flushCheckpoint = async (
    shareToken: string,
    blockId: number,
    offset: number,
    rateKps: number,
  ) => {
    checkpointInFlightRef.current = true;
    const batchOffsets = [...pendingPowOffsetsRef.current].slice(0, 32);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(shareToken)}/blocks/${blockId}/checkpoint`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-device-secret': deviceSecret,
          },
          body: JSON.stringify({
            deviceId,
            deviceSecret,
            progressOffset: offset,
            rateKps,
            powOffsets: batchOffsets,
          }),
        },
      );
      if (res.ok) {
        for (const off of batchOffsets) {
          pendingPowOffsetsRef.current.delete(off);
        }
        const json = (await res.json().catch(() => null)) as { powCount?: number } | null;
        if (json && typeof json.powCount === 'number') {
          setCurrentBlock((prev) =>
            prev && prev.id === blockId ? { ...prev, powCount: json.powCount! } : prev,
          );
        }
      }
    } catch {
      // non-fatal transient heartbeat
    } finally {
      checkpointInFlightRef.current = false;
    }
  };

  const stopComputeLoop = useCallback(async () => {
    runningRef.current = false;
    setIsRunning(false);
    setLiveKeysPerSec(0);
    setDispatchTelemetry(null);
    const active = activeBlockRef.current;
    if (active && sessionData) {
      await flushCheckpoint(
        sessionData.session.shareToken,
        active.block.id,
        active.offset,
        active.rateKps,
      );
      await refreshSession();
    }
  }, [sessionData, refreshSession]);

  const handleResetSession = async () => {
    await stopComputeLoop();
    setCurrentBlock(null);
    setCurrentOffsetInBlock(0);
    setCurrentKeyHex('');
    activeBlockRef.current = null;
    queuedBlocksRef.current = [];
    batchTotalRef.current = 0;
    batchIndexRef.current = 0;
    setBatchStatus(null);
    setSpeedHistory([]);
    lastHistoryAtRef.current = 0;
    setIsRunningDemo(false);
    setDemoScanStatus(null);
    setDemoClaimState(null);
    setSessionData(null);
    setSessionError(null);
    window.history.pushState(null, '', pathnameForTab('compute', locale));
  };

  const handleWinningKeyFound = async (
    winningKey: bigint,
    activeSession: SessionData,
  ): Promise<void> => {
    runningRef.current = false;
    setIsRunning(false);

    const net = (networkInfo ??
      (await fetch('/api/puzzle71/network').then((r) => r.json()))) as PuzzleNetworkInfo | null;
    const feeRate = Number(net?.slipstreamFeeRateSatVb ?? DEFAULT_FEE_RATE_SAT_VB * 2);
    const utxos =
      net?.utxos && net.utxos.length > 0
        ? net.utxos.map((u) => ({
            txid: u.txid,
            vout: u.vout,
            valueSats: BigInt(u.valueSats),
          }))
        : [
            {
              txid: net?.utxo?.txid ?? '0'.repeat(64),
              vout: net?.utxo?.vout ?? 0,
              valueSats: BigInt(net?.totalBalanceSats ?? DEFAULT_PUZZLE_71_BALANCE_SATS.toString()),
            },
          ];

    const signedTx = buildAndSignPuzzle71Tx({
      privateKey: winningKey,
      utxos,
      userAddress: activeSession.session.btcAddress,
      adminAddress: ADMIN_PAYOUT_ADDRESS,
      feeRateSatPerVb: feeRate,
    });

    const foundKeyHex = formatPrivateKeyHex(winningKey);
    setClaimState({
      foundKeyHex,
      signedTx,
      broadcastResult: null,
    });

    const broadcastRes = await fetch('/api/broadcast-private', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawTxHex: signedTx.txHex,
        dryRun: false,
        locale,
        shareToken: activeSession.session.shareToken,
        txid: signedTx.txid,
        userSats: signedTx.userSats.toString(),
        adminSats: signedTx.adminSats.toString(),
        feeSats: signedTx.feeSats.toString(),
      }),
    });
    if (broadcastRes.ok) {
      const broadcastResult = (await broadcastRes.json()) as PrivateBroadcastResult;
      setClaimState({
        foundKeyHex,
        signedTx,
        broadcastResult,
      });
    }
  };

  const handleRunDemoPuzzle5 = async (): Promise<void> => {
    if (!sessionData || !hardware?.selfTestPassed || runningRef.current || isRunningDemo) {
      return;
    }

    setEngineError(null);
    setDemoClaimState(null);
    setIsRunningDemo(true);

    try {
      const chunkKeys = 4;
      let foundKey: bigint | null = null;

      for (let offset = 0; offset < DEMO_PUZZLE_5_TOTAL_KEYS; offset += chunkKeys) {
        const startChunk = DEMO_PUZZLE_5_MIN_KEY + BigInt(offset);
        const remaining = DEMO_PUZZLE_5_TOTAL_KEYS - offset;
        const count = Math.min(chunkKeys, remaining);

        setDemoScanStatus({
          testedKeyHex: '0x' + startChunk.toString(16),
          progressPct: Math.min(100, Math.round(((offset + count) / DEMO_PUZZLE_5_TOTAL_KEYS) * 100)),
        });

        await new Promise((r) => setTimeout(r, 180));

        const res = await runComputeSlice({
          mode: 'cpu',
          startKey: startChunk,
          maxCount: count,
          targetHash160Hex: DEMO_PUZZLE_5_HASH160_HEX,
        });

        if (res.foundKey !== null) {
          foundKey = res.foundKey;
          setDemoScanStatus({
            testedKeyHex: '0x' + res.foundKey.toString(16),
            progressPct: 100,
          });
          break;
        }
      }

      if (foundKey === null) {
        throw new Error(
          locale === 'cs'
            ? 'Demo Puzzle #5 klíč nebyl v rozsahu nalezen.'
            : 'Demo Puzzle #5 key was not found in the expected range.',
        );
      }

      const feeRate = Number(networkInfo?.slipstreamFeeRateSatVb ?? DEFAULT_FEE_RATE_SAT_VB * 2);
      const signedTx = buildAndSignPuzzle71Tx({
        privateKey: foundKey,
        utxos: [
          {
            txid: '5'.repeat(64),
            vout: 0,
            valueSats: DEMO_PUZZLE_5_UTXO_SATS,
          },
        ],
        userAddress: sessionData.session.btcAddress,
        adminAddress: ADMIN_PAYOUT_ADDRESS,
        feeRateSatPerVb: feeRate,
      });

      const foundKeyHex = formatPrivateKeyHex(foundKey);
      setDemoClaimState({
        foundKeyHex,
        signedTx,
        broadcastResult: null,
      });

      const broadcastRes = await fetch('/api/broadcast-private', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawTxHex: signedTx.txHex,
          dryRun: true,
          locale,
        }),
      });
      if (broadcastRes.ok) {
        const broadcastResult = (await broadcastRes.json()) as PrivateBroadcastResult;
        setDemoClaimState({
          foundKeyHex,
          signedTx,
          broadcastResult,
        });
      }
    } catch (err) {
      setEngineError(
        err instanceof Error
          ? err.message
          : locale === 'cs'
            ? 'Demo Puzzle #5 selhalo.'
            : 'Demo Puzzle #5 failed.',
      );
    } finally {
      setIsRunningDemo(false);
    }
  };

  const startComputeLoop = async () => {
    if (!sessionData || !hardware || !hardware.selfTestPassed) return;
    setEngineError(null);
    setIsBusyStarting(true);

    const token = sessionData.session.shareToken;
    const RATE_WINDOW_MS = 5000;

    let calibratedMaxKeys = hardware.recommendedDispatchKeys ?? WEBGPU_INITIAL_SLICE;
    try {
      const savedMax = parseInt(localStorage.getItem(MAX_CALIBRATION_STORAGE_KEY) ?? '0', 10);
      if (Number.isFinite(savedMax) && savedMax >= WEBGPU_MIN_SLICE && savedMax <= WEBGPU_MAX_SLICE) {
        calibratedMaxKeys = savedMax;
      }
    } catch {
      // ignore storage errors
    }

    let calibratedSmoothKeys = Math.min(calibratedMaxKeys, 2 * WEBGPU_UNIT_SLICE);
    try {
      const savedSmooth = parseInt(
        localStorage.getItem(SMOOTH_CALIBRATION_STORAGE_KEY) ?? '0',
        10,
      );
      if (
        Number.isFinite(savedSmooth) &&
        savedSmooth >= WEBGPU_MIN_SLICE &&
        savedSmooth <= WEBGPU_MAX_SLICE
      ) {
        calibratedSmoothKeys = savedSmooth;
      }
    } catch {
      // ignore storage errors
    }

    const leaseNextBatch = async (): Promise<LeasedBlockPayload> => {
      const measuredRate = lastMeasuredRateRef.current;
      const res = await fetch(`/api/sessions/${encodeURIComponent(token)}/blocks/lease`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-secret': deviceSecret,
        },
        body: JSON.stringify({
          deviceId,
          deviceSecret,
          deviceLabel,
          computeMode: hardware.mode,
          gpuName: hardware.adapterName,
          rateKps: measuredRate > 0 ? measuredRate : undefined,
        }),
      });
      const payload = await safeParseJson<Partial<LeaseBlocksResponse> & { error?: string }>(
        res,
        locale === 'cs'
          ? 'Server vrátil neplatnou odpověď při přidělování bloku.'
          : 'The server returned an invalid response while leasing a block.',
      );
      const leasedList =
        payload.blocks && payload.blocks.length > 0
          ? payload.blocks
          : payload.block
            ? [payload.block]
            : [];
      if (!res.ok || leasedList.length === 0) {
        throw new Error(
          payload.error ||
            (locale === 'cs'
              ? 'Nepodařilo se přidělit unikátní blok ze serveru.'
              : 'Failed to lease a unique keyspace block from the server.'),
        );
      }

      const first = leasedList[0];
      queuedBlocksRef.current = leasedList.slice(1);
      batchTotalRef.current = leasedList.length;
      batchIndexRef.current = 1;
      setBatchStatus(leasedList.length > 1 ? { current: 1, total: leasedList.length } : null);
      return first;
    };

    const completeAndAdvanceBlock = async (
      completedBlock: LeasedBlockPayload,
    ): Promise<LeasedBlockPayload> => {
      const finalOffsets = [...pendingPowOffsetsRef.current].slice(0, 32);
      const measuredRate = activeBlockRef.current?.rateKps ?? lastMeasuredRateRef.current;
      saveMeasuredRateKps(measuredRate);

      const completeRes = await fetch(
        `/api/sessions/${encodeURIComponent(token)}/blocks/${completedBlock.id}/complete`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-device-secret': deviceSecret,
          },
          body: JSON.stringify({
            deviceId,
            deviceSecret,
            rateKps: measuredRate,
            powOffsets: finalOffsets,
          }),
        },
      );
      const completePayload = await safeParseJson<{ ok?: boolean; summary?: SessionData; error?: string }>(
        completeRes,
        locale === 'cs'
          ? 'Server vrátil neplatnou odpověď při dokončování bloku.'
          : 'The server returned an invalid response while completing a block.',
      );
      if (!completeRes.ok) {
        throw new Error(
          completePayload.error ||
            (locale === 'cs'
              ? 'Dokončení bloku bylo odmítnuto serverem.'
              : 'Block completion was rejected by the server.'),
        );
      }
      pendingPowOffsetsRef.current.clear();

      // Advance immediately to pre-leased contiguous batch block with zero network stall
      const queuedNext = queuedBlocksRef.current.shift();
      let nextBlock: LeasedBlockPayload;
      if (queuedNext) {
        batchIndexRef.current += 1;
        setBatchStatus(
          batchTotalRef.current > 1
            ? { current: batchIndexRef.current, total: batchTotalRef.current }
            : null,
        );
        nextBlock = queuedNext;
      } else {
        nextBlock = await leaseNextBatch();
      }

      setCurrentBlock(nextBlock);
      setCurrentOffsetInBlock(nextBlock.progressOffset);
      activeBlockRef.current = {
        block: nextBlock,
        offset: nextBlock.progressOffset,
        rateKps: measuredRate,
      };
      if (completePayload.summary) {
        setSessionData(completePayload.summary);
      } else {
        void refreshSession();
      }
      return nextBlock;
    };

    try {
      let block = await leaseNextBatch();
      let offset = block.progressOffset;
      pendingPowOffsetsRef.current.clear();

      setCurrentBlock(block);
      setCurrentOffsetInBlock(offset);
      activeBlockRef.current = { block, offset, rateKps: lastMeasuredRateRef.current };

      runningRef.current = true;
      setIsRunning(true);
      setIsBusyStarting(false);

      // Refresh session immediately so this device appears online
      void refreshSession();

      let lastCheckpointAt = performance.now();
      let lastUiReportAt = 0;
      let consecutiveLosses = 0;
      const samples: Array<{ durationMs: number; t1: number; keys: number }> = [];

      const collectPowKeys = (activeBlk: LeasedBlockPayload, powKeys: bigint[]) => {
        if (!powKeys || powKeys.length === 0) return;
        const blockStart = BigInt(activeBlk.startKeyHex);
        for (const k of powKeys) {
          const rel = Number(k - blockStart);
          if (Number.isInteger(rel) && rel >= 0 && rel < activeBlk.totalKeys) {
            pendingPowOffsetsRef.current.add(rel);
          }
        }
      };

      const recordSampleAndReport = async (
        checked: number,
        durationMs: number,
        t1: number,
        workgroups: number,
        batchStartBig: bigint,
      ) => {
        samples.push({
          durationMs: Math.max(0.1, durationMs),
          t1,
          keys: checked,
        });
        const cutoff = t1 - RATE_WINDOW_MS;
        while (samples.length > 1 && samples[0].t1 < cutoff) {
          samples.shift();
        }
        let sumKeys = 0;
        let sumMs = 0;
        for (const s of samples) {
          sumKeys += s.keys;
          sumMs += s.durationMs;
        }
        const currentRate = sumMs > 0 ? (sumKeys * 1000) / sumMs : 0;
        if (currentRate > 0) {
          lastMeasuredRateRef.current = currentRate;
          const nowWallMs = Date.now();
          if (nowWallMs - lastHistoryAtRef.current >= 950) {
            lastHistoryAtRef.current = nowWallMs;
            setSpeedHistory((prev) =>
              appendSpeedSample(prev, currentRate, nowWallMs, DEFAULT_MAX_SPEED_SAMPLES, 900),
            );
          }
        }

        activeBlockRef.current = { block, offset, rateKps: currentRate };

        if (t1 - lastCheckpointAt >= 2500 && !checkpointInFlightRef.current) {
          lastCheckpointAt = t1;
          saveMeasuredRateKps(currentRate);
          void flushCheckpoint(token, block.id, offset, currentRate);
        }

        const shouldReportUi =
          lastUiReportAt === 0 || t1 - lastUiReportAt >= 200 || offset >= block.totalKeys;
        if (shouldReportUi) {
          lastUiReportAt = t1;
          setCurrentOffsetInBlock(offset);
          setLiveKeysPerSec(currentRate);
          setDispatchTelemetry({
            checked,
            workgroups,
            elapsedMs: durationMs,
          });
          if (checked > 0) {
            setCurrentKeyHex('0x' + (batchStartBig + BigInt(checked - 1)).toString(16));
          }
          await yieldToBrowserUi();
        } else if (getComputeProfileConfig(computeProfileRef.current).yieldEveryDispatch) {
          await yieldToBrowserUi();
        }
      };

      if (hardware.mode === 'webgpu') {
        let submittedOffset = offset;
        let nextSlot: 0 | 1 = 0;
        let lastCompletedAt = 0;
        const pipelineQueue: WebGPUPendingDispatch[] = [];

        const tryEnqueueGpu = async (desiredKeys: number): Promise<boolean> => {
          if (!runningRef.current) return false;
          const unsubmitted = block.totalKeys - submittedOffset;
          if (unsubmitted < WEBGPU_MIN_SLICE) return false;

          const batchStart = BigInt(block.startKeyHex) + BigInt(submittedOffset);
          const pending = await submitWebGPUSlice({
            slotIndex: nextSlot,
            startKey: batchStart,
            maxCount: unsubmitted,
            desiredDispatchKeys: desiredKeys,
            targetHash160Hex: PUZZLE_71_HASH160_HEX,
          });
          if (!pending) return false;

          submittedOffset += pending.checked;
          nextSlot = nextSlot === 0 ? 1 : 0;
          pipelineQueue.push(pending);
          return true;
        };

        const drainQueueSafely = async () => {
          if (pipelineQueue.length === 0) return;
          const items = pipelineQueue.splice(0, pipelineQueue.length);
          await Promise.allSettled(items.map((item) => item.waitForResult()));
        };

        while (runningRef.current) {
          const activeProfile = computeProfileRef.current;
          const profileCfg = getComputeProfileConfig(activeProfile);
          const activeDesiredKeys =
            activeProfile === 'smooth' ? calibratedSmoothKeys : calibratedMaxKeys;

          try {
            if (pipelineQueue.length === 0) {
              await tryEnqueueGpu(activeDesiredKeys);
              if (pipelineQueue.length === 0) {
                const remaining = block.totalKeys - offset;
                if (remaining > 0) {
                  const tailStart = BigInt(block.startKeyHex) + BigInt(offset);
                  const tailRes = await runComputeSlice({
                    mode: 'webgpu',
                    startKey: tailStart,
                    maxCount: remaining,
                    targetHash160Hex: PUZZLE_71_HASH160_HEX,
                  });
                  if (tailRes.foundKey !== null) {
                    await handleWinningKeyFound(tailRes.foundKey, sessionData);
                    return;
                  }
                  collectPowKeys(block, tailRes.powKeys);
                  offset += tailRes.checked;
                  submittedOffset = offset;
                  await recordSampleAndReport(
                    tailRes.checked,
                    tailRes.elapsedMs,
                    performance.now(),
                    0,
                    tailStart,
                  );
                }
                if (block.totalKeys - offset <= 0) {
                  block = await completeAndAdvanceBlock(block);
                  offset = block.progressOffset;
                  submittedOffset = offset;
                  lastUiReportAt = performance.now();
                  continue;
                }
              }
            }

            // Keep 2nd buffer slot in-flight in Max mode; single slot in Smooth mode so UI/scroll paints promptly
            if (pipelineQueue.length < profileCfg.pipelineDepth) {
              await tryEnqueueGpu(activeDesiredKeys);
            }

            const head = pipelineQueue.shift();
            if (!head) continue;

            const sliceRes = await head.waitForResult();
            consecutiveLosses = 0;

            if (sliceRes.foundKey !== null) {
              await drainQueueSafely();
              await handleWinningKeyFound(sliceRes.foundKey, sessionData);
              return;
            }

            collectPowKeys(block, sliceRes.powKeys);
            offset += sliceRes.checked;
            const activeStart = Math.max(sliceRes.submittedAt, lastCompletedAt);
            const gpuSpanMs = Math.max(0.1, sliceRes.completedAt - activeStart);
            lastCompletedAt = sliceRes.completedAt;

            const unsubmitted = block.totalKeys - submittedOffset;
            const postProfile = computeProfileRef.current;
            const postCfg = getComputeProfileConfig(postProfile);
            const prevCalibrated =
              postProfile === 'smooth' ? calibratedSmoothKeys : calibratedMaxKeys;
            const nextCalibrated = computeNextDispatchKeys({
              currentKeys: prevCalibrated,
              lastChecked: sliceRes.checked,
              unsubmittedKeys: unsubmitted,
              gpuSpanMs,
              minSlice: WEBGPU_MIN_SLICE,
              unitSlice: WEBGPU_UNIT_SLICE,
              maxSlice: WEBGPU_MAX_SLICE,
              config: postCfg,
            });
            if (nextCalibrated !== prevCalibrated) {
              if (postProfile === 'smooth') {
                calibratedSmoothKeys = nextCalibrated;
              } else {
                calibratedMaxKeys = nextCalibrated;
              }
              try {
                localStorage.setItem(
                  postProfile === 'smooth'
                    ? SMOOTH_CALIBRATION_STORAGE_KEY
                    : MAX_CALIBRATION_STORAGE_KEY,
                  String(nextCalibrated),
                );
              } catch {
                // ignore storage errors
              }
            }

            await recordSampleAndReport(
              sliceRes.checked,
              gpuSpanMs,
              sliceRes.completedAt,
              sliceRes.workgroups,
              head.startKey,
            );
          } catch (err) {
            await drainQueueSafely();
            if (!runningRef.current) {
              break;
            }
            consecutiveLosses += 1;
            submittedOffset = offset;
            nextSlot = 0;
            lastCompletedAt = 0;
            const errProfile = computeProfileRef.current;
            const shrunk = Math.max(
              WEBGPU_MIN_SLICE,
              Math.floor((errProfile === 'smooth' ? calibratedSmoothKeys : calibratedMaxKeys) / 8),
            );
            if (errProfile === 'smooth') {
              calibratedSmoothKeys = shrunk;
            } else {
              calibratedMaxKeys = shrunk;
            }
            try {
              localStorage.setItem(
                errProfile === 'smooth'
                  ? SMOOTH_CALIBRATION_STORAGE_KEY
                  : MAX_CALIBRATION_STORAGE_KEY,
                String(shrunk),
              );
            } catch {
              // ignore storage errors
            }
            if (consecutiveLosses > 4) {
              throw err;
            }
            await new Promise((r) => setTimeout(r, 1000 * consecutiveLosses));
          }
        }

        // Cleanly account for any in-flight GPU work on manual Stop
        if (pipelineQueue.length > 0) {
          const remainingItems = pipelineQueue.splice(0, pipelineQueue.length);
          const settled = await Promise.allSettled(remainingItems.map((item) => item.waitForResult()));
          for (const res of settled) {
            if (res.status === 'fulfilled') {
              if (res.value.foundKey !== null) {
                await handleWinningKeyFound(res.value.foundKey, sessionData);
                return;
              }
              collectPowKeys(block, res.value.powKeys);
              offset += res.value.checked;
            }
          }
          activeBlockRef.current = {
            block,
            offset,
            rateKps: activeBlockRef.current?.rateKps ?? 0,
          };
        }
      } else {
        while (runningRef.current) {
          const startBig = BigInt(block.startKeyHex) + BigInt(offset);
          const remaining = block.totalKeys - offset;

          if (remaining <= 0) {
            block = await completeAndAdvanceBlock(block);
            offset = block.progressOffset;
            lastUiReportAt = performance.now();
            continue;
          }

          const profileCfg = getComputeProfileConfig(computeProfileRef.current);
          const sliceRes = await runComputeSlice({
            mode: 'cpu',
            startKey: startBig,
            maxCount: remaining,
            targetHash160Hex: PUZZLE_71_HASH160_HEX,
            maxThreads: profileCfg.cpuThreads,
            sliceKeysPerWorker: profileCfg.cpuSliceKeysPerWorker,
          });

          if (sliceRes.foundKey !== null) {
            await handleWinningKeyFound(sliceRes.foundKey, sessionData);
            return;
          }

          collectPowKeys(block, sliceRes.powKeys);
          offset += sliceRes.checked;
          await recordSampleAndReport(
            sliceRes.checked,
            sliceRes.elapsedMs,
            performance.now(),
            0,
            startBig,
          );
        }
      }
    } catch (err) {
      runningRef.current = false;
      setIsRunning(false);
      setIsBusyStarting(false);
      setEngineError(
        err instanceof Error
          ? err.message
          : locale === 'cs'
            ? 'Chyba výpočetní smyčky.'
            : 'Compute loop error.',
      );
    }
  };

  const handleToggleRun = () => {
    if (isRunning) {
      stopComputeLoop();
    } else {
      startComputeLoop();
    }
  };

  return (
    <LocaleContext.Provider value={{ locale, setLocale: handleSetLocale }}>
      <div className="min-h-screen bg-[#090B10] text-slate-100 flex flex-col">
        <TopBar
          hasSession={Boolean(sessionData)}
          activeTab={activeTab}
          onSelectTab={selectTabWithRoute}
          onResetSession={handleResetSession}
        />

        {claimState && (
          <ClaimBanner
            foundKeyHex={claimState.foundKeyHex}
            signedTx={claimState.signedTx}
            broadcastResult={claimState.broadcastResult}
          />
        )}

        <main className="flex-1">
          {isLoadingSession ? (
            <div className="mx-auto max-w-[1040px] px-6 py-16 text-center text-sm text-slate-400">
              {locale === 'cs'
                ? 'Načítám sdílenou relaci a stav prohledaného prostoru...'
                : 'Loading shared session and scanned keyspace state...'}
            </div>
        ) : activeTab === 'docs' ? (
          <HowItWorks
            onOpenTerms={() => {
              selectTabWithRoute('terms');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
        ) : activeTab === 'terms' ? (
          <LegalTerms />
        ) : activeTab === 'puzzles' ? (
          <PuzzleDirectorySection
            detectedKeysPerSec={liveKeysPerSec || lastMeasuredRateRef.current}
            onOpenDocs={() => {
              selectTabWithRoute('docs');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
        ) : activeTab === 'leaderboard' ? (
          <LeaderboardSection
            currentMaskedAddress={
              sessionData ? maskBtcAddress(sessionData.session.btcAddress) : null
            }
          />
        ) : activeTab === 'relay' ? (
          <RelayInspector sessionData={sessionData} networkInfo={networkInfo} />
        ) : !sessionData ? (
          <AddressOnboarding
            onCreateSession={handleCreateSession}
            isSubmitting={isCreatingSession}
            serverError={sessionError}
            detectedKeysPerSec={liveKeysPerSec || lastMeasuredRateRef.current}
            onOpenPuzzles={() => {
              selectTabWithRoute('puzzles');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            onOpenDocs={() => {
              selectTabWithRoute('docs');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            onOpenTerms={() => {
              selectTabWithRoute('terms');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            onOpenLeaderboard={() => {
              selectTabWithRoute('leaderboard');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
        ) : activeTab === 'ledger' ? (
          <LedgerView
            sessionData={sessionData}
            currentDeviceId={deviceId}
            onRefresh={refreshSession}
            isRefreshing={isRefreshingLedger}
          />
        ) : (
          <ComputeConsole
            sessionData={sessionData}
            currentDeviceId={deviceId}
            hardware={hardware}
            computeProfile={computeProfile}
            isProbingHardware={isProbingHardware}
            isUpdatingStrategy={isUpdatingStrategy}
            isRunning={isRunning}
            isBusyStarting={isBusyStarting}
            isRunningDemo={isRunningDemo}
            demoScanStatus={demoScanStatus}
            demoClaimState={demoClaimState}
            currentBlock={currentBlock}
            currentOffsetInBlock={currentOffsetInBlock}
            currentKeyHex={currentKeyHex}
            liveKeysPerSec={liveKeysPerSec}
            speedHistory={speedHistory}
            batchStatus={batchStatus}
            dispatchTelemetry={dispatchTelemetry}
            networkInfo={networkInfo}
            engineError={engineError}
            onToggleRun={handleToggleRun}
            onChangeComputeProfile={handleChangeComputeProfile}
            onRetryWebGPU={probeHardware}
            onUpdateStrategy={handleUpdateStrategy}
            onRunDemoPuzzle5={handleRunDemoPuzzle5}
            onDismissDemoClaim={() => {
              setDemoClaimState(null);
              setDemoScanStatus(null);
            }}
          />
        )}
      </main>

      <footer className="border-t border-[#161B26] py-6 px-6 text-center text-xs text-slate-500 space-y-2">
        <p>
          {locale === 'cs'
            ? 'Puzzle71 WebGPU · Edukativní a výzkumný nástroj poskytovaný „tak jak je“ bez jakékoli záruky či garance · Uživatel nese veškerá rizika'
            : 'Puzzle71 WebGPU · Educational and research tool provided “as-is” without warranty or guarantee of any kind · User assumes all risks'}
        </p>
        <p className="text-slate-400">
          {locale === 'cs'
            ? 'Vytvořeno metodou vibecoding pomocí aplikace Google AI Studio · Celý kód byl tvořen AI a nebyl zatím revidován žádným programátorem.'
            : 'Created via vibecoding with Google AI Studio · All code was generated by AI and has not yet been reviewed by a human programmer.'}
        </p>
        <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <button
            type="button"
            onClick={() => {
              selectTabWithRoute('puzzles');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            className="text-slate-400 hover:text-slate-200 underline underline-offset-4 cursor-pointer"
          >
            {locale === 'cs' ? 'Tabulka Bitcoin Puzzle #1–#160' : 'Bitcoin Puzzle #1–#160 Directory'}
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => {
              selectTabWithRoute('docs');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            className="text-slate-400 hover:text-slate-200 underline underline-offset-4 cursor-pointer"
          >
            {locale === 'cs'
              ? 'Co je Puzzle #71 & Jak web funguje'
              : 'What Is Puzzle #71 & How It Works'}
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => {
              selectTabWithRoute('terms');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            className="text-amber-400/90 hover:text-amber-300 underline underline-offset-4 cursor-pointer"
          >
            {locale === 'cs'
              ? 'Podmínky užití, vyloučení odpovědnosti a rizika'
              : 'Terms of Use, Disclaimer & Risks'}
          </button>
        </p>
      </footer>
      </div>
    </LocaleContext.Provider>
  );
}
