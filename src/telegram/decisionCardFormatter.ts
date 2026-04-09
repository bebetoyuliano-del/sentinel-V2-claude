/**
 * decisionCardFormatter.ts
 *
 * PURPOSE: Format DecisionOutput → Telegram-readable card string.
 *
 * THIS IS A PRESENTER ONLY:
 * - No decision logic
 * - No action classification
 * - No SOP evaluation
 * - No state mutation
 *
 * Input: DecisionOutput (from decisionNormalizer.ts)
 * Output: Formatted string for Telegram message
 */

import { DecisionOutput, SentinelRuleAtRisk } from '../paper-engine/types';

// ============================================================
// Emoji maps for visual clarity in Telegram
// ============================================================
const ACTION_EMOJI: Record<string, string> = {
  'HOLD': '⏸️',
  'LOCK_NEUTRAL': '🔒',
  'TAKE_PROFIT_DEFENSIVE': '💰',
  'ADD_0.5_LONG': '📈',
  'ADD_0.5_SHORT': '📉',
  'REDUCE_0.5_LONG': '⬇️',
  'REDUCE_0.5_SHORT': '⬆️',
  'UNLOCK': '🔓',
  'REVERT_TO_1TO1': '↩️',
  'FULL_CYCLE_EXIT': '🏁',
  'PROTECTIVE_STOP_GREEN_LEG': '🛡️',
  'BLOCK_EXPANSION': '🚫',
  'WAIT_AND_SEE': '👀',
};

const CONTEXT_EMOJI: Record<string, string> = {
  'CONTINUATION_RECOVERY': '🟢',
  'REVERSAL_DEFENSE': '🟡',
  'LOCK_WAIT_SEE': '🔵',
  'EXIT_READY': '🏁',
  'RISK_DENIED': '🔴',
};

const RISK_EMOJI: Record<string, string> = {
  'GOLDEN_RULE': '🚨',
  'MR_GUARD': '⚠️',
  'AMBIGUITY_BLOCK': '❓',
  'RECOVERY_SUSPENDED': '⛔',
  'RECLASSIFICATION_INTEGRITY': '🔄',
};

// ============================================================
// Main formatter
// ============================================================
export function formatDecisionCard(d: DecisionOutput): string {
  const actionEmoji = ACTION_EMOJI[d.recommendedAction] || '❔';
  const ctxEmoji = CONTEXT_EMOJI[d.contextMode] || '⚪';

  const lines: string[] = [];

  // Header
  lines.push(`${actionEmoji} <b>${d.symbol}</b> — ${d.recommendedAction.replace(/_/g, ' ')}`);
  lines.push('');

  // Structure & Trend
  lines.push(`<b>Structure:</b> ${d.structure} (${d.structureOrigin})`);
  lines.push(`<b>Trend 4H:</b> ${d.primaryTrend4H} — ${d.trendStatus.replace(/_/g, ' ')}`);
  lines.push(`${ctxEmoji} <b>Mode:</b> ${d.contextMode.replace(/_/g, ' ')}`);
  lines.push('');

  // Position
  lines.push(`<b>Green Leg:</b> ${d.greenLeg} | <b>Red Leg:</b> ${d.redLeg}`);
  lines.push(`<b>Hedge:</b> ${d.hedgeLegStatus.replace(/_/g, ' ')}`);
  lines.push('');

  // Risk
  const mrStatus = d.mrNow >= 25 ? '🔴' : d.mrNow >= 15 ? '🟡' : '🟢';
  lines.push(`${mrStatus} <b>MR:</b> ${d.mrNow.toFixed(2)}%`);
  if (d.mrProjected !== null) {
    lines.push(`<b>MR Projected:</b> ${d.mrProjected.toFixed(2)}%`);
  }
  if (d.riskOverride !== 'NONE') {
    lines.push(`⚠️ <b>Override:</b> ${d.riskOverride}`);
  }

  // BEP (if applicable)
  if (d.bepGrossPrice !== null) {
    lines.push('');
    lines.push(`<b>BEP (${d.bepType}):</b> $${d.bepGrossPrice.toFixed(4)}`);
  }

  // Reasoning
  if (d.reasoning) {
    lines.push('');
    lines.push(`<b>Reasoning:</b> ${d.reasoning}`);
  }

  // Why blocked/allowed
  if (d.whyBlocked) {
    lines.push(`🚫 <b>Blocked:</b> ${d.whyBlocked}`);
  }
  if (d.whyAllowed) {
    lines.push(`✅ <b>Allowed:</b> ${d.whyAllowed}`);
  }

  // Rules at risk
  if (d.sentinelRulesAtRisk.length > 0) {
    lines.push('');
    lines.push('<b>Rules at Risk:</b>');
    for (const rule of d.sentinelRulesAtRisk) {
      lines.push(`  ${RISK_EMOJI[rule] || '⚠️'} ${rule}`);
    }
  }

  // Confidence
  lines.push('');
  const confEmoji = d.confidence === 'HIGH' ? '🟢' : d.confidence === 'MEDIUM' ? '🟡' : '🔴';
  lines.push(`${confEmoji} Confidence: ${d.confidence}`);

  // Timestamp
  lines.push(`<i>${d.timestamp}</i>`);

  return lines.join('\n');
}

// ============================================================
// Compact format for multi-pair summary
// ============================================================
export function formatDecisionCardCompact(d: DecisionOutput): string {
  const actionEmoji = ACTION_EMOJI[d.recommendedAction] || '❔';
  const mrStatus = d.mrNow >= 25 ? '🔴' : d.mrNow >= 15 ? '🟡' : '🟢';

  return [
    `${actionEmoji} <b>${d.symbol}</b>: ${d.recommendedAction.replace(/_/g, ' ')}`,
    `  ${d.structure} | ${d.primaryTrend4H} ${d.trendStatus} | ${mrStatus} MR ${d.mrNow.toFixed(1)}%`,
    d.sentinelRulesAtRisk.length > 0
      ? `  ⚠️ ${d.sentinelRulesAtRisk.join(', ')}`
      : null,
  ].filter(Boolean).join('\n');
}
