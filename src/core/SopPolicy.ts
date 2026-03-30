import { PolicyContext } from './PolicyContext';

export interface FinalAction {
  action: string;
  blocked_by?: string;
  reason?: string;
  original_action: string;
}

export class SopPolicy {
  static enforce(ctx: PolicyContext): FinalAction {
    const rawAction = ctx.action.toUpperCase();
    const original_action = rawAction;

    // Map short codes to full action names for internal logic
    const actionMap: Record<string, string> = {
      'AL': 'ADD_LONG',
      'ADD_LONG': 'ADD_LONG',
      'AS': 'ADD_SHORT',
      'ADD_SHORT': 'ADD_SHORT',
      'RL': 'REDUCE_LONG',
      'REDUCE_LONG': 'REDUCE_LONG',
      'RS': 'REDUCE_SHORT',
      'REDUCE_SHORT': 'REDUCE_SHORT',
      'HO': 'HEDGE_ON',
      'HEDGE_ON': 'HEDGE_ON',
      'LN': 'LOCK_NEUTRAL',
      'LOCK_NEUTRAL': 'LOCK_NEUTRAL',
      'UL': 'UNLOCK',
      'UNLOCK': 'UNLOCK',
      'RR': 'ROLE',
      'ROLE': 'ROLE',
      'TP': 'TAKE_PROFIT',
      'TAKE_PROFIT': 'TAKE_PROFIT',
      'HOLD': 'HOLD',
      'SL': 'SL'
    };

    const action = actionMap[rawAction];

    // 1. Ambiguous / Invalid Action
    if (!action) {
      return { action: 'HOLD', original_action, blocked_by: 'RISK_DENIED', reason: `Action ${rawAction} is ambiguous or not recognized.` };
    }

    // 2. No Cut Loss (SL is denied)
    if (action === 'SL') {
      return { action: 'HOLD', original_action, blocked_by: 'SOP_NO_CUTLOSS', reason: 'Cut loss is strictly prohibited. Use hedge/lock instead.' };
    }

    // 3. Lock 1:1 = HOLD (If already locked 1:1, prevent adding more risk)
    if (ctx.isLocked11()) {
      if (['ADD_LONG', 'ADD_SHORT', 'HEDGE_ON', 'LOCK_NEUTRAL'].includes(action)) {
        return { action: 'HOLD', original_action, blocked_by: 'SOP_LOCKED_1_1', reason: 'Position is fully locked (1:1). Only UNLOCK, REDUCE, or TP is permitted.' };
      }
    }

    // 4. MR Constraints (NO_ADD if MR >= 25%)
    // Only ADD_LONG and ADD_SHORT increase risk.
    // HEDGE_ON and LOCK_NEUTRAL reduce or maintain risk (they add to the opposite leg).
    // ROLE closes the primary leg, which reduces risk.
    if (['ADD_LONG', 'ADD_SHORT'].includes(action)) {
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
    if (action === 'UNLOCK') {
      if (ctx.isNetLong() && !ctx.isShortGreen()) {
        return { action: 'HOLD', original_action, blocked_by: 'SOP_UNLOCK_RED_HEDGE', reason: 'Cannot unlock (close SHORT hedge) because the hedge is not in profit.' };
      }
      if (ctx.isNetShort() && !ctx.isLongGreen()) {
        return { action: 'HOLD', original_action, blocked_by: 'SOP_UNLOCK_RED_HEDGE', reason: 'Cannot unlock (close LONG hedge) because the hedge is not in profit.' };
      }
    }

    // 7. ADD/ROLE/HEDGE_ON hanya jika continuation confirmed (Simplified check based on trendStatus)
    if (action === 'ADD_LONG' && ctx.trendStatus !== 'UPTREND') {
      return { action: 'HOLD', original_action, blocked_by: 'SOP_ADD_AGAINST_TREND', reason: 'Cannot ADD_LONG unless trend is confirmed UPTREND.' };
    }
    if (action === 'ADD_SHORT' && ctx.trendStatus !== 'DOWNTREND') {
      return { action: 'HOLD', original_action, blocked_by: 'SOP_ADD_AGAINST_TREND', reason: 'Cannot ADD_SHORT unless trend is confirmed DOWNTREND.' };
    }
    if (action === 'ROLE') {
      if (ctx.isNetLong() && ctx.trendStatus !== 'DOWNTREND') {
        return { action: 'HOLD', original_action, blocked_by: 'SOP_ROLE_AGAINST_TREND', reason: 'Cannot ROLE (promote SHORT) unless trend is confirmed DOWNTREND.' };
      }
      if (ctx.isNetShort() && ctx.trendStatus !== 'UPTREND') {
        return { action: 'HOLD', original_action, blocked_by: 'SOP_ROLE_AGAINST_TREND', reason: 'Cannot ROLE (promote LONG) unless trend is confirmed UPTREND.' };
      }
    }
    if (action === 'HEDGE_ON') {
      if (ctx.isNetLong() && ctx.trendStatus !== 'DOWNTREND') {
        return { action: 'HOLD', original_action, blocked_by: 'SOP_HEDGE_AGAINST_TREND', reason: 'Cannot HEDGE_ON (add SHORT) unless trend is confirmed DOWNTREND. Use LOCK_NEUTRAL instead for immediate freeze.' };
      }
      if (ctx.isNetShort() && ctx.trendStatus !== 'UPTREND') {
        return { action: 'HOLD', original_action, blocked_by: 'SOP_HEDGE_AGAINST_TREND', reason: 'Cannot HEDGE_ON (add LONG) unless trend is confirmed UPTREND. Use LOCK_NEUTRAL instead for immediate freeze.' };
      }
    }

    // Default Fallback: Return the original action (e.g. 'AL' or 'ADD_LONG') so server.ts can process it
    return { action: original_action, original_action };
  }
}
