export type TradeSide = 'LONG' | 'SHORT';
export type PositionStatus = 'OPEN' | 'CLOSED';

export interface PaperPosition {
  id: string;
  symbol: string;
  side: TradeSide;
  entryPrice: number;
  size: number;
  unrealizedPnl: number;
  currentPnl?: number;
  currentPrice?: number;
  takeProfit: number;
  stopLoss: number;
  status: PositionStatus;
  openedAt: string;
  isHedge?: boolean;
  journalId?: string;
  [key: string]: any; // Fallback aman untuk properti dinamis legacy
}

export interface PaperWallet {
  balance: number;
  equity: number;
  freeMargin: number;
  marginRatio?: number;
  updatedAt: string;
  isEmergencyDeRisking?: boolean;
}

export interface PaperHistory {
  id: string;
  symbol: string;
  side: TradeSide;
  entryPrice: number;
  size: number;
  exitPrice: number;
  pnl: number;
  reason: string;
  closedAt: string;
  status: PositionStatus;
  [key: string]: any; // Fallback untuk properti dari PaperPosition yang mungkin ikut tersimpan
}
