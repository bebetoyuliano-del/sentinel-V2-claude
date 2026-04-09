/**
 * decisionNormalizer.ts
 * 
 * PURPOSE: Convert raw paper engine evaluation result into canonical DecisionOutput.
 * This is the ONLY place where raw → structured normalization happens.
 * 
 * GUARDRAILS:
 * - Read-only: does NOT modify paper engine state or live execution
 * - No side effects: no orders, no Firestore writes, no state mutation
 * - Paper-only seam: called after paper evaluator produces its result
 * - Canonical enums enforced: non-canonical values → fallback + warning
 * 
 * CONSUMED BY: Paper execution logger, Monitoring, Telegram Decision Card
 */

import {
  DecisionOutput,
  Structure,
  StructureOrigin,
  PrimaryTrend4H,
  TrendStatus,
  LegSide,
  HedgeLegStatus,
  RiskOverride,
  ContextMode,
  CanonicalAction,
  SentinelRuleAtRisk,
} from './types';

// ============================================================
// Raw input shape — matches what paper evaluator currently produces
// Adjust field names to match actual server.ts output
// ============================================================
export interface RawPaperDecision {
  symbol: string;
  structure?: string;
  structureOrigin?: string;
  primaryTrend4H?: string;
  trendStatus?: string;
  greenLeg?: string;
  redLeg?: string;
  hedgeLegStatus?: string;
  mrNow?: number;
  mrProjected?: number | null;
  riskOverride?: string;
  contextMode?: string;
  recommendedAction?: string;
  reasoning?: string;
  whyAllowed?: string | null;
  whyBlocked?: string | null;
  bepGrossPrice?: number | null;
  bepType?: string;
  confidence?: string;
  // Catch-all for extra fields from Gemini response
  [key: string]: unknown;
}

// ============================================================
// Canonical value maps — enforce SOP vocabulary
// ============================================================
const CANONICAL_STRUCTURES = new Set<Structure>([
  'NONE', 'SINGLE', 'LOCK_1TO1',
  'LONG_1P5_SHORT_1', 'SHORT_1P5_LONG_1',
  'LONG_2_SHORT_1', 'SHORT_2_LONG_1',
]);

const CANONICAL_TRENDS = new Set<PrimaryTrend4H>(['UP', 'DOWN', 'UNCLEAR']);

const CANONICAL_TREND_STATUS = new Set<TrendStatus>([
  'CONTINUATION_CONFIRMED', 'REVERSAL_WATCH',
  'REVERSAL_CONFIRMED_STRONG', 'CHOP',
]);

const CANONICAL_ACTIONS = new Set<CanonicalAction>([
  'HOLD', 'LOCK_NEUTRAL', 'TAKE_PROFIT_DEFENSIVE',
  'ADD_0.5_LONG', 'ADD_0.5_SHORT',
  'REDUCE_0.5_LONG', 'REDUCE_0.5_SHORT',
  'UNLOCK', 'REVERT_TO_1TO1', 'FULL_CYCLE_EXIT',
  'PROTECTIVE_STOP_GREEN_LEG', 'BLOCK_EXPANSION', 'WAIT_AND_SEE',
]);

const CANONICAL_CONTEXT_MODES = new Set<ContextMode>([
  'CONTINUATION_RECOVERY', 'REVERSAL_DEFENSE',
  'LOCK_WAIT_SEE', 'EXIT_READY', 'RISK_DENIED',
]);

const CANONICAL_HEDGE_STATUS = new Set<HedgeLegStatus>([
  'HEDGE_FULL', 'RESIDUAL_OPPOSING_LEG', 'NONE',
]);

const CANONICAL_RISK_OVERRIDES = new Set<RiskOverride>([
  'NONE', 'MR_BLOCK', 'AMBIGUITY_BLOCK', 'RECOVERY_SUSPENDED', 'OTHER',
]);

const CANONICAL_STRUCTURE_ORIGINS = new Set<StructureOrigin>([
  'HEDGE_TRIGGER', 'EXPANSION', 'REVERT', 'INITIAL', 'UNKNOWN',
]);

// ============================================================
// Normalizer warnings — collected for audit
// ============================================================
export interface NormalizationWarning {
  field: string;
  rawValue: unknown;
  normalizedTo: string;
  reason: string;
}

export interface NormalizationResult {
  decision: DecisionOutput;
  warnings: NormalizationWarning[];
}

// ============================================================
// Helper: safe canonical cast with fallback + warning
// ============================================================
function canonicalize<T extends string>(
  raw: string | undefined | null,
  canonical: Set<T>,
  fallback: T,
  field: string,
  warnings: NormalizationWarning[],
): T {
  if (!raw) {
    warnings.push({
      field,
      rawValue: raw,
      normalizedTo: fallback,
      reason: 'MISSING_FIELD',
    });
    return fallback;
  }

  const upper = raw.toUpperCase().trim() as T;

  if (canonical.has(upper)) {
    return upper;
  }

  warnings.push({
    field,
    rawValue: raw,
    normalizedTo: fallback,
    reason: 'ENUM_DRIFT',
  });
  return fallback;
}

// ============================================================
// Main normalizer function
// ============================================================
export function normalizeDecision(raw: RawPaperDecision): NormalizationResult {
  const warnings: NormalizationWarning[] = [];

  const decision: DecisionOutput = {
    symbol: raw.symbol || 'UNKNOWN',
    market: 'futures',
    timestamp: new Date().toISOString(),

    structure: canonicalize(
      raw.structure, CANONICAL_STRUCTURES, 'NONE', 'structure', warnings,
    ),
    structureOrigin: canonicalize(
      raw.structureOrigin, CANONICAL_STRUCTURE_ORIGINS, 'UNKNOWN', 'structureOrigin', warnings,
    ),

    primaryTrend4H: canonicalize(
      raw.primaryTrend4H, CANONICAL_TRENDS, 'UNCLEAR', 'primaryTrend4H', warnings,
    ),
    trendStatus: canonicalize(
      raw.trendStatus, CANONICAL_TREND_STATUS, 'CHOP', 'trendStatus', warnings,
    ),

    greenLeg: canonicalize(
      raw.greenLeg, new Set<LegSide>(['LONG', 'SHORT', 'NONE']), 'NONE', 'greenLeg', warnings,
    ),
    redLeg: canonicalize(
      raw.redLeg, new Set<LegSide>(['LONG', 'SHORT', 'NONE']), 'NONE', 'redLeg', warnings,
    ),
    hedgeLegStatus: canonicalize(
      raw.hedgeLegStatus, CANONICAL_HEDGE_STATUS, 'NONE', 'hedgeLegStatus', warnings,
    ),

    mrNow: typeof raw.mrNow === 'number' ? raw.mrNow : 0,
    mrProjected: typeof raw.mrProjected === 'number' ? raw.mrProjected : null,
    riskOverride: canonicalize(
      raw.riskOverride, CANONICAL_RISK_OVERRIDES, 'NONE', 'riskOverride', warnings,
    ),

    contextMode: canonicalize(
      raw.contextMode, CANONICAL_CONTEXT_MODES, 'LOCK_WAIT_SEE', 'contextMode', warnings,
    ),
    recommendedAction: canonicalize(
      raw.recommendedAction, CANONICAL_ACTIONS, 'HOLD', 'recommendedAction', warnings,
    ),
    reasoning: raw.reasoning || '',
    whyAllowed: raw.whyAllowed ?? null,
    whyBlocked: raw.whyBlocked ?? null,

    bepGrossPrice: typeof raw.bepGrossPrice === 'number' ? raw.bepGrossPrice : null,
    bepType: (raw.bepType === 'GROSS' || raw.bepType === 'NET')
      ? raw.bepType
      : 'UNKNOWN',

    sentinelRulesAtRisk: detectRulesAtRisk(raw, warnings),
    confidence: (raw.confidence === 'HIGH' || raw.confidence === 'MEDIUM' || raw.confidence === 'LOW')
      ? raw.confidence
      : 'LOW',
  };

  return { decision, warnings };
}

// ============================================================
// Detect SOP rules at risk from raw data
// ============================================================
function detectRulesAtRisk(
  raw: RawPaperDecision,
  warnings: NormalizationWarning[],
): SentinelRuleAtRisk[] {
  const risks: SentinelRuleAtRisk[] = [];

  // Golden Rule check: action targets red leg?
  const action = (raw.recommendedAction || '').toUpperCase();
  const redLeg = (raw.redLeg || '').toUpperCase();
  if (
    (action.includes('REDUCE') && redLeg === 'LONG' && action.includes('LONG')) ||
    (action.includes('REDUCE') && redLeg === 'SHORT' && action.includes('SHORT'))
  ) {
    risks.push('GOLDEN_RULE');
  }

  // MR Guard check
  if (typeof raw.mrProjected === 'number' && raw.mrProjected > 25) {
    if (action.includes('ADD')) {
      risks.push('MR_GUARD');
    }
  }

  // Ambiguity check — fallbacks triggered for critical fields
  const criticalFallbacks = warnings.filter(
    w => ['structure', 'primaryTrend4H', 'trendStatus', 'greenLeg', 'redLeg'].includes(w.field)
      && w.reason === 'MISSING_FIELD',
  );
  if (criticalFallbacks.length >= 2) {
    risks.push('AMBIGUITY_BLOCK');
  }

  // Recovery suspended check
  const override = (raw.riskOverride || '').toUpperCase();
  const trend = (raw.trendStatus || '').toUpperCase();
  if (override === 'RECOVERY_SUSPENDED' || trend === 'CHOP') {
    if (action.includes('ADD') || action.includes('EXPANSION')) {
      risks.push('RECOVERY_SUSPENDED');
    }
  }

  return risks;
}