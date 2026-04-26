export type TradeSide = 'LONG' | 'SHORT';
export type PositionStatus = 'OPEN' | 'CLOSED';

// === Import Annotation: Supervisor Override ===
/**
 * Supervisor annotation disertakan saat POST /api/paper/import-live.
 * Berlaku satu session saja — tidak persist setelah Reset Account.
 * Tidak mengubah SOP, Golden Rule, atau MR guard.
 */
export interface SupervisorAnnotation {
  symbol: string;
  /**
   * True jika hedge sengaja ditutup oleh supervisor (strategic unlock).
   * Efek: engine skip HEDGE_TRIGGER_HIT untuk symbol ini.
   */
  hedgeIntentionallyClosed: boolean;
  reason?: string;
  annotatedAt?: string;
}
// === END Import Annotation types ===

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
  leverage?: number;                   // leverage per posisi — dari config atau Import Live
  lastEmergencyDeRiskAt?: number;     // unix ms — BFX-1 cooldown tracker
  emergencyDeRiskCooldownMs?: number; // override default 300_000ms — BFX-1
  supervisorAnnotation?: SupervisorAnnotation; // Import Annotation — hedge intentionally closed override
  [key: string]: any; // Fallback aman untuk properti dinamis legacy
}

export interface PaperWallet {
  balance: number;
  equity: number;
  freeMargin: number;
  marginRatio?: number;
  updatedAt: string;
  isEmergencyDeRisking?: boolean;
  effectiveLeverage?: number; // calibrated from Binance at import — used for freeMargin computation
  effectiveMmr?: number;      // calibrated from Binance at import — used for MR computation
  peakEquity?: number;        // tracks all-time high equity for max drawdown guard
  maxDrawdownPct?: number;    // override threshold (default: MAX_DRAWDOWN_PCT env)
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

// ============================================================
// DECISION OUTPUT — Shared contract for Paper Engine + Telegram
// Added for Decision Card Parity (Section 4A)
// ============================================================

export interface DecisionOutput {
  symbol: string;
  market: 'futures';
  timestamp: string;
  structure: Structure;
  structureOrigin: StructureOrigin;
  primaryTrend4H: PrimaryTrend4H;
  trendStatus: TrendStatus;
  greenLeg: LegSide;
  redLeg: LegSide;
  hedgeLegStatus: HedgeLegStatus;
  mrNow: number;
  mrProjected: number | null;
  riskOverride: RiskOverride;
  contextMode: ContextMode;
  recommendedAction: CanonicalAction;
  reasoning: string;
  whyAllowed: string | null;
  whyBlocked: string | null;
  bepGrossPrice: number | null;
  bepType: 'GROSS' | 'NET' | 'UNKNOWN';
  sentinelRulesAtRisk: SentinelRuleAtRisk[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export type Structure =
  | 'NONE' | 'SINGLE' | 'LOCK_1TO1'
  | 'LONG_1P5_SHORT_1' | 'SHORT_1P5_LONG_1'
  | 'LONG_2_SHORT_1' | 'SHORT_2_LONG_1';

export type StructureOrigin =
  | 'HEDGE_TRIGGER' | 'EXPANSION' | 'REVERT' | 'INITIAL' | 'UNKNOWN';

export type PrimaryTrend4H = 'UP' | 'DOWN' | 'UNCLEAR';

export type TrendStatus =
  | 'CONTINUATION_CONFIRMED' | 'REVERSAL_WATCH'
  | 'REVERSAL_CONFIRMED_STRONG' | 'CHOP';

export type LegSide = 'LONG' | 'SHORT' | 'NONE';

export type HedgeLegStatus = 'HEDGE_FULL' | 'RESIDUAL_OPPOSING_LEG' | 'NONE';

export type RiskOverride =
  | 'NONE' | 'MR_BLOCK' | 'AMBIGUITY_BLOCK' | 'RECOVERY_SUSPENDED' | 'OTHER';

export type ContextMode =
  | 'CONTINUATION_RECOVERY' | 'REVERSAL_DEFENSE'
  | 'LOCK_WAIT_SEE' | 'EXIT_READY' | 'RISK_DENIED';

export type CanonicalAction =
  | 'HOLD' | 'LOCK_NEUTRAL' | 'TAKE_PROFIT_DEFENSIVE'
  | 'ADD_0.5_LONG' | 'ADD_0.5_SHORT'
  | 'REDUCE_0.5_LONG' | 'REDUCE_0.5_SHORT'
  | 'UNLOCK' | 'REVERT_TO_1TO1' | 'FULL_CYCLE_EXIT'
  | 'PROTECTIVE_STOP_GREEN_LEG' | 'BLOCK_EXPANSION' | 'WAIT_AND_SEE';

export type SentinelRuleAtRisk =
  | 'GOLDEN_RULE' | 'MR_GUARD' | 'AMBIGUITY_BLOCK'
  | 'RECOVERY_SUSPENDED' | 'RECLASSIFICATION_INTEGRITY';
