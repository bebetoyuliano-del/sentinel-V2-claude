import { verifySignalPayload } from '../signal_gate';
import {
  GateVerdict,
  GateIssueCode,
  SentinelRule,
} from '../signal_gate_types';

// ---------------------------------------------------------------------------
// Baseline helper — returns a fully-valid normalizedParityInput
// ---------------------------------------------------------------------------

function buildValidInput(overrides?: {
  market?: Record<string, unknown>;
  position?: Record<string, unknown>;
  risk?: Record<string, unknown>;
}): any {
  return {
    market: {
      symbol: 'BTCUSDT',
      PrimaryTrend4H: 'UP',
      TrendStatus: 'CONTINUATION_CONFIRMED',
      ambiguity_flags: [],
      recovery_suspended: false,
      secondary_confirmation_count: 2,
      ...overrides?.market,
    },
    position: {
      Structure: 'LOCK_1TO1',
      GreenLeg: 'LONG',
      RedLeg: 'SHORT',
      HedgeLeg: 'SHORT',
      HedgeLegStatus: 'HEDGE_FULL',
      ContextMode: 'CONTINUATION_RECOVERY',
      requested_action: 'ADD_0.5_LONG',
      RiskOverride: 'NONE',
      stop_hedge_hit: false,
      NearBEP: false,
      ...overrides?.position,
    },
    risk: {
      MRProjected: 12,
      ...overrides?.risk,
    },
  };
}

// ---------------------------------------------------------------------------
// VALID FIXTURES — expect PASS
// ---------------------------------------------------------------------------

describe('VALID FIXTURES', () => {
  test('GV-01 — Valid continuation recovery → PASS', () => {
    const input = buildValidInput();
    const result = verifySignalPayload(null, input);

    expect(result.verificationStatus).toBe(GateVerdict.PASS);
    expect(result.safeToEvaluateInParity).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.sentinelRuleAtRisk).toHaveLength(0);
  });

  test('GV-02 — Valid revert to 1:1 → PASS', () => {
    const input = buildValidInput({
      market: {
        TrendStatus: 'REVERSAL_WATCH',
        PrimaryTrend4H: 'DOWN',
      },
      position: {
        Structure: 'LONG_2_SHORT_1',
        GreenLeg: 'LONG',
        RedLeg: 'SHORT',
        HedgeLeg: 'SHORT',
        HedgeLegStatus: 'RESIDUAL_OPPOSING_LEG',
        ContextMode: 'EXIT_READY',
        requested_action: 'REVERT_TO_1TO1',
        RiskOverride: 'NONE',
      },
    });

    const result = verifySignalPayload(null, input);

    expect(result.verificationStatus).toBe(GateVerdict.PASS);
    expect(result.safeToEvaluateInParity).toBe(true);
  });

  test('GV-03 — Valid CHOP defensive → PASS or WARN, safe', () => {
    const input = buildValidInput({
      market: {
        TrendStatus: 'CHOP',
        PrimaryTrend4H: 'UNCLEAR',
        recovery_suspended: true,
        ambiguity_flags: ['CHOP_CONDITION'],
      },
      position: {
        Structure: 'LOCK_1TO1',
        HedgeLegStatus: 'HEDGE_FULL',
        GreenLeg: 'LONG',
        RedLeg: 'SHORT',
        ContextMode: 'LOCK_WAIT_SEE',
        requested_action: 'HOLD',
        RiskOverride: 'NONE',
      },
    });

    const result = verifySignalPayload(null, input);

    expect([GateVerdict.PASS, GateVerdict.WARN]).toContain(result.verificationStatus);
    expect(result.safeToEvaluateInParity).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INVALID FIXTURES — expect FAIL / INSUFFICIENT
// ---------------------------------------------------------------------------

describe('INVALID FIXTURES', () => {
  test('GI-01 — Missing PrimaryTrend4H + TrendStatus + Structure → INSUFFICIENT', () => {
    const input = buildValidInput();
    delete input.market.PrimaryTrend4H;
    delete input.market.TrendStatus;
    delete input.position.Structure;

    const result = verifySignalPayload(null, input);

    expect(result.verificationStatus).toBe(GateVerdict.INSUFFICIENT);
    expect(result.safeToEvaluateInParity).toBe(false);
  });

  test('GI-02 — TrendStatus = "SIDEWAYS" (enum drift) → FAIL with ENUM_DRIFT', () => {
    const input = buildValidInput({
      market: { TrendStatus: 'SIDEWAYS' },
    });

    const result = verifySignalPayload(null, input);

    expect(result.verificationStatus).toBe(GateVerdict.FAIL);
    expect(result.safeToEvaluateInParity).toBe(false);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain(GateIssueCode.ENUM_DRIFT);
  });

  test('GI-03 — Golden Rule conflict: REDUCE_0.5_LONG with RedLeg LONG → FAIL', () => {
    const input = buildValidInput({
      position: {
        requested_action: 'REDUCE_0.5_LONG',
        GreenLeg: 'SHORT',
        RedLeg: 'LONG',
        HedgeLeg: 'LONG',
        HedgeLegStatus: 'RESIDUAL_OPPOSING_LEG',
        Structure: 'SHORT_1P5_LONG_1',
        ContextMode: 'REVERSAL_DEFENSE',
        RiskOverride: 'NONE',
      },
    });

    const result = verifySignalPayload(null, input);

    expect(result.verificationStatus).toBe(GateVerdict.FAIL);
    expect(result.safeToEvaluateInParity).toBe(false);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain(GateIssueCode.GOLDEN_RULE_CONFLICT);
    expect(result.sentinelRuleAtRisk).toContain(SentinelRule.GOLDEN_RULE);
  });

  test('GI-04 — MR > 25% + ADD request → FAIL with MR_BLOCK_CONDITION', () => {
    const input = buildValidInput({
      position: {
        requested_action: 'ADD_0.5_LONG',
        RiskOverride: 'MR_BLOCK',
      },
      risk: { MRProjected: 30 },
    });

    const result = verifySignalPayload(null, input);

    expect(result.verificationStatus).toBe(GateVerdict.FAIL);
    expect(result.safeToEvaluateInParity).toBe(false);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain(GateIssueCode.MR_BLOCK_CONDITION);
    expect(result.sentinelRuleAtRisk).toContain(SentinelRule.MR_GUARD);
  });

  test('GI-05 — Ambiguous structure: GreenLeg NONE + RedLeg NONE + Structure LOCK_1TO1 → issue AMBIGUOUS_INPUT', () => {
    const input = buildValidInput({
      position: {
        GreenLeg: 'NONE',
        RedLeg: 'NONE',
        Structure: 'LOCK_1TO1',
        HedgeLegStatus: 'HEDGE_FULL',
        requested_action: 'HOLD',
        RiskOverride: 'NONE',
      },
    });

    const result = verifySignalPayload(null, input);

    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain(GateIssueCode.AMBIGUOUS_INPUT);
    // safeToEvaluateInParity depends on verdict (WARN is acceptable)
    expect([GateVerdict.WARN, GateVerdict.FAIL]).toContain(result.verificationStatus);
  });

  test('GI-06 — Golden Rule: REDUCE_0.5_SHORT with RedLeg SHORT → FAIL', () => {
    const input = buildValidInput({
      market: { PrimaryTrend4H: 'UP' },
      position: {
        requested_action: 'REDUCE_0.5_SHORT',
        GreenLeg: 'LONG',
        RedLeg: 'SHORT',
        HedgeLeg: 'SHORT',
        HedgeLegStatus: 'RESIDUAL_OPPOSING_LEG',
        Structure: 'LONG_1P5_SHORT_1',
        ContextMode: 'REVERSAL_DEFENSE',
        RiskOverride: 'NONE',
      },
    });

    const result = verifySignalPayload(null, input);

    expect(result.verificationStatus).toBe(GateVerdict.FAIL);
    expect(result.safeToEvaluateInParity).toBe(false);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain(GateIssueCode.GOLDEN_RULE_CONFLICT);
    expect(result.sentinelRuleAtRisk).toContain(SentinelRule.GOLDEN_RULE);
  });

  test('GI-07A — Post-action reclassification minor (ADD_0.5_LONG, Structure SHORT_1P5_LONG_1) → WARN', () => {
    const rawSignal = { last_action: 'ADD_0.5_LONG' };
    const input = buildValidInput({
      position: {
        // SHORT_1P5_LONG_1 is not LOCK_1TO1 (no hard fail) but also not in
        // expectedAfterExpansion['ADD_0.5_LONG'] (['LONG_1P5_SHORT_1','LONG_2_SHORT_1'])
        // → soft mismatch → severity medium → WARN
        Structure: 'SHORT_1P5_LONG_1',
        HedgeLegStatus: 'RESIDUAL_OPPOSING_LEG',
        GreenLeg: 'SHORT',
        RedLeg: 'LONG',
        HedgeLeg: 'LONG',
        ContextMode: 'CONTINUATION_RECOVERY',
        requested_action: 'HOLD',
        RiskOverride: 'NONE',
      },
    });

    const result = verifySignalPayload(rawSignal, input);

    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain(GateIssueCode.RECLASSIFICATION_PENDING);
    expect(result.safeToEvaluateInParity).toBe(true);
    expect(result.verificationStatus).toBe(GateVerdict.WARN);
  });

  test('GI-07B — Post-action reclassification material (ADD_0.5_LONG, Structure still LOCK_1TO1) → FAIL', () => {
    const rawSignal = { last_action: 'ADD_0.5_LONG' };
    const input = buildValidInput({
      position: {
        Structure: 'LOCK_1TO1',
        HedgeLegStatus: 'HEDGE_FULL',
        ContextMode: 'LOCK_WAIT_SEE',
        requested_action: 'HOLD',
        RiskOverride: 'NONE',
      },
    });

    const result = verifySignalPayload(rawSignal, input);

    expect(result.verificationStatus).toBe(GateVerdict.FAIL);
    expect(result.safeToEvaluateInParity).toBe(false);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain(GateIssueCode.RECLASSIFICATION_PENDING);
    expect(result.sentinelRuleAtRisk).toContain(SentinelRule.RECLASSIFICATION_INTEGRITY);
  });
});
