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
      if (currentAction !== "HOLD" && currentAction !== "LOCK_NEUTRAL" && !currentAction.startsWith("REDUCE")) {
        result.blocked_actions.push(currentAction);
        currentAction = "HOLD";
        whyBlocked = "AMBIGUOUS_MARKET";
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

    // 5. Routing Logic (Only if not blocked)
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
