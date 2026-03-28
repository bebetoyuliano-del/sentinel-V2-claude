import { PolicyContext } from './PolicyContext';

export interface FinalAction {
  action: string;
  blocked_by?: string;
  reason?: string;
  original_action: string;
}

export class SopPolicy {
  static enforce(ctx: PolicyContext): FinalAction {
    const action = ctx.action.toUpperCase();
    const original_action = action;

    // 1. Ambiguous / Invalid Action
    if (!['LONG', 'SHORT', 'ADD_LONG', 'ADD_SHORT', 'REDUCE_LONG', 'REDUCE_SHORT', 'LOCK_LONG', 'LOCK_SHORT', 'UNLOCK_LONG', 'UNLOCK_SHORT', 'HOLD', 'TP', 'SL'].includes(action)) {
      return { action: 'HOLD', original_action, blocked_by: 'RISK_DENIED', reason: 'Action is ambiguous or not recognized.' };
    }

    // 2. No Cut Loss (SL is denied)
    if (action === 'SL') {
      return { action: 'HOLD', original_action, blocked_by: 'SOP_NO_CUTLOSS', reason: 'Cut loss is strictly prohibited. Use hedge/lock instead.' };
    }

    // 3. Lock 1:1 = HOLD
    if (ctx.isLocked11()) {
      if (['LONG', 'SHORT', 'ADD_LONG', 'ADD_SHORT', 'LOCK_LONG', 'LOCK_SHORT'].includes(action)) {
        return { action: 'HOLD', original_action, blocked_by: 'SOP_LOCKED_1_1', reason: 'Position is fully locked (1:1). Only UNLOCK or REDUCE is permitted.' };
      }
    }

    // 4. MR Constraints (NO_ADD if MR >= 25%)
    if (['LONG', 'SHORT', 'ADD_LONG', 'ADD_SHORT'].includes(action)) {
      const projectedMr = ctx.mrProjected !== null ? ctx.mrProjected : (ctx.accountMrDecimal || 0);
      if (projectedMr >= 0.25) {
        return { action: 'HOLD', original_action, blocked_by: 'SOP_MR_LIMIT', reason: `Margin Ratio projected (${(projectedMr * 100).toFixed(2)}%) exceeds hard guard of 25%.` };
      }
    }

    // 5. Reduce hanya jika leg hijau
    if (action === 'REDUCE_LONG' && !ctx.isLongGreen()) {
      return { action: 'HOLD', original_action, blocked_by: 'SOP_REDUCE_RED_LEG', reason: 'Cannot reduce LONG because the leg is not in profit.' };
    }
    if (action === 'REDUCE_SHORT' && !ctx.isShortGreen()) {
      return { action: 'HOLD', original_action, blocked_by: 'SOP_REDUCE_RED_LEG', reason: 'Cannot reduce SHORT because the leg is not in profit.' };
    }

    // 6. Unlock hanya jika hedge profit
    if (action === 'UNLOCK_LONG' && !ctx.isShortGreen()) { // Unlocking long means closing short hedge
      return { action: 'HOLD', original_action, blocked_by: 'SOP_UNLOCK_RED_HEDGE', reason: 'Cannot unlock LONG (close SHORT) because the hedge is not in profit.' };
    }
    if (action === 'UNLOCK_SHORT' && !ctx.isLongGreen()) { // Unlocking short means closing long hedge
      return { action: 'HOLD', original_action, blocked_by: 'SOP_UNLOCK_RED_HEDGE', reason: 'Cannot unlock SHORT (close LONG) because the hedge is not in profit.' };
    }

    // 7. ADD/ROLE hanya jika continuation confirmed (Simplified check based on trendStatus)
    if (action === 'ADD_LONG' && ctx.trendStatus !== 'UPTREND') {
      return { action: 'HOLD', original_action, blocked_by: 'SOP_ADD_AGAINST_TREND', reason: 'Cannot ADD_LONG unless trend is confirmed UPTREND.' };
    }
    if (action === 'ADD_SHORT' && ctx.trendStatus !== 'DOWNTREND') {
      return { action: 'HOLD', original_action, blocked_by: 'SOP_ADD_AGAINST_TREND', reason: 'Cannot ADD_SHORT unless trend is confirmed DOWNTREND.' };
    }

    // Default Fallback
    return { action, original_action };
  }
}
