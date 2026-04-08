type Trend4H = 'UP' | 'DOWN' | 'UNCLEAR';
type TrendStatus =
  | 'CONTINUATION_CONFIRMED'
  | 'REVERSAL_WATCH'
  | 'REVERSAL_CONFIRMED_STRONG'
  | 'CHOP';

type ParityAction =
  | 'HOLD'
  | 'LOCK_NEUTRAL'
  | 'TAKE_PROFIT_DEFENSIVE'
  | 'ADD_0.5_LONG'
  | 'ADD_0.5_SHORT'
  | 'REDUCE_0.5_LONG'
  | 'REDUCE_0.5_SHORT'
  | 'UNLOCK'
  | 'REVERT_TO_1TO1'
  | 'FULL_CYCLE_EXIT'
  | 'PROTECTIVE_STOP_GREEN_LEG'
  | 'BLOCK_EXPANSION'
  | 'WAIT_AND_SEE'
  | 'OPEN_LONG'
  | 'OPEN_SHORT';

type ParityStructure =
  | 'NONE'
  | 'SINGLE'
  | 'LOCK_1TO1'
  | 'LONG_1P5_SHORT_1'
  | 'SHORT_1P5_LONG_1'
  | 'LONG_2_SHORT_1'
  | 'SHORT_2_LONG_1'
  | 'OTHER';

export interface RuntimePos {
  size: number;
  currentPnl?: number;
  pnlPct?: number;
  stopLoss?: number;
  signalId?: string;
  lastSignalId?: string;
  entryPrice?: number;
}

export interface PaperWalletLike {
  marginRatio?: number;
  isEmergencyDeRisking?: boolean;
}

export interface FreshSignalLike {
  id?: string;
  side?: string; // BUY / SELL
  trend?: {
    primary4H?: string;
    status?: string;
  };
  smc?: {
    validated?: boolean;
  };
}

export interface BuildParityInputArgs {
  symbol: string;
  currentPrice: number;
  freshSignal: FreshSignalLike | null | undefined;
  longPos: RuntimePos | null | undefined;
  shortPos: RuntimePos | null | undefined;
  wallet: PaperWalletLike;
  currentStructure: string;
  stopHedgeHit: boolean;
  historyHasSignal: boolean;
  signalAlreadyActed: boolean;
  mrProjected?: number;
}

export interface ParityEvalResult {
  final_action: string;
  fallback_action?: string;
  blocked_actions?: string[];
  operational_action?: string | null;
  actual_post_state?: any;
  why_allowed?: string | null;
  why_blocked?: string | null;
  audit_trail?: any[];
}

export function isParityV2Mode(): boolean {
  return process.env.PAPER_ENGINE_MODE === 'parity_v2';
}

function normalizePrimaryTrend4H(signal: FreshSignalLike | null | undefined): Trend4H {
  const raw = String(signal?.trend?.primary4H || '').toUpperCase().trim();
  if (raw === 'UP') return 'UP';
  if (raw === 'DOWN') return 'DOWN';
  return 'UNCLEAR';
}

function normalizeTrendStatus(signal: FreshSignalLike | null | undefined): TrendStatus {
  const raw = String(signal?.trend?.status || '').toUpperCase().trim();
  if (
    raw === 'CONTINUATION_CONFIRMED' ||
    raw === 'REVERSAL_WATCH' ||
    raw === 'REVERSAL_CONFIRMED_STRONG' ||
    raw === 'CHOP'
  ) {
    return raw as TrendStatus;
  }
  return 'CHOP';
}

function normalizeStructure(currentStructure: string): ParityStructure {
  const raw = String(currentStructure || '').toUpperCase().trim();

  if (raw === 'NONE') return 'NONE';
  if (raw === 'LONG_ONLY' || raw === 'SHORT_ONLY' || raw === 'SINGLE') return 'SINGLE';
  if (raw === 'LOCK_1TO1') return 'LOCK_1TO1';
  if (raw === 'LONG_1P5_SHORT_1') return 'LONG_1P5_SHORT_1';
  if (raw === 'SHORT_1P5_LONG_1') return 'SHORT_1P5_LONG_1';
  if (raw === 'LONG_2_SHORT_1') return 'LONG_2_SHORT_1';
  if (raw === 'SHORT_2_LONG_1') return 'SHORT_2_LONG_1';

  return 'OTHER';
}

function deriveLegState(
  longPos: RuntimePos | null | undefined,
  shortPos: RuntimePos | null | undefined
) {
  let GreenLeg: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
  let RedLeg: 'LONG' | 'SHORT' | 'NONE' = 'NONE';

  const longPnl = longPos?.currentPnl || 0;
  const shortPnl = shortPos?.currentPnl || 0;

  if (longPos && shortPos) {
    if (longPnl > 0 && shortPnl < 0) {
      GreenLeg = 'LONG';
      RedLeg = 'SHORT';
    } else if (shortPnl > 0 && longPnl < 0) {
      GreenLeg = 'SHORT';
      RedLeg = 'LONG';
    }
  } else if (longPos) {
    if (longPnl > 0) GreenLeg = 'LONG';
    else RedLeg = 'LONG';
  } else if (shortPos) {
    if (shortPnl > 0) GreenLeg = 'SHORT';
    else RedLeg = 'SHORT';
  }

  return { GreenLeg, RedLeg };
}

function deriveHedgeState(
  structure: ParityStructure,
  greenLeg: 'LONG' | 'SHORT' | 'NONE',
  redLeg: 'LONG' | 'SHORT' | 'NONE'
) {
  let HedgeLeg: 'LONG' | 'SHORT' | 'NONE' | 'AMBIGUOUS' = 'NONE';
  let HedgeLegStatus: 'HEDGE_FULL' | 'RESIDUAL_OPPOSING_LEG' | 'NONE' = 'NONE';
  const ambiguityFlags: string[] = [];

  if (structure === 'LOCK_1TO1') {
    HedgeLegStatus = 'HEDGE_FULL';

    // Untuk lock 1:1, identitas hedge leg hanya dianggap jelas jika ada satu hijau dan satu merah.
    if (greenLeg === 'LONG' && redLeg === 'SHORT') HedgeLeg = 'SHORT';
    else if (greenLeg === 'SHORT' && redLeg === 'LONG') HedgeLeg = 'LONG';
    else {
      HedgeLeg = 'AMBIGUOUS';
      ambiguityFlags.push('AMBIGUOUS_HEDGE_LEG');
    }
  } else if (structure === 'LONG_1P5_SHORT_1' || structure === 'LONG_2_SHORT_1') {
    HedgeLeg = 'SHORT';
    HedgeLegStatus = 'RESIDUAL_OPPOSING_LEG';
  } else if (structure === 'SHORT_1P5_LONG_1' || structure === 'SHORT_2_LONG_1') {
    HedgeLeg = 'LONG';
    HedgeLegStatus = 'RESIDUAL_OPPOSING_LEG';
  }

  return { HedgeLeg, HedgeLegStatus, ambiguityFlags };
}

function deriveRequestedAction(args: {
  structure: ParityStructure;
  freshSignal: FreshSignalLike | null | undefined;
  stopHedgeHit: boolean;
  signalAlreadyActed: boolean;
  historyHasSignal: boolean;
  wallet: PaperWalletLike;
  greenLeg: 'LONG' | 'SHORT' | 'NONE';
  redLeg: 'LONG' | 'SHORT' | 'NONE';
  longPos: RuntimePos | null | undefined;
  shortPos: RuntimePos | null | undefined;
}): ParityAction {
  const {
    structure,
    freshSignal,
    stopHedgeHit,
    signalAlreadyActed,
    historyHasSignal,
    wallet,
    greenLeg,
    redLeg,
    longPos,
    shortPos,
  } = args;

  if (wallet.isEmergencyDeRisking) return 'HOLD';

  if (structure === 'SINGLE' && stopHedgeHit) {
    return 'LOCK_NEUTRAL';
  }

  if (!freshSignal) return 'HOLD';
  if (signalAlreadyActed || historyHasSignal) return 'HOLD';

  const signalSide = String(freshSignal.side || '').toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';

  if (structure === 'NONE') {
    return signalSide === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT';
  }

  if (structure === 'LOCK_1TO1') {
    const trend = normalizePrimaryTrend4H(freshSignal);
    const trendStatus = normalizeTrendStatus(freshSignal);
    
    // Continuation add harus searah GreenLeg dan trend dominan
    // Jika tidak sinkron/ambigu, jatuh ke HOLD / defensive posture
    if (trendStatus === 'CONTINUATION_CONFIRMED') {
      if (signalSide === 'LONG' && greenLeg === 'LONG' && trend === 'UP') {
        return 'ADD_0.5_LONG';
      }
      if (signalSide === 'SHORT' && greenLeg === 'SHORT' && trend === 'DOWN') {
        return 'ADD_0.5_SHORT';
      }
    }
    
    return 'HOLD';
  }

  if (structure === 'LONG_1P5_SHORT_1' || structure === 'LONG_2_SHORT_1') {
    if (signalSide === 'SHORT') return 'REVERT_TO_1TO1';

    // unlock hanya jika hedge leg profit; minta adapter yang memutuskan finalnya
    if (shortPos && (shortPos.currentPnl || 0) > 0) return 'UNLOCK';
    return 'HOLD';
  }

  if (structure === 'SHORT_1P5_LONG_1' || structure === 'SHORT_2_LONG_1') {
    if (signalSide === 'LONG') return 'REVERT_TO_1TO1';

    if (longPos && (longPos.currentPnl || 0) > 0) return 'UNLOCK';
    return 'HOLD';
  }

  return 'HOLD';
}

export function buildParityInputState(args: BuildParityInputArgs) {
  const {
    symbol,
    currentPrice,
    freshSignal,
    longPos,
    shortPos,
    wallet,
    currentStructure,
    stopHedgeHit,
    historyHasSignal,
    signalAlreadyActed,
    mrProjected,
  } = args;

  const PrimaryTrend4H = normalizePrimaryTrend4H(freshSignal);
  const TrendStatus = normalizeTrendStatus(freshSignal);
  const Structure = normalizeStructure(currentStructure);

  const ambiguity_flags: string[] = [];

  if (!freshSignal?.trend?.primary4H || !freshSignal?.trend?.status) {
    ambiguity_flags.push('MISSING_TREND_METADATA');
  }

  if (!freshSignal?.smc) {
    ambiguity_flags.push('MISSING_SMC_METADATA');
  } else if (freshSignal.smc.validated === false) {
    ambiguity_flags.push('SMC_NOT_VALIDATED');
  }

  const { GreenLeg, RedLeg } = deriveLegState(longPos, shortPos);
  const { HedgeLeg, HedgeLegStatus, ambiguityFlags: hedgeAmbiguity } = deriveHedgeState(
    Structure,
    GreenLeg,
    RedLeg
  );

  ambiguity_flags.push(...hedgeAmbiguity);

  const requested_action = deriveRequestedAction({
    structure: Structure,
    freshSignal,
    stopHedgeHit,
    signalAlreadyActed,
    historyHasSignal,
    wallet,
    greenLeg: GreenLeg,
    redLeg: RedLeg,
    longPos,
    shortPos,
  });

  // ContextMode sengaja tidak dibangun agresif di sini.
  // Kalau belum jelas, biarkan konservatif / existing runtime mapping.
  const ContextMode =
    Structure === 'LOCK_1TO1'
      ? 'LOCK_WAIT_SEE'
      : Structure === 'LONG_2_SHORT_1' || Structure === 'SHORT_2_LONG_1'
        ? 'EXIT_READY'
        : 'CONTINUATION_RECOVERY';

  return {
    market: {
      symbol,
      price: currentPrice,
      PrimaryTrend4H,
      TrendStatus,
      ambiguity_flags,
      recovery_suspended: Boolean(wallet.isEmergencyDeRisking),
    },
    position: {
      requested_action,
      Structure,
      HedgeLeg,
      HedgeLegStatus,
      GreenLeg,
      RedLeg,
      ContextMode,
      stop_hedge_hit: stopHedgeHit,
      NearBEP: false,
    },
    risk: {
      MRProjected: typeof mrProjected === 'number' ? mrProjected : (wallet.marginRatio || 0) * 1.05,
    },
  };
}

export async function evaluateParityPaper(args: BuildParityInputArgs): Promise<{
  inputState: any;
  parityResult: ParityEvalResult;
}> {
  const inputState = buildParityInputState(args);

  // Pertahankan parity logic di adapter accepted, bukan di server.ts
  const { ParityAdapter } = await import('../../tests/parity/ParityAdapter.js');
  const parityResult = ParityAdapter.evaluate(inputState);

  return { inputState, parityResult };
}
