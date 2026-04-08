import { verifySignalPayload } from '../../src/paper-engine/signal_gate';

export class ParityAdapter {
  static evaluate(inputState: any): any {
    const { market, position, risk } = inputState;
    const requestedAction = position.requested_action || "HOLD";
    
    const result: any = {
      final_action: "HOLD",
      fallback_action: "HOLD",
      blocked_actions: [],
      actual_post_state: { ...position },
      why_blocked: null,
      why_allowed: null,
      audit_trail: []
    };

    const addAudit = (action: string, before: any, after: any, whyAllowed?: string, whyBlocked?: string) => {
      result.audit_trail.push({
        action,
        structure_before: before.Structure,
        structure_after: after.Structure,
        context_mode_before: before.ContextMode,
        context_mode_after: after.ContextMode,
        hedge_leg_status_before: before.HedgeLegStatus,
        hedge_leg_status_after: after.HedgeLegStatus,
        why_allowed: whyAllowed || null,
        why_blocked: whyBlocked || null
      });
    };

    let currentAction = requestedAction;
    let whyBlocked = null;
    let whyAllowed = null;
    let riskOverride = "NONE";
    let isBlocked = false;
    let operationalAction = null;

    // 1. Golden Rule Gate (Highest Priority)
    if (!isBlocked) {
      if (currentAction === "REDUCE_0.5_LONG" && position.RedLeg === "LONG") {
        result.blocked_actions.push(currentAction);
        currentAction = "HOLD";
        whyBlocked = "GOLDEN_RULE_NO_REDUCE_ON_RED_LEG";
        isBlocked = true;
      }
      if (currentAction === "REDUCE_0.5_SHORT" && position.RedLeg === "SHORT") {
        result.blocked_actions.push(currentAction);
        currentAction = "HOLD";
        whyBlocked = "GOLDEN_RULE_NO_REDUCE_ON_RED_LEG";
        isBlocked = true;
      }
      if (currentAction === "UNLOCK") {
        if (position.HedgeLeg === "LONG" && position.RedLeg === "LONG") {
          result.blocked_actions.push(currentAction);
          currentAction = "HOLD";
          whyBlocked = "GOLDEN_RULE_NO_UNLOCK_RED_HEDGE";
          isBlocked = true;
        }
        if (position.HedgeLeg === "SHORT" && position.RedLeg === "SHORT") {
          result.blocked_actions.push(currentAction);
          currentAction = "HOLD";
          whyBlocked = "GOLDEN_RULE_NO_UNLOCK_RED_HEDGE";
          isBlocked = true;
        }
      }
      if (currentAction === "REVERT_TO_1TO1" && position.operational_action) {
        if ((position.operational_action === "REDUCE_0.5_LONG" && position.RedLeg === "LONG") ||
            (position.operational_action === "REDUCE_0.5_SHORT" && position.RedLeg === "SHORT")) {
          result.blocked_actions.push("REVERT_TO_1TO1", position.operational_action);
          currentAction = "HOLD";
          whyBlocked = "GOLDEN_RULE_NO_REDUCE_RED_LEG";
          isBlocked = true;
        }
      }
    }

    // 2. MR Guard Gate
    if (!isBlocked && risk.MRProjected > 25) {
      if (currentAction.includes("ADD") || currentAction.includes("UNLOCK")) {
        result.blocked_actions.push(currentAction);
        currentAction = "HOLD";
        whyBlocked = "MR_GUARD_EXCEEDED";
        riskOverride = "MR_BLOCK";
        isBlocked = true;
      }
    }

    // 3. Ambiguity Gate
    if (!isBlocked && market.ambiguity_flags && market.ambiguity_flags.length > 0) {
      const hasMissingSmc = market.ambiguity_flags.includes('MISSING_SMC_METADATA');
      const hasSmcNotValidated = market.ambiguity_flags.includes('SMC_NOT_VALIDATED');
      const supportCount = market.secondary_confirmation_count || 0;
      
      const otherFlags = market.ambiguity_flags.filter((f: string) => f !== 'SMC_NOT_VALIDATED');

      let shouldBlock = false;
      let blockReason = "AMBIGUOUS_MARKET";

      if (hasMissingSmc) {
        if (currentAction !== "HOLD" && currentAction !== "LOCK_NEUTRAL" && !currentAction.startsWith("REDUCE")) {
          shouldBlock = true;
          blockReason = "MISSING_SMC_METADATA";
        }
      } else if (otherFlags.length > 0) {
        if (currentAction !== "HOLD" && currentAction !== "LOCK_NEUTRAL" && !currentAction.startsWith("REDUCE")) {
          shouldBlock = true;
          blockReason = otherFlags[0];
        }
      } else if (hasSmcNotValidated) {
        const isFreshEntry = position.Structure === 'NONE' && (currentAction === 'OPEN_LONG' || currentAction === 'OPEN_SHORT');
        const canPassFreshEntry =
          isFreshEntry &&
          market.TrendStatus === 'CONTINUATION_CONFIRMED' &&
          supportCount >= 2;

        if (!canPassFreshEntry) {
          if (currentAction !== "HOLD" && currentAction !== "LOCK_NEUTRAL" && !currentAction.startsWith("REDUCE")) {
            shouldBlock = true;
            blockReason = "SMC_NOT_VALIDATED";
          }
        } else {
          whyAllowed = "SMC present but not validated; support score passed";
        }
      }

      if (shouldBlock) {
        result.blocked_actions.push(currentAction);
        currentAction = "HOLD";
        whyBlocked = blockReason;
        riskOverride = "AMBIGUITY_BLOCK";
        isBlocked = true;
      }
    }

    // 4. Chop / Recovery Suspended Gate
    if (!isBlocked && (market.recovery_suspended === true || market.TrendStatus === "CHOP")) {
      if (currentAction.includes("ADD") || currentAction.includes("UNLOCK")) {
        result.blocked_actions.push(currentAction);
        currentAction = "HOLD";
        whyBlocked = "RECOVERY_SUSPENDED";
        riskOverride = "RECOVERY_SUSPENDED";
        isBlocked = true;
      }
    }

    // 5. Signal Payload Verification Gate
    // Active only when called from parity_v2 path. Runs AFTER all Sentinel guards
    // (Golden Rule, MR, Ambiguity, Chop) and BEFORE routing logic.
    // FAIL / INSUFFICIENT → force HOLD safe posture, do not route.
    // PASS / WARN         → proceed to routing as normal.
    if (!isBlocked && process.env.PAPER_ENGINE_MODE === 'parity_v2') {
      const rawSignalPayload = (inputState as any)._rawSignal ?? null;
      const gateResult = verifySignalPayload(rawSignalPayload, inputState);

      console.log('[SIGNAL_GATE]', JSON.stringify({
        symbol:              inputState?.market?.symbol,
        verificationStatus:  gateResult.verificationStatus,
        safeToEvaluate:      gateResult.safeToEvaluateInParity,
        issueCount:          gateResult.issues.length,
        sentinelRulesAtRisk: gateResult.sentinelRuleAtRisk,
        auditHints:          gateResult.auditHints,
        timestamp:           gateResult.timestamp,
      }));

      if (!gateResult.safeToEvaluateInParity) {
        result.blocked_actions.push(currentAction);
        currentAction = 'HOLD';
        whyBlocked = `SIGNAL_GATE_${gateResult.verificationStatus}`;
        isBlocked = true;
      }
    }

    // 6. Routing Logic (Only if not blocked)
    if (!isBlocked) {
      if (position.stop_hedge_hit === true && position.Structure === "SINGLE") {
        currentAction = "LOCK_NEUTRAL";
        result.blocked_actions.push("IMMEDIATE_UNLOCK", "IMMEDIATE_ADD_0.5_LONG", "IMMEDIATE_ADD_0.5_SHORT");
        whyAllowed = "HEDGE_TRIGGER_HIT";
      } else if (position.Structure === "LOCK_1TO1" && market.TrendStatus === "REVERSAL_CONFIRMED_STRONG") {
        if (position.GreenLeg === "LONG" && position.RedLeg === "SHORT") {
          currentAction = "REDUCE_0.5_LONG";
          result.blocked_actions.push("REDUCE_0.5_SHORT", "CUT_SHORT", "DIRECT_ADD_0.5_SHORT_WITHOUT_REDUCE_PHASE");
          whyAllowed = "REVERSAL_DEFENSE_REDUCE_GREEN";
        }
      } else if (position.Structure === "LONG_2_SHORT_1" && position.NearBEP === true && position.ContextMode === "EXIT_READY") {
        currentAction = "FULL_CYCLE_EXIT";
        result.blocked_actions.push("REVERT_TO_1TO1_WITHOUT_REASON", "ADD_0.5_LONG_EXTRA", "REDUCE_0.5_SHORT_RED_LEG");
        whyAllowed = "FULL_CYCLE_EXIT_NEAR_BEP";
      } else if (position.Structure === "LOCK_1TO1" && position.ContextMode === "CONTINUATION_RECOVERY" && market.TrendStatus === "CONTINUATION_CONFIRMED") {
        if (currentAction === "ADD_0.5_LONG" && position.GreenLeg === "LONG") {
          result.blocked_actions.push("REDUCE_0.5_SHORT", "CUT_SHORT", "UNLOCK");
          whyAllowed = "CONTINUATION_RECOVERY_ADD_GREEN_LEG";
        } else if (currentAction === "ADD_0.5_SHORT" && position.GreenLeg === "SHORT") {
          result.blocked_actions.push("REDUCE_0.5_LONG", "CUT_LONG", "UNLOCK");
          whyAllowed = "CONTINUATION_RECOVERY_ADD_GREEN_LEG";
        }
      } else if (currentAction === "REVERT_TO_1TO1" && market.TrendStatus === "REVERSAL_CONFIRMED_STRONG") {
        if (position.GreenLeg === "LONG") {
          operationalAction = "REDUCE_0.5_LONG";
          result.blocked_actions.push("ADD_0.5_LONG", "UNLOCK");
          whyAllowed = "REVERT_VIA_REDUCE_GREEN_LEG";
        } else if (position.GreenLeg === "SHORT") {
          operationalAction = "REDUCE_0.5_SHORT";
          result.blocked_actions.push("ADD_0.5_SHORT", "UNLOCK");
          whyAllowed = "REVERT_VIA_REDUCE_GREEN_LEG";
        }
      }
    }

    result.final_action = currentAction;
    if (operationalAction) {
      result.operational_action = operationalAction;
    }
    result.why_blocked = whyBlocked;
    result.why_allowed = whyAllowed;

    // Post-Action Reclassification
    let postState = { ...position };
    postState.RiskOverride = riskOverride;
    
    if (currentAction === "LOCK_NEUTRAL") {
      postState.Structure = "LOCK_1TO1";
      postState.ContextMode = "LOCK_WAIT_SEE";
      postState.HedgeLegStatus = "HEDGE_FULL";
      postState.GreenLeg = "NONE";
      postState.RedLeg = "NONE";
      if (postState.long?.qty) postState.short = { qty: postState.long.qty };
    } else if (currentAction === "REDUCE_0.5_LONG" && position.Structure === "LONG_1P5_SHORT_1") {
      postState.Structure = "LOCK_1TO1"; 
      postState.ContextMode = "CONTINUATION_RECOVERY";
      postState.HedgeLegStatus = "HEDGE_FULL";
    } else if (currentAction === "REDUCE_0.5_LONG" && position.Structure === "LOCK_1TO1") {
      postState.Structure = "LONG_1P5_SHORT_1"; 
      postState.ContextMode = "REVERSAL_DEFENSE";
      postState.HedgeLegStatus = "RESIDUAL_OPPOSING_LEG";
    } else if (currentAction === "FULL_CYCLE_EXIT") {
      postState.Structure = "NONE";
      postState.ContextMode = "WAIT_AND_SEE";
      postState.GreenLeg = "NONE";
      postState.RedLeg = "NONE";
      postState.HedgeLegStatus = "NONE";
    } else if (currentAction === "ADD_0.5_LONG" && position.Structure === "LOCK_1TO1") {
      postState.Structure = "LONG_1P5_SHORT_1";
      postState.ContextMode = "CONTINUATION_RECOVERY";
      postState.HedgeLegStatus = "RESIDUAL_OPPOSING_LEG";
    } else if (currentAction === "REVERT_TO_1TO1") {
      postState.Structure = "LOCK_1TO1";
      postState.ContextMode = "REVERSAL_DEFENSE";
      postState.HedgeLegStatus = "HEDGE_FULL";
    }

    if (whyBlocked) {
      postState.WhyBlocked = whyBlocked;
    }
    if (whyAllowed) {
      postState.WhyAllowed = whyAllowed;
    }

    result.actual_post_state = postState;

    addAudit(
      result.final_action,
      position,
      postState,
      result.why_allowed,
      result.why_blocked
    );

    return result;
  }
}
