/**
 * localStore.ts — Local JSON persistence for Paper Trading Engine
 * Replaces Firestore as storage backend. In-memory first, file as persistence.
 * Files stored in: <project_root>/data/
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

const WALLET_FILE         = path.join(DATA_DIR, 'paper_wallet.json');
const POSITIONS_FILE      = path.join(DATA_DIR, 'paper_positions.json');
const HISTORY_FILE        = path.join(DATA_DIR, 'paper_history.json');
const JOURNAL_FILE        = path.join(DATA_DIR, 'trading_journal.json');
const AI_HISTORY_FILE      = path.join(DATA_DIR, 'ai_run_history.json');
const LEVERAGE_CONFIG_FILE  = path.join(DATA_DIR, 'leverage_config.json');
const PENDING_ORDERS_FILE   = path.join(DATA_DIR, 'pending_orders.json');

// Ensure data dir exists on module load
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Atomic write (write to .tmp then rename — prevents partial writes) ───────
function atomicWrite(filePath: string, data: unknown): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, defaultVal: T): T {
  try {
    if (!fs.existsSync(filePath)) return defaultVal;
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return defaultVal;
    return JSON.parse(raw) as T;
  } catch {
    return defaultVal;
  }
}

// ─── Default wallet ───────────────────────────────────────────────────────────
const DEFAULT_WALLET = () => ({
  balance: 10000,
  equity: 10000,
  freeMargin: 10000,
  marginRatio: 0,
  updatedAt: new Date().toISOString(),
});

// ─── Load all on startup ──────────────────────────────────────────────────────
export function loadAllFromDisk() {
  const wallet    = readJson(WALLET_FILE, DEFAULT_WALLET());
  const positions = readJson<any[]>(POSITIONS_FILE, []);
  const history   = readJson<any[]>(HISTORY_FILE, []);
  const journal   = readJson<any[]>(JOURNAL_FILE, []);
  console.log(
    `[LOCAL-STORE] Loaded — wallet: $${wallet.balance}, positions: ${positions.length}, history: ${history.length}, journal: ${journal.length}`
  );
  return { wallet, positions, history, journal };
}

// ─── Sync functions (fire-and-forget safe — errors logged, never throw) ───────
export function syncWalletToDisk(wallet: any): void {
  try { atomicWrite(WALLET_FILE, wallet); }
  catch (e: any) { console.error('[LOCAL-STORE] wallet write error:', e.message); }
}

export function syncPositionsToDisk(positions: any[]): void {
  try { atomicWrite(POSITIONS_FILE, positions); }
  catch (e: any) { console.error('[LOCAL-STORE] positions write error:', e.message); }
}

export function syncHistoryToDisk(history: any[]): void {
  try { atomicWrite(HISTORY_FILE, history); }
  catch (e: any) { console.error('[LOCAL-STORE] history write error:', e.message); }
}

export function syncJournalToDisk(journal: any[]): void {
  try { atomicWrite(JOURNAL_FILE, journal); }
  catch (e: any) { console.error('[LOCAL-STORE] journal write error:', e.message); }
}

// ─── Upsert / delete helpers for journal (mirrors Firestore merge behavior) ───
export function upsertJournalEntry(journal: any[], id: string, data: any): any[] {
  const idx = journal.findIndex((j: any) => j.id === id);
  if (idx > -1) {
    journal[idx] = { ...journal[idx], ...data };
  } else {
    journal.push({ id, ...data });
  }
  return journal;
}

// ─── Reset (overwrite all files with defaults) ────────────────────────────────
export function resetDisk(journal: any[]): void {
  atomicWrite(WALLET_FILE,    DEFAULT_WALLET());
  atomicWrite(POSITIONS_FILE, []);
  atomicWrite(HISTORY_FILE,   []);
  // Only remove PAPER_BOT entries from journal — preserve manual entries
  const kept = journal.filter((j: any) => j.source !== 'PAPER_BOT');
  atomicWrite(JOURNAL_FILE, kept);
}

// ─── Generate position ID (replaces doc(collection(db,'paper_positions')).id) ─
export function newPosId(): string {
  return `pos_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

// ─── Leverage Config persistence ─────────────────────────────────────────────
export interface LeverageConfig {
  default: number;                    // fallback jika symbol tidak ada di map
  symbols: Record<string, number>;    // symbol → leverage, e.g. "BTC/USDT": 20
}

const DEFAULT_LEVERAGE_CONFIG = (): LeverageConfig => ({ default: 20, symbols: {} });

export function loadLeverageConfig(): LeverageConfig {
  return readJson<LeverageConfig>(LEVERAGE_CONFIG_FILE, DEFAULT_LEVERAGE_CONFIG());
}

export function syncLeverageConfigToDisk(config: LeverageConfig): void {
  try { atomicWrite(LEVERAGE_CONFIG_FILE, config); }
  catch (e: any) { console.error('[LOCAL-STORE] leverage_config write error:', e.message); }
}

// ─── Pending Orders persistence (BUG-GHOST reconciliation) ──────────────────
export interface PendingOrder {
  clientOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number | null;  // null for market orders
  action: string;
  createdAt: number;     // unix ms
}

export function loadPendingOrders(): PendingOrder[] {
  return readJson<PendingOrder[]>(PENDING_ORDERS_FILE, []);
}

export function syncPendingOrdersToDisk(orders: PendingOrder[]): void {
  try { atomicWrite(PENDING_ORDERS_FILE, orders); }
  catch (e: any) { console.error('[LOCAL-STORE] pending_orders write error:', e.message); }
}

// ─── AI Run History persistence ───────────────────────────────────────────────
const AI_HISTORY_MAX = 500; // cap to prevent unbounded growth

export function loadAiRunHistory(): any[] {
  return readJson<any[]>(AI_HISTORY_FILE, []);
}

export function syncAiRunHistoryToDisk(history: any[]): void {
  try {
    // Keep only the most recent entries
    const trimmed = history.length > AI_HISTORY_MAX ? history.slice(-AI_HISTORY_MAX) : history;
    atomicWrite(AI_HISTORY_FILE, trimmed);
  } catch (e: any) {
    console.error('[LOCAL-STORE] ai_run_history write error:', e.message);
  }
}

// ─── GLOBAL KILL-SWITCH ────────────────────────────────────────────────────
// File: data/kill_switch.json
// Survive server restart. Atomic write pattern sama seperti file lain.

export interface KillSwitchState {
  enabled: boolean;
  reason: string;
  enabledAt: string | null; // ISO timestamp atau null
  enabledBy: string; // 'manual' | 'auto_drawdown' | dll
}

const KILL_SWITCH_FILE = path.join(DATA_DIR, 'kill_switch.json');

const KILL_SWITCH_DEFAULT: KillSwitchState = {
  enabled: false,
  reason: '',
  enabledAt: null,
  enabledBy: '',
};

export function loadKillSwitch(): KillSwitchState {
  try {
    if (!fs.existsSync(KILL_SWITCH_FILE)) return { ...KILL_SWITCH_DEFAULT };
    const raw = fs.readFileSync(KILL_SWITCH_FILE, 'utf-8');
    return { ...KILL_SWITCH_DEFAULT, ...JSON.parse(raw) };
  } catch {
    console.warn('[KILL-SWITCH] Failed to load, defaulting to disabled.');
    return { ...KILL_SWITCH_DEFAULT };
  }
}

export function syncKillSwitchToDisk(state: KillSwitchState): void {
  try {
    atomicWrite(KILL_SWITCH_FILE, state);
  } catch (err) {
    console.error('[KILL-SWITCH] Failed to sync to disk:', err);
  }
}
