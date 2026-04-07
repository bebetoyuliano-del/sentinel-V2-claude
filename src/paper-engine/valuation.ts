import type { PaperPosition, PaperWallet } from './types';

/**
 * Calculates the margin used by a single position based on current notional value.
 * Uses Binance Hedge Mode logic.
 */
export function calculateMarginUsed(pos: PaperPosition, leverage: number): number {
  const entryNotional = pos.size * pos.entryPrice;
  const pnl = pos.currentPnl !== undefined ? pos.currentPnl : (pos.unrealizedPnl || 0);
  const currentNotional = pos.side === 'LONG' ? entryNotional + pnl : entryNotional - pnl;
  return Math.max(0, currentNotional) / leverage;
}

/**
 * Computes the projected Margin Ratio (MR) if a specific position size is added.
 */
export function computeMRProjectedAfterAdd(
  wallet: PaperWallet,
  openPositions: PaperPosition[],
  posToModifyId: string,
  additionalSize: number,
  currentPrice: number,
  leverage: number
): number {
  let totalProjectedMargin = 0;
  let targetFound = false;
  
  for (const p of openPositions) {
    if (p.status === 'OPEN') {
      if (p.id === posToModifyId) {
        // Target position: Use projected margin (size + additional) * currentPrice / leverage
        totalProjectedMargin += ((p.size + additionalSize) * currentPrice) / leverage;
        targetFound = true;
      } else {
        // Non-target position: Use currentPrice if available, fallback to calculateMarginUsed
        if (p.currentPrice !== undefined && p.currentPrice !== null) {
          totalProjectedMargin += (p.size * p.currentPrice) / leverage;
        } else {
          totalProjectedMargin += calculateMarginUsed(p, leverage);
        }
      }
    }
  }
  
  // If posToModifyId is not found (e.g., new entry), add projected margin
  if (!targetFound) {
    totalProjectedMargin += (additionalSize * currentPrice) / leverage;
  }
  
  const equity = (wallet.equity && wallet.equity > 0) ? wallet.equity : wallet.balance;
  return equity > 0 ? (totalProjectedMargin / equity) * 100 : 0;
}
