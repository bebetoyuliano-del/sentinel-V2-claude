/**
 * Step 1C-1b — Exit Logic Evaluator
 *
 * Isolated exit evaluation logic: TP Sentinel + BEP Full Cycle.
 * EVALUATE ONLY — tidak mengeksekusi apapun.
 *
 * Guards WAJIB:
 * - HF-1: isAtTP hanya valid jika currentPnl >= 0
 * - HF-2: BEP berbasis harga (price), bukan totalNetProfit > 0
 */

import type { PaperPosition } from './types';

export type ExitType =
  | 'TAKE_PROFIT_SENTINEL'  // TP target tercapai, posisi tunggal
  | 'BEP_FULL_CYCLE';       // BEP GROSS tercapai, close kedua kaki

export interface ExitDecision {
  type: ExitType;
  symbol: string;
  reason: string;
  positionsToClose: PaperPosition[]; // 1 pos untuk TP, 2 pos untuk BEP
  exitPrice: number;
  expectedPnl: number;
  bepGrossPrice?: number;
  timestamp: string;
}

// ─── Type 1: Take Profit Sentinel ────────────────────────────────────────────
/**
 * Evaluasi TP untuk posisi tunggal (SINGLE structure).
 *
 * HF-1 Guard: hanya close jika currentPnl >= 0.
 * Posisi MERAH tidak pernah di-close via TP (Golden Rule).
 */
export function evaluateTakeProfit(pos: PaperPosition): ExitDecision | null {
  if (!pos.takeProfit || pos.takeProfit <= 0) return null;
  if (pos.status !== 'OPEN') return null;

  const currentPrice = (pos as any).currentPrice ?? 0;
  const currentPnl = (pos as any).currentPnl ?? pos.unrealizedPnl ?? 0;

  // === HF-1 Guard ===
  if (currentPnl < 0) {
    console.log(`[1C-1b] TP SKIP: ${pos.symbol} ${pos.side} — currentPnl=${currentPnl.toFixed(2)} < 0 (HF-1 guard)`);
    return null;
  }

  const tpReached = pos.side === 'LONG'
    ? currentPrice >= pos.takeProfit
    : currentPrice <= pos.takeProfit;

  if (!tpReached) return null;

  console.log(
    `[1C-1b] TP HIT: ${pos.symbol} ${pos.side} | ` +
    `price=${currentPrice} vs TP=${pos.takeProfit} | pnl=${currentPnl.toFixed(2)}`
  );

  return {
    type: 'TAKE_PROFIT_SENTINEL',
    symbol: pos.symbol,
    reason: 'Take Profit (Sentinel Target)',
    positionsToClose: [pos],
    exitPrice: currentPrice,
    expectedPnl: currentPnl,
    timestamp: new Date().toISOString(),
  };
}

// ─── Type 2: BEP Gross Kalkulasi ─────────────────────────────────────────────
/**
 * Hitung BEP_GROSS_PRICE dari struktur 2:1.
 *
 * Formula SOP Section 8.1:
 * BEP_GROSS = ((Qty_Long × Entry_Long) - (Qty_Short × Entry_Short))
 *             / (Qty_Long - Qty_Short)
 *
 * Return null untuk LOCK_1TO1 (qty sama — BEP tidak applicable).
 */
export function computeBepGross(
  longPos: PaperPosition,
  shortPos: PaperPosition
): number | null {
  const qtyDiff = longPos.size - shortPos.size;

  // Guard: LOCK_1TO1 atau zero-division
  if (Math.abs(qtyDiff) < 0.0001) return null;

  const bep = ((longPos.size * longPos.entryPrice) - (shortPos.size * shortPos.entryPrice)) / qtyDiff;

  // Sanity check
  if (bep <= 0 || !isFinite(bep)) return null;

  return bep;
}

// ─── Type 2: BEP Full Cycle Exit ─────────────────────────────────────────────
/**
 * Evaluasi BEP Gross untuk pasangan LONG+SHORT.
 * Jika tercapai: close KEDUA kaki bersamaan.
 *
 * HF-2 Guard: BEP berbasis harga, bukan totalNetProfit.
 */
export function evaluateBepFullCycleExit(
  longPos: PaperPosition,
  shortPos: PaperPosition
): ExitDecision | null {
  if (longPos.status !== 'OPEN' || shortPos.status !== 'OPEN') return null;

  const bepGross = computeBepGross(longPos, shortPos);
  if (bepGross === null) return null;

  const currentPrice = (longPos as any).currentPrice ?? (shortPos as any).currentPrice ?? 0;
  if (currentPrice <= 0) return null;

  const isLongDominant = longPos.size > shortPos.size;
  const bepReached = isLongDominant
    ? currentPrice >= bepGross   // LONG_2_SHORT_1: harga naik ke BEP
    : currentPrice <= bepGross;  // SHORT_2_LONG_1: harga turun ke BEP

  if (!bepReached) return null;

  const longPnl = (longPos as any).currentPnl ?? longPos.unrealizedPnl ?? 0;
  const shortPnl = (shortPos as any).currentPnl ?? shortPos.unrealizedPnl ?? 0;
  const totalPnl = longPnl + shortPnl;

  console.log(
    `[1C-1b] BEP HIT: ${longPos.symbol} | ` +
    `price=${currentPrice} vs BEP=${bepGross.toFixed(6)} | ` +
    `longPnl=${longPnl.toFixed(2)} shortPnl=${shortPnl.toFixed(2)} total=${totalPnl.toFixed(2)}`
  );

  return {
    type: 'BEP_FULL_CYCLE',
    symbol: longPos.symbol,
    reason: 'Structural BEP Gross Reached (Hedge Resolved)',
    positionsToClose: [longPos, shortPos],  // KEDUA kaki wajib ditutup
    exitPrice: currentPrice,
    expectedPnl: totalPnl,
    bepGrossPrice: bepGross,
    timestamp: new Date().toISOString(),
  };
}

// ─── Entry Point: collectExitDecisions() ─────────────────────────────────────
/**
 * Kumpulkan semua ExitDecision dari posisi yang diberikan.
 * EVALUATE ONLY — tidak mengeksekusi apapun.
 *
 * Pattern: collect → execute terpisah di server.ts.
 */
export function collectExitDecisions(positions: PaperPosition[]): ExitDecision[] {
  const decisions: ExitDecision[] = [];
  const openPositions = positions.filter(p => p.status === 'OPEN');

  const bySymbol = new Map<string, PaperPosition[]>();
  for (const pos of openPositions) {
    const group = bySymbol.get(pos.symbol) ?? [];
    group.push(pos);
    bySymbol.set(pos.symbol, group);
  }

  for (const [symbol, group] of bySymbol.entries()) {
    const longPos = group.find(p => p.side === 'LONG');
    const shortPos = group.find(p => p.side === 'SHORT');

    if (longPos && shortPos) {
      // === Type 2: BEP Full Cycle (pair) ===
      const bepDecision = evaluateBepFullCycleExit(longPos, shortPos);
      if (bepDecision) {
        decisions.push(bepDecision);
        console.log(`[1C-1b] Collected BEP decision: ${symbol}`);
      }
    } else {
      // === Type 1: TP Sentinel (single position only) ===
      for (const pos of group) {
        const tpDecision = evaluateTakeProfit(pos);
        if (tpDecision) {
          decisions.push(tpDecision);
          console.log(`[1C-1b] Collected TP decision: ${symbol} ${pos.side}`);
        }
      }
    }
  }

  return decisions;
}
