import { buildCallbackData } from '../utils/ActionParsers';

export function escapeHtml(t: any) {
  if (t == null) return '';
  return t.toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

export function renderDecisionCardsToTelegram(cards: any[], server_enforce: any, global_guard: any, new_signals: any = null, archiveUrl?: string | null) {
  const payloads = [];

  for (const card of cards) {
    // 1) Normalisasi simbol tampilan
    const viewSymbol = card.symbol.split(':')[0]; // e.g. BTC/USDT
    const base = viewSymbol.split('/')[0]; // e.g. BTC

    // 2) Ambil stop-lock final per kartu
    let stopLock = card.levels?.stop_hedge_lock;
    if (server_enforce?.overrides) {
      const override = server_enforce.overrides.find((o: any) => o.symbol === card.symbol || o.symbol === viewSymbol);
      if (override && override.stop_hedge_lock_override !== undefined) {
        stopLock = override.stop_hedge_lock_override;
      }
    }

    // 3) Stempel waktu
    const timestamp = card.telemetry?.generated_at || new Date().toISOString();

    // 4) Ekonomi tombol (inline keyboard)
    const inlineKeyboard = [];
    if (card.buttons && card.buttons.show) {
      const blockedCodes = new Set((card.buttons.block || []).map((b: any) => b.code));

      // Defense-in-depth: force block ADD/ROLE actions if GUARD_NO_ADD
      if (global_guard?.mode === "GUARD_NO_ADD") {
        ['AL', 'AS', 'HO', 'RR'].forEach(code => blockedCodes.add(code));
      }

      const allowedButtons = card.buttons.show.filter((btn: any) => !blockedCodes.has(btn.code));

      let currentRow = [];
      for (const btn of allowedButtons) {
        // mapping code → short action untuk callback
        // callback_data format: "a|s|p|tp|sh"
        const a = btn.code;
        const s = base;

        // Extract params from action_now if it matches the button code
        let p = 100;
        let tp = '';

        const actionMap: Record<string, string> = {
          'RL': 'REDUCE_LONG', 'RS': 'REDUCE_SHORT', 'AL': 'ADD_LONG', 'AS': 'ADD_SHORT',
          'LN': 'LOCK_NEUTRAL', 'HO': 'HEDGE_ON', 'UL': 'UNLOCK', 'RR': 'ROLE', 'TP': 'TAKE_PROFIT', 'HOLD': 'HOLD'
        };
        const fullAction = actionMap[a] || a;

        if (card.action_now && fullAction === card.action_now.action) {
          p = card.action_now.percentage || 100;
          tp = (card.action_now.target_price && card.action_now.target_price !== 'Market') ? card.action_now.target_price.toString() : '';
        }

        // If tp is still empty, try to extract from if_then
        if (!tp && card.if_then) {
          if (card.if_then.if_price_up_to && card.if_then.if_price_up_to.length > 0) {
            const up = card.if_then.if_price_up_to[0];
            if (up.do === fullAction) tp = up.level.toString();
          }
          if (!tp && card.if_then.if_price_down_to && card.if_then.if_price_down_to.length > 0) {
            const down = card.if_then.if_price_down_to[0];
            if (down.do === fullAction) tp = down.level.toString();
          }
        }

        // Only attach stopHedgePrice to opening/locking actions
        const openingActions = ['AL', 'AS', 'LN', 'HO', 'RR'];
        const sh = (openingActions.includes(a) && stopLock !== null && stopLock !== undefined) ? stopLock.toString() : '';

        // User request: "semua harus berdasarkan STOP-LIMIT ataupun STOP_MARKET, Decision Card harus menyertakan harga target untuk eksekusi bila tidak jangan buat tombol action di telegram"
        if (a !== 'HOLD' && !tp && !sh) {
          continue; // Skip rendering this button if no target price or stop price
        }

        const callback_data = buildCallbackData({
          action: a,
          symbol: s,
          percentage: p,
          targetPrice: tp ? parseFloat(tp) : undefined,
          stopHedgePrice: sh ? parseFloat(sh) : undefined
        });

        currentRow.push({ text: btn.label, callback_data });

        // keyboard batching: maksimal 3 tombol per baris
        if (currentRow.length >= 3) {
          inlineKeyboard.push(currentRow);
          currentRow = [];
        }
      }
      if (currentRow.length > 0) {
        inlineKeyboard.push(currentRow);
      }
    }

    // 5) Pesan HTML
    let message = `🛡️ <b>CRYPTO SENTINEL V2</b> 🛡️\n\n`;
    message += `<b>${escapeHtml(viewSymbol)}</b>\n`;
    message += `ℹ️ ${escapeHtml(card.status_line)}\n\n`;

    if (card.positions) {
      const p = card.positions;
      message += `📊 <b>Positions:</b>\n`;
      if (p.long && p.long.qty > 0) {
        const statusIcon = p.long.status === 'HIJAU' ? '🟢' : (p.long.status === 'MERAH' ? '🔴' : '⚪');
        message += `Long: ${p.long.qty} @ ${p.long.entry} | PnL: ${p.long.pnl > 0 ? '+' : ''}${p.long.pnl} ${statusIcon}\n`;
      }
      if (p.short && p.short.qty > 0) {
        const statusIcon = p.short.status === 'HIJAU' ? '🟢' : (p.short.status === 'MERAH' ? '🔴' : '⚪');
        message += `Short: ${p.short.qty} @ ${p.short.entry} | PnL: ${p.short.pnl > 0 ? '+' : ''}${p.short.pnl} ${statusIcon}\n`;
      }
      if (p.ratio_hint) message += `Ratio Hint: ${escapeHtml(p.ratio_hint)}\n`;
      message += `\n`;
    }

    if (card.levels) {
      const l = card.levels;
      message += `📐 <b>Levels:</b>\n`;
      if (l.supply?.zone) message += `🔴 Supply: ${l.supply.zone[0]} - ${l.supply.zone[1]}\n`;
      if (l.demand?.zone) message += `🟢 Demand: ${l.demand.zone[0]} - ${l.demand.zone[1]}\n`;
      if (l.pivot) message += `📍 Pivot: ${l.pivot}\n`;
      if (stopLock !== null && stopLock !== undefined) message += `🛑 STOP HEDGE: <b>${stopLock}</b>\n`;
      message += `\n`;
    }

    if (card.action_now) {
      const act = card.action_now;
      let emoji = '✋';
      if (act.action.includes('REDUCE') || act.action.includes('TAKE_PROFIT')) emoji = '✂️';
      if (act.action.includes('ADD') || act.action === 'HEDGE_ON' || act.action === 'ROLE') emoji = '⚡';
      if (act.action.includes('LOCK')) emoji = '🛡️';
      if (act.action === 'UNLOCK') emoji = '🔓';

      message += `👉 <b>ACTION: ${emoji} ${act.action.replace('_', ' ')}</b>\n`;
      message += `📝 ${escapeHtml(act.reason)}\n`;
      if (act.mr_projected_if_action !== null && act.mr_projected_if_action !== undefined) {
        message += `📈 MR Projected: ${act.mr_projected_if_action}%\n`;
      }
      if (act.bep_price_if_2_to_1 !== null && act.bep_price_if_2_to_1 !== undefined) {
        message += `🎯 BEP (2:1): ${act.bep_price_if_2_to_1}\n`;
      }
      message += `\n`;
    }

    if (card.if_then) {
      message += `🔮 <b>If/Then:</b>\n`;
      if (card.if_then.if_price_up_to && card.if_then.if_price_up_to.length > 0) {
        const up = card.if_then.if_price_up_to[0];
        message += `⬆️ Up to ${up.level}: ${up.do} (${escapeHtml(up.note)})\n`;
      }
      if (card.if_then.if_price_down_to && card.if_then.if_price_down_to.length > 0) {
        const down = card.if_then.if_price_down_to[0];
        message += `⬇️ Down to ${down.level}: ${down.do} (${escapeHtml(down.note)})\n`;
      }
      message += `\n`;
    }

    message += `⏱️ ${timestamp}`;

    // 6) Return payload
    const reply_markup = inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined;
    payloads.push({ text: message, reply_markup });
  }

  // --- PART 2: NEW SIGNALS (TOP 20 SCANNER) ---
  if (new_signals) {
    let signalMsg = `📡 <b>TOP 20 SIGNAL SCANNER</b> 📡\n\n`;

    // MR Check
    const mr = new_signals.mr;
    if (mr) {
      signalMsg += `MR: ${mr.value_pct}% (Limit: ${mr.limit_pct}%)\n`;
      signalMsg += `Mode: <b>${mr.mode}</b>\n\n`;
    }

    // Risk Warning
    if (new_signals.risk_warning) {
      signalMsg += `⚠️ <b>RISK WARNING:</b>\n${escapeHtml(new_signals.risk_warning)}\n\n`;
    }

    // Active Signals
    if (new_signals.signals && new_signals.signals.length > 0) {
      signalMsg += `🎯 <b>NEW SIGNALS FOUND:</b>\n`;
      for (const sig of new_signals.signals) {
        const sideUpper = String(sig.side).toUpperCase();
        const sideIcon = (sideUpper === 'BUY' || sideUpper === 'LONG') ? '🟢' : '🔴';
        signalMsg += `${sideIcon} <b>${escapeHtml(sig.symbol)} (${sideUpper})</b>\n`;
        signalMsg += `Entry: ${sig.entry}\n`;
        signalMsg += `SL: ${sig.stop_loss}\n`;
        if (sig.targets) {
          signalMsg += `TP1: ${sig.targets.t1 ?? '-'}`;
          if (sig.rr?.t1_rr) signalMsg += ` (RR: ${sig.rr.t1_rr})`;
          signalMsg += `\n`;
          signalMsg += `TP2: ${sig.targets.t2 ?? '-'}`;
          if (sig.rr?.t2_rr) signalMsg += ` (RR: ${sig.rr.t2_rr})`;
          signalMsg += `\n`;
        }

        if (sig.sentiment) {
          const sentIcon = sig.sentiment.status === 'BULLISH' ? '📈' : (sig.sentiment.status === 'BEARISH' ? '📉' : '⚖️');
          signalMsg += `\n${sentIcon} <b>Sentiment: ${sig.sentiment.status} (${sig.sentiment.score_1_to_10}/10)</b>\n`;
          signalMsg += `<i>${escapeHtml(sig.sentiment.reason)}</i>\n`;
        }

        if (sig.confluence) {
          signalMsg += `\n<i>${escapeHtml(sig.confluence.notes)}</i>\n`;
        }
        signalMsg += `\n`;
      }
    } else {
      signalMsg += `🚫 No high-quality signals found.\n\n`;
    }

    // Watchlist
    if (new_signals.watchlist_candidates && new_signals.watchlist_candidates.length > 0) {
      signalMsg += `👀 <b>WATCHLIST:</b>\n`;
      for (const w of new_signals.watchlist_candidates) {
        signalMsg += `• <b>${escapeHtml(w.symbol)}</b> (${w.bias_4h}): ${escapeHtml(w.notes)}\n`;
      }
    }

    // Add as a separate message payload
    payloads.push({
      text: signalMsg,
      reply_markup: undefined // No buttons for scanner results yet
    });
  }

  // Attach archive URL ONLY to the very last message payload
  if (archiveUrl && payloads.length > 0) {
    payloads[payloads.length - 1].text += `\n\n🗂️ <b>Archive</b>: ${escapeHtml(archiveUrl)}`;
  }

  return payloads;
}
