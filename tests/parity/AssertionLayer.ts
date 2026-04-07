export class AssertionLayer {
  static assertParity(expected: any, actual: any): { pass: boolean; errors: string[] } {
    const errors: string[] = [];

    // 1. Assert Final Action
    if (expected.final_action !== actual.final_action) {
      errors.push(`Final Action mismatch: Expected ${expected.final_action}, got ${actual.final_action}`);
    }

    // 2. Assert Fallback Action (if expected)
    if (expected.fallback_action && expected.fallback_action !== actual.fallback_action) {
      errors.push(`Fallback Action mismatch: Expected ${expected.fallback_action}, got ${actual.fallback_action}`);
    }

    // 3. Assert Blocked Actions
    if (expected.blocked_actions) {
      for (const action of expected.blocked_actions) {
        if (!actual.blocked_actions.includes(action)) {
          errors.push(`Missing blocked action: Expected ${action} to be blocked`);
        }
      }
    }

    // 4. Assert Post State
    if (expected.expected_post_state) {
      const expState = expected.expected_post_state;
      const actState = actual.actual_post_state;

      if (expState.Structure && expState.Structure !== actState.Structure) {
        errors.push(`Structure mismatch: Expected ${expState.Structure}, got ${actState.Structure}`);
      }
      if (expState.ContextMode && expState.ContextMode !== actState.ContextMode) {
        errors.push(`ContextMode mismatch: Expected ${expState.ContextMode}, got ${actState.ContextMode}`);
      }
      if (expState.HedgeLegStatus && expState.HedgeLegStatus !== actState.HedgeLegStatus) {
        errors.push(`HedgeLegStatus mismatch: Expected ${expState.HedgeLegStatus}, got ${actState.HedgeLegStatus}`);
      }
      if (expState.WhyBlocked && expState.WhyBlocked !== actual.why_blocked) {
        errors.push(`WhyBlocked mismatch: Expected ${expState.WhyBlocked}, got ${actual.why_blocked}`);
      }
      if (expState.GreenLeg && expState.GreenLeg !== actState.GreenLeg) {
        errors.push(`GreenLeg mismatch: Expected ${expState.GreenLeg}, got ${actState.GreenLeg}`);
      }
      if (expState.RedLeg && expState.RedLeg !== actState.RedLeg) {
        errors.push(`RedLeg mismatch: Expected ${expState.RedLeg}, got ${actState.RedLeg}`);
      }
      if (expState.RiskOverride && expState.RiskOverride !== actState.RiskOverride) {
        errors.push(`RiskOverride mismatch: Expected ${expState.RiskOverride}, got ${actState.RiskOverride}`);
      }
    }

    // 5. Assert Audit Trail
    if (!actual.audit_trail || actual.audit_trail.length === 0) {
      errors.push(`Audit trail is missing or empty`);
    } else {
      const audit = actual.audit_trail[0];
      if (!audit.action) errors.push(`Audit trail missing 'action'`);
      if (!audit.structure_before || !audit.structure_after) errors.push(`Audit trail missing 'structure' before/after`);
      if (!audit.context_mode_before || !audit.context_mode_after) errors.push(`Audit trail missing 'context_mode' before/after`);
      if (!audit.hedge_leg_status_before || !audit.hedge_leg_status_after) errors.push(`Audit trail missing 'hedge_leg_status' before/after`);
    }

    return {
      pass: errors.length === 0,
      errors
    };
  }
}
