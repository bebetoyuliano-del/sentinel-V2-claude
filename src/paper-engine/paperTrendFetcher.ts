/**
 * RC-1 Fix — Paper Engine Trend Fetcher
 *
 * ISOLATED dari fetchMarketDataWithIndicators.
 * PAPER ONLY — tidak dipanggil dari live execution path.
 *
 * Fetch OHLCV 4H + hitung Range Filter untuk menentukan trend dominan.
 * Cache 4 menit — candle 4H berubah tiap 4 jam, update lebih sering tidak perlu.
 * Fetch sequential + delay 200ms — TIDAK pakai Promise.all/batch.
 */

import type { PrimaryTrend4H, TrendStatus } from './types';

export interface PaperTrendResult {
  symbol: string;
  primaryTrend4H: PrimaryTrend4H;     // 'UP' | 'DOWN' | 'UNCLEAR'
  trendStatus: TrendStatus;            // 'CONTINUATION_CONFIRMED' | 'REVERSAL_WATCH' | 'CHOP' | ...
  rfColor: 'GREEN' | 'RED' | 'NONE';  // warna RF untuk audit trail
  rfValue: number | null;              // last close sebagai referensi
  fetchedAt: string;                   // ISO timestamp
  source: 'BINANCE_OHLCV' | 'FALLBACK_UNCLEAR';
}

// ─── Cache Layer ──────────────────────────────────────────────────────────────
const trendCache = new Map<string, { result: PaperTrendResult; expiresAt: number }>();
const TREND_CACHE_TTL_MS = 4 * 60 * 1000; // 4 menit — cukup untuk candle 4H

// ─── Delay antara request ─────────────────────────────────────────────────────
const FETCH_DELAY_MS = 200; // 200ms — mencegah rate limit Binance

// ─── Range Filter (ATR-based, minimal) ───────────────────────────────────────
/**
 * Hitung warna Range Filter dari OHLCV.
 * Versi minimal yang cukup untuk menentukan arah trend dominan 4H.
 * Bukan exact TradingView RF — approximasi untuk paper engine advisory.
 */
function computeRangeFilterColor(
  ohlcv: number[][],
  period: number = 14
): 'GREEN' | 'RED' | 'NONE' {
  if (ohlcv.length < period + 1) return 'NONE';

  // Hitung ATR sederhana
  const trValues: number[] = [];
  for (let i = 1; i < ohlcv.length; i++) {
    const high = ohlcv[i][2];
    const low  = ohlcv[i][3];
    const prevClose = ohlcv[i - 1][4];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trValues.push(tr);
  }

  const recentTRs = trValues.slice(-period);
  const atr = recentTRs.reduce((a, b) => a + b, 0) / recentTRs.length;

  const recentCloses = ohlcv.slice(-period).map(c => c[4]);
  const avgClose = recentCloses.reduce((a, b) => a + b, 0) / recentCloses.length;
  const lastClose = ohlcv[ohlcv.length - 1][4];

  const upperBand = avgClose + atr * 0.5;
  const lowerBand = avgClose - atr * 0.5;

  if (lastClose > upperBand) return 'GREEN';
  if (lastClose < lowerBand) return 'RED';
  return 'NONE';
}

// ─── TrendStatus dari RF + Momentum ──────────────────────────────────────────
function deriveTrendStatus(
  rfColor: 'GREEN' | 'RED' | 'NONE',
  ohlcv: number[][],
  lookback: number = 3
): TrendStatus {
  if (rfColor === 'NONE') return 'CHOP';

  const recentCloses = ohlcv.slice(-lookback - 1).map(c => c[4]);
  const isConsistent = rfColor === 'GREEN'
    ? recentCloses.every((c, i) => i === 0 || c >= recentCloses[i - 1] * 0.995)
    : recentCloses.every((c, i) => i === 0 || c <= recentCloses[i - 1] * 1.005);

  return isConsistent ? 'CONTINUATION_CONFIRMED' : 'REVERSAL_WATCH';
}

// ─── Fallback ─────────────────────────────────────────────────────────────────
function fallbackUnclear(symbol: string, timestamp: string): PaperTrendResult {
  return {
    symbol,
    primaryTrend4H: 'UNCLEAR',
    trendStatus: 'CHOP',
    rfColor: 'NONE',
    rfValue: null,
    fetchedAt: timestamp,
    source: 'FALLBACK_UNCLEAR',
  };
}

// ─── Core Fetch ───────────────────────────────────────────────────────────────
/**
 * Fetch trend data 4H untuk satu symbol.
 * Jika fetch gagal, return fallback UNCLEAR (tidak throw).
 */
export async function fetchPaperTrend(
  exchange: any,
  symbol: string
): Promise<PaperTrendResult> {
  const timestamp = new Date().toISOString();

  try {
    const ohlcv: number[][] = await exchange.fetchOHLCV(symbol, '4h', undefined, 50);

    if (!ohlcv || ohlcv.length < 15) {
      console.warn(`[RC-1] ${symbol}: OHLCV data insufficient (${ohlcv?.length ?? 0} candles) — fallback UNCLEAR`);
      return fallbackUnclear(symbol, timestamp);
    }

    const rfColor = computeRangeFilterColor(ohlcv);
    const trendStatus = deriveTrendStatus(rfColor, ohlcv);

    const primaryTrend4H: PrimaryTrend4H =
      rfColor === 'GREEN' ? 'UP' :
      rfColor === 'RED'   ? 'DOWN' :
      'UNCLEAR';

    console.log(`[RC-1] ${symbol}: RF=${rfColor} → trend=${primaryTrend4H} status=${trendStatus}`);

    return {
      symbol,
      primaryTrend4H,
      trendStatus,
      rfColor,
      rfValue: ohlcv[ohlcv.length - 1][4],
      fetchedAt: timestamp,
      source: 'BINANCE_OHLCV',
    };

  } catch (err: any) {
    console.error(`[RC-1] ${symbol}: fetch failed — fallback UNCLEAR |`, err?.message ?? err);
    return fallbackUnclear(symbol, timestamp);
  }
}

// ─── Cached Fetch ─────────────────────────────────────────────────────────────
export async function fetchPaperTrendCached(
  exchange: any,
  symbol: string
): Promise<PaperTrendResult> {
  const now = Date.now();
  const cached = trendCache.get(symbol);

  if (cached && now < cached.expiresAt) {
    const remainSec = Math.round((cached.expiresAt - now) / 1000);
    console.log(`[RC-1] ${symbol}: trend=${cached.result.primaryTrend4H} (cached, expires in ${remainSec}s)`);
    return cached.result;
  }

  const result = await fetchPaperTrend(exchange, symbol);
  trendCache.set(symbol, { result, expiresAt: now + TREND_CACHE_TTL_MS });
  return result;
}

// ─── Sequential Batch Fetch ───────────────────────────────────────────────────
/**
 * Fetch trend untuk banyak symbol secara SEQUENTIAL dengan delay 200ms.
 * WAJIB sequential — jangan diganti Promise.all/concurrent batch.
 */
export async function fetchPaperTrendBatch(
  exchange: any,
  symbols: string[]
): Promise<Map<string, PaperTrendResult>> {
  const results = new Map<string, PaperTrendResult>();

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const result = await fetchPaperTrendCached(exchange, symbol);
    results.set(symbol, result);

    if (i < symbols.length - 1) {
      await new Promise(resolve => setTimeout(resolve, FETCH_DELAY_MS));
    }
  }

  return results;
}

// ─── Debug Snapshot ───────────────────────────────────────────────────────────
export function getTrendCacheSnapshot(): Record<string, PaperTrendResult & { expiresAt: number }> {
  const snapshot: Record<string, PaperTrendResult & { expiresAt: number }> = {};
  trendCache.forEach((v, k) => {
    snapshot[k] = { ...v.result, expiresAt: v.expiresAt };
  });
  return snapshot;
}
