/**
 * HF-3 — LOCK_EXIT_URGENCY Standalone Evaluator
 *
 * RC-3 Fix: evaluasi berjalan setiap siklus paper engine,
 * TIDAK bergantung freshSignal.
 *
 * Kondisi dari SOP Section 3B — JANGAN ubah konstanta tanpa approval supervisor.
 */

import type { PaperPosition } from './types';
import type { PaperTrendResult } from './paperTrendFetcher';

export type MarginBleedRisk = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export interface LockExitUrgencyResult {
  eligible: boolean;
  reason: string;

  checks: {
    isLock1To1: boolean;
    marginBleedRisk: MarginBleedRisk;
    mrAboveThreshold: boolean;
    trendIsUp: boolean;
    trendIsConfirmed: boolean;
    longLegIsGreen: boolean;
    mrAfterAddIsSafe: boolean;
    notInChop: boolean;
  };

  suggestedAddQty: number | null;
  mrProjectedAfterAdd: number | null;
}

// ─── Konstanta SOP 3B ────────────────────────────────────────────────────────
const MR_URGENCY_THRESHOLD     = 23;   // MRNow >= 23% → zona urgency
const MR_PROJECTED_UP2_THRESHOLD = 25; // MRProjected_Up2 >= 25% → urgency
const MR_HARD_CAP              = 25;   // MRProjected_after_add harus < 25%
const ADD_RATIO                = 0.5;  // ADD 0.5 × ActiveLockBaseQty

// ─── MarginBleedRisk ─────────────────────────────────────────────────────────
/**
 * Klasifikasi MarginBleedRisk berdasarkan MRNow dan proyeksi naik MR.
 * mrProjectedUp2 = perkiraan MR jika harga naik 2% (worst case SHORT bleed).
 */
export function classifyMarginBleedRisk(
  mrNow: number,
  mrProjectedUp2: number
): MarginBleedRisk {
  if (mrNow >= MR_URGENCY_THRESHOLD || mrProjectedUp2 >= MR_PROJECTED_UP2_THRESHOLD) {
    return 'HIGH';
  }
  if (mrNow >= 18) return 'MEDIUM';
  if (mrNow >= 15) return 'LOW';
  return 'NONE';
}

// ─── MR After Add ────────────────────────────────────────────────────────────
/**
 * Proyeksi MR setelah ADD_LONG_0.5.
 * Maintenance margin = 0.5% notional (konsisten dengan MARGIN-FIX-V2).
 */
export function computeMRAfterAdd(
  currentMR: number,
  addQty: number,
  entryPrice: number,
  equity: number
): number {
  if (equity <= 0) return 100;
  const additionalMargin = addQty * entryPrice * 0.005; // maintenance 0.5% of notional
  const currentMarginUsed = (currentMR / 100) * equity;
  const newMarginUsed = currentMarginUsed + additionalMargin;
  return (newMarginUsed / equity) * 100;
}

// ─── Evaluator Utama ─────────────────────────────────────────────────────────
/**
 * Evaluasi apakah kondisi LOCK_EXIT_URGENCY terpenuhi untuk suatu pair.
 *
 * STANDALONE — tidak bergantung freshSignal.
 * Semua 7 kondisi SOP 3B harus terpenuhi agar eligible.
 */
export function evaluateLockExitUrgency(
  longPos: PaperPosition,
  shortPos: PaperPosition,
  trendData: PaperTrendResult,
  mrNow: number,
  equity: number
): LockExitUrgencyResult {
  const symbol = longPos.symbol;

  // === Cek 1: Structure = LOCK_1TO1 ===
  const ratio = longPos.size > 0 && shortPos.size > 0
    ? longPos.size / shortPos.size
    : 0;
  const isLock1To1 = ratio >= 0.95 && ratio <= 1.05;

  if (!isLock1To1) {
    return notEligible(symbol, 'Structure bukan LOCK_1TO1', {
      isLock1To1: false, marginBleedRisk: 'NONE', mrAboveThreshold: false,
      trendIsUp: false, trendIsConfirmed: false, longLegIsGreen: false,
      mrAfterAddIsSafe: false, notInChop: false,
    });
  }

  // === Cek 2: MarginBleedRisk = HIGH ===
  const mrProjectedUp2 = mrNow * 1.04; // +2% harga ≈ +4% MR pada 20x leverage
  const marginBleedRisk = classifyMarginBleedRisk(mrNow, mrProjectedUp2);
  const mrAboveThreshold = marginBleedRisk === 'HIGH';

  if (!mrAboveThreshold) {
    return notEligible(symbol, `MarginBleedRisk=${marginBleedRisk}, belum HIGH`, {
      isLock1To1: true, marginBleedRisk, mrAboveThreshold: false,
      trendIsUp: false, trendIsConfirmed: false, longLegIsGreen: false,
      mrAfterAddIsSafe: false, notInChop: false,
    });
  }

  // === Cek 3: PrimaryTrend4H = UP ===
  const trendIsUp = trendData.primaryTrend4H === 'UP';

  if (!trendIsUp) {
    return notEligible(symbol, `PrimaryTrend4H=${trendData.primaryTrend4H}, bukan UP`, {
      isLock1To1: true, marginBleedRisk, mrAboveThreshold: true,
      trendIsUp: false, trendIsConfirmed: false, longLegIsGreen: false,
      mrAfterAddIsSafe: false, notInChop: false,
    });
  }

  // === Cek 4: TrendStatus = CONTINUATION_CONFIRMED ===
  const trendIsConfirmed = trendData.trendStatus === 'CONTINUATION_CONFIRMED';

  if (!trendIsConfirmed) {
    return notEligible(
      symbol,
      `TrendStatus=${trendData.trendStatus}, butuh CONTINUATION_CONFIRMED`,
      {
        isLock1To1: true, marginBleedRisk, mrAboveThreshold: true,
        trendIsUp: true, trendIsConfirmed: false, longLegIsGreen: false,
        mrAfterAddIsSafe: false, notInChop: true,
      }
    );
  }

  // === Cek 5: LONG leg profit (hijau) — Golden Rule ===
  const longPnl = (longPos as any).currentPnl ?? longPos.unrealizedPnl ?? 0;
  const longLegIsGreen = longPnl > 0;

  if (!longLegIsGreen) {
    return notEligible(symbol, `LONG leg merah (PnL=${longPnl.toFixed(2)}) — Golden Rule blok`, {
      isLock1To1: true, marginBleedRisk, mrAboveThreshold: true,
      trendIsUp: true, trendIsConfirmed: true, longLegIsGreen: false,
      mrAfterAddIsSafe: false, notInChop: true,
    });
  }

  // === Cek 6: Tidak dalam CHOP (sudah implied oleh Cek 4, explicit untuk audit) ===
  const notInChop = trendData.trendStatus !== 'CHOP';

  // === Cek 7: MRProjected_after_add < 25% ===
  const addQty = longPos.size * ADD_RATIO;
  const mrAfterAdd = computeMRAfterAdd(mrNow, addQty, longPos.entryPrice, equity);
  const mrAfterAddIsSafe = mrAfterAdd < MR_HARD_CAP;

  if (!mrAfterAddIsSafe) {
    return notEligible(
      symbol,
      `MRProjected_after_add=${mrAfterAdd.toFixed(2)}% >= 25% — blok ekspansi`,
      {
        isLock1To1: true, marginBleedRisk, mrAboveThreshold: true,
        trendIsUp: true, trendIsConfirmed: true, longLegIsGreen: true,
        mrAfterAddIsSafe: false, notInChop: true,
      }
    );
  }

  // === SEMUA KONDISI TERPENUHI ===
  console.log(
    `[HF-3] LOCK_EXIT_URGENCY ELIGIBLE: ${symbol} | ` +
    `MR=${mrNow.toFixed(1)}% | trend=UP CONFIRMED | LONG profit | ` +
    `addQty=${addQty.toFixed(4)} | MRafter=${mrAfterAdd.toFixed(2)}%`
  );

  return {
    eligible: true,
    reason: `LOCK_EXIT_URGENCY: MR=${mrNow.toFixed(1)}%, trend UP CONFIRMED, LONG hijau. ADD_LONG_0.5 diizinkan.`,
    checks: {
      isLock1To1: true, marginBleedRisk, mrAboveThreshold: true,
      trendIsUp: true, trendIsConfirmed: true, longLegIsGreen: true,
      mrAfterAddIsSafe: true, notInChop: true,
    },
    suggestedAddQty: addQty,
    mrProjectedAfterAdd: mrAfterAdd,
  };
}

// ─── Helper ───────────────────────────────────────────────────────────────────
function notEligible(
  symbol: string,
  reason: string,
  checks: LockExitUrgencyResult['checks']
): LockExitUrgencyResult {
  console.log(`[HF-3] LOCK_EXIT_URGENCY SKIP: ${symbol} — ${reason}`);
  return {
    eligible: false,
    reason,
    checks,
    suggestedAddQty: null,
    mrProjectedAfterAdd: null,
  };
}
