// Signal Payload Verification Gate — Implementation
// Phase 2: Pure read-only gate logic. No mutations, no side effects.

import {
  GateVerdict,
  GateIssueCode,
  SentinelRule,
  GateIssue,
  GateResult,
  VALID_PRIMARY_TREND_4H,
  VALID_TREND_STATUS,
  VALID_STRUCTURE,
  VALID_HEDGE_LEG_STATUS,
  VALID_CONTEXT_MODE,
  VALID_ACTIONS,
} from './signal_gate_types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPlainObject(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function issue(
  code: GateIssueCode,
  severity: GateIssue['severity'],
  path: string,
  message: string,
  expected?: unknown,
  actual?: unknown
): GateIssue {
  const g: GateIssue = { code, severity, path, message };
  if (expected !== undefined) g.expected = expected;
  if (actual !== undefined) g.actual = actual;
  return g;
}

// ---------------------------------------------------------------------------
// Check 1 — Presence / Completeness
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS: Array<{ path: string; get: (n: any) => unknown }> = [
  { path: 'market.symbol',        get: (n) => n?.market?.symbol },
  { path: 'market.PrimaryTrend4H', get: (n) => n?.market?.PrimaryTrend4H },
  { path: 'market.TrendStatus',   get: (n) => n?.market?.TrendStatus },
  { path: 'position.Structure',   get: (n) => n?.position?.Structure },
  { path: 'position.GreenLeg',    get: (n) => n?.position?.GreenLeg },
  { path: 'position.RedLeg',      get: (n) => n?.position?.RedLeg },
  { path: 'position.HedgeLegStatus', get: (n) => n?.position?.HedgeLegStatus },
];

function checkPresence(
  normalized: any,
  issues: GateIssue[]
): { missingCount: number; flaggedPaths: Set<string> } {
  // flaggedPaths: paths already reported as MISSING_FIELD or EMPTY_VALUE.
  // checkEnums will skip these to avoid double-reporting (F-3).
  const flaggedPaths = new Set<string>();

  if (!isPlainObject(normalized)) {
    issues.push(issue(
      GateIssueCode.MISSING_FIELD, 'high',
      'normalizedParityInput',
      'normalizedParityInput is null, undefined, or not an object',
      'object', normalized
    ));
    return { missingCount: REQUIRED_FIELDS.length, flaggedPaths };
  }

  let missingCount = 0;

  for (const field of REQUIRED_FIELDS) {
    const val = field.get(normalized);

    if (val === undefined || val === null) {
      issues.push(issue(
        GateIssueCode.MISSING_FIELD, 'high',
        field.path,
        `Required field '${field.path}' is missing`,
        'non-null value', val
      ));
      flaggedPaths.add(field.path);
      missingCount++;
      continue;
    }

    if (typeof val === 'string' && val.trim() === '') {
      issues.push(issue(
        GateIssueCode.EMPTY_VALUE, 'high',
        field.path,
        `Required field '${field.path}' is empty string`,
        'non-empty string', val
      ));
      flaggedPaths.add(field.path);
      missingCount++;
    }
  }

  return { missingCount, flaggedPaths };
}

// ---------------------------------------------------------------------------
// Check 2 — Canonical Enum Validation
// ---------------------------------------------------------------------------

function checkEnums(
  normalized: any,
  issues: GateIssue[],
  flaggedPaths: Set<string>  // F-3: skip fields already reported by checkPresence
): void {
  const m = normalized?.market;
  const p = normalized?.position;

  const enumChecks: Array<{
    path: string;
    value: unknown;
    valid: readonly string[];
  }> = [
    {
      path: 'market.PrimaryTrend4H',
      value: m?.PrimaryTrend4H,
      valid: VALID_PRIMARY_TREND_4H,
    },
    {
      path: 'market.TrendStatus',
      value: m?.TrendStatus,
      valid: VALID_TREND_STATUS,
    },
    {
      path: 'position.Structure',
      value: p?.Structure,
      valid: VALID_STRUCTURE,
    },
    {
      path: 'position.HedgeLegStatus',
      value: p?.HedgeLegStatus,
      valid: VALID_HEDGE_LEG_STATUS,
    },
  ];

  // Optional fields — only check if present
  if (p?.ContextMode !== undefined && p?.ContextMode !== null) {
    enumChecks.push({
      path: 'position.ContextMode',
      value: p.ContextMode,
      valid: VALID_CONTEXT_MODE,
    });
  }

  if (p?.requested_action !== undefined && p?.requested_action !== null) {
    enumChecks.push({
      path: 'position.requested_action',
      value: p.requested_action,
      valid: VALID_ACTIONS,
    });
  }

  for (const check of enumChecks) {
    // F-3: skip if already reported as MISSING_FIELD or EMPTY_VALUE
    if (flaggedPaths.has(check.path)) continue;
    if (check.value === undefined || check.value === null) continue;
    if (!check.valid.includes(check.value as string)) {
      issues.push(issue(
        GateIssueCode.ENUM_DRIFT, 'high',
        check.path,
        `'${check.path}' value '${check.value}' is not a canonical enum value`,
        check.valid,
        check.value
      ));
    }
  }
}

// ---------------------------------------------------------------------------
// Check 3 — Shape / Mapping
// ---------------------------------------------------------------------------

function checkShape(normalized: any, issues: GateIssue[]): void {
  for (const key of ['market', 'position', 'risk'] as const) {
    if (!isPlainObject(normalized?.[key])) {
      issues.push(issue(
        GateIssueCode.SHAPE_MISMATCH, 'high',
        key,
        `'${key}' must be a plain object`,
        'object', normalized?.[key]
      ));
    }
  }

  const mrProjected = normalized?.risk?.MRProjected;
  if (mrProjected !== undefined && mrProjected !== null && typeof mrProjected !== 'number') {
    issues.push(issue(
      GateIssueCode.TYPE_MISMATCH, 'high',
      'risk.MRProjected',
      `'risk.MRProjected' must be a number`,
      'number', typeof mrProjected
    ));
  }
}

// ---------------------------------------------------------------------------
// Check 4 — Semantic Consistency
// ---------------------------------------------------------------------------

function checkSemantics(
  normalized: any,
  issues: GateIssue[],
  rules: Set<SentinelRule>
): void {
  const m = normalized?.market;
  const p = normalized?.position;
  const r = normalized?.risk;

  // Structure LOCK_1TO1 should always have HedgeLegStatus HEDGE_FULL
  if (p?.Structure === 'LOCK_1TO1' && p?.HedgeLegStatus !== 'HEDGE_FULL') {
    issues.push(issue(
      GateIssueCode.MAPPING_GAP, 'medium',
      'position.HedgeLegStatus',
      `Structure is LOCK_1TO1 but HedgeLegStatus is '${p?.HedgeLegStatus}', expected HEDGE_FULL`,
      'HEDGE_FULL', p?.HedgeLegStatus
    ));
  }

  // Both legs NONE but structure implies active positions
  if (
    p?.GreenLeg === 'NONE' &&
    p?.RedLeg === 'NONE' &&
    p?.Structure !== 'NONE' &&
    p?.Structure !== 'SINGLE'
  ) {
    issues.push(issue(
      GateIssueCode.AMBIGUOUS_INPUT, 'medium',
      'position.GreenLeg / position.RedLeg',
      `GreenLeg and RedLeg are both NONE but Structure is '${p?.Structure}'`,
      'at least one leg defined', 'NONE/NONE'
    ));
  }

  // CHOP should be accompanied by ambiguity flags or recovery_suspended
  if (
    m?.TrendStatus === 'CHOP' &&
    (!Array.isArray(m?.ambiguity_flags) || m.ambiguity_flags.length === 0) &&
    m?.recovery_suspended !== true
  ) {
    issues.push(issue(
      GateIssueCode.INSUFFICIENT_CONTEXT, 'medium',
      'market.TrendStatus',
      `TrendStatus is CHOP but no ambiguity_flags and recovery_suspended is not true`,
      'ambiguity_flags or recovery_suspended', 'neither present'
    ));
  }

  // F-2: actions blocked by RECOVERY_SUSPENDED: ADD_*, UNLOCK, REVERT_TO_1TO1
  const riskOverride = p?.RiskOverride;
  const requestedAction: string = p?.requested_action ?? '';

  const isExpansionOrUnlock =
    requestedAction.startsWith('ADD_') ||
    requestedAction === 'UNLOCK' ||
    requestedAction === 'REVERT_TO_1TO1';

  if (riskOverride === 'RECOVERY_SUSPENDED' && isExpansionOrUnlock) {
    issues.push(issue(
      GateIssueCode.RECOVERY_SUSPENDED_CONDITION, 'high',
      'position.requested_action',
      `requested_action '${requestedAction}' conflicts with RiskOverride RECOVERY_SUSPENDED`,
      'non-expansion action', requestedAction
    ));
    rules.add(SentinelRule.RECOVERY_SUSPENDED);
  }

  // F-2: CHOP + UNLOCK → warn (ParityAdapter Gate 4 handles block; gate signals intent risk)
  if (m?.TrendStatus === 'CHOP' && requestedAction === 'UNLOCK') {
    issues.push(issue(
      GateIssueCode.AMBIGUOUS_INPUT, 'medium',
      'position.requested_action',
      `requested_action UNLOCK with TrendStatus CHOP is likely to be blocked by Recovery Suspended Gate`,
      'HOLD or LOCK_NEUTRAL', requestedAction
    ));
  }

  // MRProjected > 25 + ADD_* → MR_GUARD violation
  const mrProjected: number | undefined = r?.MRProjected;
  if (typeof mrProjected === 'number' && mrProjected > 25 && requestedAction.startsWith('ADD_')) {
    issues.push(issue(
      GateIssueCode.MR_BLOCK_CONDITION, 'high',
      'risk.MRProjected',
      `MRProjected ${mrProjected.toFixed(2)}% exceeds 25% but requested_action is '${requestedAction}'`,
      '<= 25', mrProjected
    ));
    rules.add(SentinelRule.MR_GUARD);
  }
}

// ---------------------------------------------------------------------------
// Check 5 — Golden Rule
// ---------------------------------------------------------------------------

function checkGoldenRule(
  normalized: any,
  issues: GateIssue[],
  rules: Set<SentinelRule>
): void {
  const p = normalized?.position;
  const requestedAction: string = p?.requested_action ?? '';
  const redLeg: string = p?.RedLeg ?? 'NONE';
  const hedgeLeg: string = p?.HedgeLeg ?? 'NONE';

  let violated = false;

  if (requestedAction === 'REDUCE_0.5_LONG' && redLeg === 'LONG') {
    issues.push(issue(
      GateIssueCode.GOLDEN_RULE_CONFLICT, 'high',
      'position.requested_action',
      `GOLDEN RULE: REDUCE_0.5_LONG requested but RedLeg is LONG (reducing losing leg)`,
      'GreenLeg target only', 'LONG is RedLeg'
    ));
    violated = true;
  }

  if (requestedAction === 'REDUCE_0.5_SHORT' && redLeg === 'SHORT') {
    issues.push(issue(
      GateIssueCode.GOLDEN_RULE_CONFLICT, 'high',
      'position.requested_action',
      `GOLDEN RULE: REDUCE_0.5_SHORT requested but RedLeg is SHORT (reducing losing leg)`,
      'GreenLeg target only', 'SHORT is RedLeg'
    ));
    violated = true;
  }

  if (requestedAction === 'UNLOCK') {
    if (hedgeLeg === 'LONG' && redLeg === 'LONG') {
      issues.push(issue(
        GateIssueCode.GOLDEN_RULE_CONFLICT, 'high',
        'position.requested_action',
        `GOLDEN RULE: UNLOCK requested but HedgeLeg LONG is also RedLeg (unlocking losing hedge)`,
        'HedgeLeg must be GreenLeg to unlock', 'HedgeLeg LONG is RedLeg'
      ));
      violated = true;
    }
    if (hedgeLeg === 'SHORT' && redLeg === 'SHORT') {
      issues.push(issue(
        GateIssueCode.GOLDEN_RULE_CONFLICT, 'high',
        'position.requested_action',
        `GOLDEN RULE: UNLOCK requested but HedgeLeg SHORT is also RedLeg (unlocking losing hedge)`,
        'HedgeLeg must be GreenLeg to unlock', 'HedgeLeg SHORT is RedLeg'
      ));
      violated = true;
    }
  }

  if (violated) {
    rules.add(SentinelRule.GOLDEN_RULE);
  }
}

// ---------------------------------------------------------------------------
// Check 6 — Reclassification Integrity
// ---------------------------------------------------------------------------

function checkReclassification(
  rawSignal: any,
  normalized: any,
  issues: GateIssue[],
  rules: Set<SentinelRule>
): void {
  const lastAction: string | undefined = rawSignal?.last_action;
  const execHistory: unknown[] | undefined = rawSignal?.execution_history;

  let lastRecorded: string | undefined;

  if (Array.isArray(execHistory) && execHistory.length > 0) {
    const lastEntry = execHistory[execHistory.length - 1] as any;
    const entryAction: unknown = lastEntry?.action;

    if (!isNonEmptyString(entryAction)) {
      // F-5: entry exists but .action is missing or empty — warn rather than silently skip
      issues.push(issue(
        GateIssueCode.INSUFFICIENT_CONTEXT, 'low',
        'rawSignal.execution_history',
        `Last execution_history entry has no valid 'action' field — reclassification check skipped`,
        'entry with .action string', lastEntry
      ));
      return;
    }

    lastRecorded = entryAction as string;
  } else {
    lastRecorded = lastAction;
  }

  if (!isNonEmptyString(lastRecorded)) return;

  const structure: string = normalized?.position?.Structure ?? 'NONE';

  const expansionActions = ['ADD_0.5_LONG', 'ADD_0.5_SHORT'];
  const expectedAfterExpansion: Record<string, string[]> = {
    'ADD_0.5_LONG':  ['LONG_1P5_SHORT_1', 'LONG_2_SHORT_1'],
    'ADD_0.5_SHORT': ['SHORT_1P5_LONG_1', 'SHORT_2_LONG_1'],
  };

  if (expansionActions.includes(lastRecorded!)) {
    const validNext = expectedAfterExpansion[lastRecorded!];
    if (structure === 'LOCK_1TO1') {
      // Hard mismatch — ADD executed but structure still LOCK_1TO1
      issues.push(issue(
        GateIssueCode.RECLASSIFICATION_PENDING, 'high',
        'position.Structure',
        `last_action was '${lastRecorded}' but Structure is still LOCK_1TO1 — post-action reclassification may not have run`,
        validNext.join(' or '), structure
      ));
      rules.add(SentinelRule.RECLASSIFICATION_INTEGRITY);
    } else if (!validNext.includes(structure)) {
      // Soft mismatch — structure changed but to unexpected value
      issues.push(issue(
        GateIssueCode.RECLASSIFICATION_PENDING, 'medium',
        'position.Structure',
        `last_action was '${lastRecorded}' but Structure '${structure}' is unexpected — verify reclassification logic`,
        validNext.join(' or '), structure
      ));
      rules.add(SentinelRule.RECLASSIFICATION_INTEGRITY);
    }
  }
}

// ---------------------------------------------------------------------------
// Verdict determination
// ---------------------------------------------------------------------------

function determineVerdict(issues: GateIssue[], missingCount: number): GateVerdict {
  if (missingCount >= 3) return GateVerdict.INSUFFICIENT;

  const hasFailCode = issues.some(
    (i) =>
      i.severity === 'high' &&
      (
        i.code === GateIssueCode.GOLDEN_RULE_CONFLICT ||
        i.code === GateIssueCode.MR_BLOCK_CONDITION ||
        i.code === GateIssueCode.RECOVERY_SUSPENDED_CONDITION ||
        i.code === GateIssueCode.RECLASSIFICATION_PENDING ||
        i.code === GateIssueCode.ENUM_DRIFT ||
        i.code === GateIssueCode.SHAPE_MISMATCH ||
        i.code === GateIssueCode.TYPE_MISMATCH ||
        i.code === GateIssueCode.MISSING_FIELD ||
        i.code === GateIssueCode.EMPTY_VALUE
      )
  );

  if (hasFailCode) return GateVerdict.FAIL;

  const hasAnyIssue = issues.length > 0;
  if (hasAnyIssue) return GateVerdict.WARN;

  return GateVerdict.PASS;
}

// ---------------------------------------------------------------------------
// Build audit hints from collected issues and rules
// ---------------------------------------------------------------------------

function buildAuditHints(
  issues: GateIssue[],
  rules: Set<SentinelRule>,
  verdict: GateVerdict
): { whySafe: string[]; whyBlocked: string[] } {
  const whySafe: string[] = [];
  const whyBlocked: string[] = [];

  if (verdict === GateVerdict.PASS) {
    whySafe.push('All presence, enum, shape, semantic, and golden-rule checks passed');
  } else if (verdict === GateVerdict.WARN) {
    whySafe.push('No hard failures — minor inconsistencies detected; safe to proceed with caution');
  }

  for (const i of issues) {
    if (i.severity === 'high') {
      whyBlocked.push(`[${i.code}] ${i.path}: ${i.message}`);
    }
  }

  for (const rule of rules) {
    whyBlocked.push(`Sentinel rule at risk: ${rule}`);
  }

  return { whySafe, whyBlocked };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function verifySignalPayload(
  rawSignalPayload: any,
  normalizedParityInput: any
): GateResult {
  const issues: GateIssue[] = [];
  const sentinelRules = new Set<SentinelRule>();

  // 1. Presence / Completeness
  const { missingCount, flaggedPaths } = checkPresence(normalizedParityInput, issues);

  if (missingCount >= 3) {
    const verdict = GateVerdict.INSUFFICIENT;
    return {
      verificationStatus: verdict,
      safeToEvaluateInParity: false,
      issues,
      sentinelRuleAtRisk: [],
      summary: {
        symbol: normalizedParityInput?.market?.symbol ?? 'UNKNOWN',
        market: 'FUTURES',
        timeframe: '4H',
      },
      auditHints: buildAuditHints(issues, sentinelRules, verdict),
      timestamp: new Date().toISOString(),
    };
  }

  // 2. Canonical Enum (F-3: pass flaggedPaths to skip double-reporting)
  checkEnums(normalizedParityInput, issues, flaggedPaths);

  // 3. Shape / Mapping
  checkShape(normalizedParityInput, issues);

  // 4. Semantic Consistency
  checkSemantics(normalizedParityInput, issues, sentinelRules);

  // 5. Golden Rule
  checkGoldenRule(normalizedParityInput, issues, sentinelRules);

  // 6. Reclassification Integrity
  checkReclassification(rawSignalPayload, normalizedParityInput, issues, sentinelRules);

  // Verdict
  const verdict = determineVerdict(issues, missingCount);
  const safeToEvaluateInParity = verdict === GateVerdict.PASS || verdict === GateVerdict.WARN;

  return {
    verificationStatus: verdict,
    safeToEvaluateInParity,
    issues,
    sentinelRuleAtRisk: Array.from(sentinelRules),
    summary: {
      symbol: normalizedParityInput?.market?.symbol ?? 'UNKNOWN',
      market: 'FUTURES',
      timeframe: '4H',
    },
    auditHints: buildAuditHints(issues, sentinelRules, verdict),
    timestamp: new Date().toISOString(),
  };
}
