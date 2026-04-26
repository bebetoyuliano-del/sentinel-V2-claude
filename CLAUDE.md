# CLAUDE.md — SENTINEL V2 Project Intelligence

> File ini dibaca otomatis oleh Claude Code setiap session.
> Terakhir diperbarui: 23 April 2026 (Session 5).

---

## 1. IDENTITAS PROJECT

**SENTINEL V2** adalah bot trading semi-otomatis berbasis strategi **Hedging Recovery Konservatif**.

- Bot membaca posisi real-time dari Binance Futures, AI menganalisis dan merekomendasikan aksi, eksekusi manual oleh user.
- Target pair: altcoin mid-cap.
- Supervisor: User + ChatGPT + Claude.

### Tech Stack

| Layer | Tech |
|-------|------|
| Backend | Node.js, Express, TypeScript (monolitik: `server.ts`) |
| Frontend | React 18, Vite, Tailwind CSS, shadcn/ui |
| AI Engine | **Claude Sonnet 4.6** (primary) + Gemini Flash (fallback) via `@anthropic-ai/sdk` + `@google/genai` |
| Exchange | Binance Futures via CCXT |
| Database | **Local JSON** (`data/`) untuk paper trading; Firebase Firestore untuk policies & auth |
| Hosting | **Local Server Windows** (sementara, GCP/Cloud Run di-suspend) |

### Deployment Info (Per 13 April 2026)

- Server berjalan via `npm run dev` (`tsx server.ts`) di port 3000
- Frontend + Backend satu port — Vite middleware mode (`middlewareMode: true`) embedded di Express
- Firebase hanya dipakai untuk `approved_settings` (policy) dan auth — **BUKAN** untuk paper trading
- Firestore quota exceeded → paper trading sudah dimigrasikan ke local JSON
- npm cache di `D:\npm-cache` (bukan default C:\) — C: drive hampir penuh
- **Binance IP**: Menggunakan mobile hotspot (POCO F4 GT) — dynamic IP via Cloudflare (104.28.x.x range). IP ban teratasi dengan airplane mode → IP baru. BUG-PROMISE (concurrent requests) diduga penyebab utama.

### File Penting

| File/Folder | Fungsi |
|-------------|--------|
| `server.ts` | Monolith utama — live execution, paper engine, API endpoints |
| `src/paper-engine/types.ts` | Type definitions + DecisionOutput contract; `PaperWallet` punya `effectiveLeverage?` + `effectiveMmr?` |
| `src/paper-engine/valuation.ts` | Kalkulasi valuasi (sudah refactor Phase 4B Step 1B) |
| `src/paper-engine/localStore.ts` | **[BARU]** Local JSON persistence — ganti Firestore untuk paper trading |
| `src/paper-engine/decisionNormalizer.ts` | Normalize raw parityResult → DecisionOutput (Decision Card Parity) |
| `src/telegram/decisionCardFormatter.ts` | Format DecisionOutput → Telegram HTML card (presenter only, NO logic) |
| `src/prompts/buildMonitoringPrompt.ts` | Prompt assembly untuk AI |
| `src/core/policy/` | Policy runtime — bootstrap, registry, selectors, validator |
| `src/services/TelegramService.ts` | sendTelegramMessage wrapper — HTML mode, auto-split, fire-and-forget pattern |
| `data/paper_wallet.json` | **[BARU]** State wallet paper trading (balance, equity, dll) |
| `data/paper_positions.json` | **[BARU]** Posisi terbuka paper trading |
| `data/paper_history.json` | **[BARU]** History closed trades paper trading (max 200) |
| `data/trading_journal.json` | **[BARU]** Jurnal per posisi paper trading |
| `data/ai_run_history.json` | **[BARU]** AI run history (max 500) — persisted across server restarts |

---

## 2. GOLDEN RULES — JANGAN PERNAH DILANGGAR

### 2.1 Trading SOP Golden Rule

- **JANGAN PERNAH** sarankan REDUCE atau CUT LOSS pada leg yang sedang MERAH (rugi).
- REDUCE **HANYA BOLEH** pada leg yang sedang HIJAU (profit).
- UNLOCK hanya jika hedge leg sedang PROFIT.
- Jika posisi rugi → solusinya HOLD, LOCK, atau ADD searah trend. **Bukan cut loss.**

### 2.2 Codebase Guardrail Integrasi

Ini adalah aturan **WAJIB** saat mengedit kode SENTINEL:

1. **Sentuhan `server.ts` HANYA pada paper evaluator seam** — jangan ubah live execution path.
2. **JANGAN** perbaiki legacy evaluator secara umum.
3. **JANGAN** ubah `fetchMarketDataWithIndicators` kecuali eksplisit di-approve untuk task tertentu.
4. **JANGAN** ganti canonical enum parity dengan label lain.
5. **Regression pack_v2 + pack_aux HARUS tetap HIJAU** setelah setiap perubahan.
6. **HF-3 AKTIF (semi-auto)** — hanya monitoring feed, tidak auto-execute.
7. **Step 1C-1b AKTIF** — exitEvaluator.ts wired, deprecated inline retained for validation.
8. Pattern baku untuk refactor: **evaluate → collect decisions[] → execute loop**.
9. **Paper trading storage = local JSON** — jangan kembalikan ke Firestore tanpa approval eksplisit.
10. **AI calls = manual only (Force Run)** — auto-interval dinonaktifkan sampai ada approval eksplisit.

### 2.3 Sebelum Setiap Edit

```
CHECKLIST:
[ ] Apakah edit ini menyentuh live execution path? → Jika ya, STOP, tanya user.
[ ] Apakah edit ini mengubah enum/type yang dipakai parity_v2? → Jika ya, cek backward compat.
[ ] Apakah edit ini menyentuh paper trading storage? → Gunakan localStore.ts, bukan Firestore.
[ ] Setelah edit, jalankan regression pack. Hijau? → Baru commit.
```

---

## 3. ARCHITECTURE STATUS (Per 13 April 2026)

### Phase Arsitektur: 2.5 Hybrid Rollback Baseline

- ✅ 4A — Policy Runtime (PolicyRegistry/Selectors)
- ✅ 4B Step 1A — types.ts refactored
- ✅ 4B Step 1B — valuation.ts refactored
- ✅ 4B Step 1C-1a — Emergency De-Risk (collect→execute pattern)
- ✅ 4B Step 1C-1b — Exit Logic extraction — **DONE** (exitEvaluator.ts, deprecated inline code retained for validation)
- 🔄 Parity V2 migration via feature flag `PAPER_ENGINE_MODE=legacy|parity_v2`

### Hotfix Series

| ID | Status | Deskripsi |
|----|--------|-----------|
| HF-1 | ✅ | Golden Rule guard — isAtTP hanya close jika currentPnl≥0 |
| HF-2 | ✅ | BEP berbasis harga bukan totalNetProfit>0 |
| PRE-HF-3A | ✅ | LOCK_1TO1 classifyStructure() toleransi 0.95–1.05 |
| PRE-HF-3B | ✅ | Dead code cleanup |
| PRE-HF-3C | ✅ | Field trend+smc di buildMonitoringPrompt signal contract |
| PRE-HF-3D | ✅ | Pass trend+smc dari monitorMarkets ke newSignal |
| PRE-HF-3E | ⚠️ INCONCLUSIVE | Payload compliance — tidak bisa verifikasi live (BLOCK_SIGNALS) |
| PRE-HF-3E-OBS | ✅ DONE | Debug endpoint /api/debug/last-signals-raw — capture BEFORE guardrail |
| HF-3 | ✅ DONE | LOCK_EXIT_URGENCY standalone — `lockExitUrgency.ts`, wired setelah for loop, semi-auto (RC-3 FIXED) |

### Perubahan Selesai (Session 11–13 April 2026)

| ID | Status | Deskripsi |
|----|--------|-----------|
| LLM-MIGRATE | ✅ DONE | AI Engine Gemini → Claude Sonnet 4.6 + Gemini Flash fallback |
| MANUAL-ONLY | ✅ DONE | Auto-interval AI dinonaktifkan — hanya Force Run |
| AI-WIDGET | ✅ DONE | Widget AI Usage di dashboard (force run count + estimasi biaya) |
| DC-PARITY | ✅ DONE | Pre-populate `lastDecisionOutputs` dari live Binance positions sebelum DC-TRACE loop |
| DC-1 | ✅ DONE | DC-TRACE aktif — log MATCH/MISMATCH/AI_ONLY_FALLBACK per symbol |
| DC-1-VALIDATED | ✅ DONE | DC-1 validated live: 28/31 = 90% MATCH, 3 MISMATCH (SIREN/TRADOOR/TUT: claude=TAKE_PROFIT → parity=HOLD) |
| DC-2 | ✅ DONE | Soft Override aktif — `card.action_now` di-override dengan parity action |
| LOCAL-STORE | ✅ DONE | Paper trading storage migrated Firestore → Local JSON (`data/`) |
| AI-PERSIST | ✅ DONE | AI run history dipersist ke `data/ai_run_history.json` (cap 500) — tidak reset tiap restart |
| STREAM-FIX | ✅ DONE | Claude: `messages.create()` → `messages.stream().finalMessage()` — required untuk max_tokens>16K |
| MAX-TOKENS | ✅ DONE | Claude max_tokens: 8192 → 32000 — full 31-card response (sebelumnya truncate di 9 cards) |
| MARGIN-FIX | ✅ DONE | Paper margin ratio: initial margin formula (notional/leverage) → maintenance margin (0.5% notional) |
| LIVE-IMPORT | ✅ DONE | `POST /api/paper/import-live` + "Import Live" button di PaperTradingView.tsx |
| VITE-FIX | ✅ DONE | Vite watcher: `ignored: ['**/data/**']` — stop page reload tiap JSON write |
| GEMINI-MODEL | ✅ DONE | GEMINI_MONITOR_MODEL: gemini-2.5-flash-preview-05-20 → gemini-1.5-flash (model stable) |
| MARGIN-CALIB | ✅ DONE | Kalibrasi MR + freeMargin dari data aktual Binance saat import — `effectiveLeverage` + `effectiveMmr` disimpan di wallet |
| BFX-1 | ✅ DONE | Emergency De-Risk cooldown 5 menit per symbol — mencegah flood reduce orders |
| BFX-2 | ✅ DONE | Fix double-push bug di `openPos()` — `insertPaperPosition()` ID-collision guard; `validateHedgeSize()` sizing guard; `auditPaperPositions()` saat startup |
| BFX-3 | ✅ DONE | Post-import adverse check — Telegram alert untuk posisi adverse >4% tanpa hedge |
| BFX-4 | ✅ DONE | Emergency De-Risk BLOK semua `openPos()` — guard di callback parity_execute + legacy Lock 1:1 trigger; log `[BFX-4]` untuk audit trail |
| BFX-5 | ✅ DONE | Unlock Guard — blok unlock hedge jika partner leg adverse >4%; `isPartnerLegSafeToUnlock()` di-wire ke 4 titik unlock (Emergency De-Risk + legacy AI signal + parity_execute UNLOCK) |
| MARGIN-FIX-V2 | ✅ DONE | `computeMaintenanceMargin` pakai `currentPrice` bukan `entryPrice` — paper MR 35% → ~22% sesuai Binance live |
| RC-1 | ✅ DONE | `paperTrendFetcher.ts` — fetch OHLCV 4H + ATR Range Filter; cache 4 min; sequential 200ms; inject ke enrichedSignal sebelum evaluateParityPaper |
| HF-3 | ✅ DONE | `lockExitUrgency.ts` — standalone LOCK_EXIT_URGENCY evaluator; tidak bergantung freshSignal; hasil eligible muncul di monitoring feed (semi-auto) |
| Step-1C-1b | ✅ DONE | `exitEvaluator.ts` — TP Sentinel + BEP Full Cycle diekstrak ke evaluator terpisah; wire via collect→execute di server.ts; inline lama di-deprecated |

### Known Root Causes

| # | Deskripsi | Status |
|---|-----------|--------|
| RC-1 | Paper engine hanya fetch currentPrice, tidak fetch market data/trend | ✅ FIXED — paperTrendFetcher.ts, enrichedSignal inject sebelum evaluateParityPaper |
| RC-2 | freshSignal.trend/smc missing di signal contract | ✅ FIXED |
| RC-3 | LOCK_EXIT_URGENCY hanya di Entry Logic, tidak standalone | ✅ FIXED — HF-3, lockExitUrgency.ts standalone evaluator |
| RC-4 | backgroundSyncFirestore tanpa guard if(pos) di MODIFY_POSITION | ✅ N/A — paper trading tidak lagi pakai backgroundSyncFirestore |

### Known Bugs (dari Audit External)

| ID | Severity | Deskripsi | Status |
|----|----------|-----------|--------|
| BUG-LEVERAGE | S1 | `const LEVERAGE = 20` hardcoded di syncPaperPrices | ✅ FIXED — `leverage_config.json` per symbol; auto-update saat Import Live; `getLeverageForSymbol()` dipakai di openPos + computeHedgeMarginUsed; API GET/PUT `/api/paper/leverage-config` |
| BUG-PROMISE | S1 | Promise.all di fetchMarketDataWithIndicators (fail-fast) | 🔴 OPEN — **diduga penyebab IP ban Binance** (terlalu banyak concurrent request) |
| BUG-GHOST | S0 | Ghost Position jika NetworkError saat createOrder | 🔴 OPEN |
| BUG-RACE | S1 | Race condition backgroundSyncFirestore — paper trading resolved via local JSON; live path masih open | ⚠️ PARTIAL |
| BUG-FLOAT | S1 | IEEE 754 floating point untuk kalkulasi finansial | 🔴 OPEN |
| BUG-SYMBOL | S2 | CCXT symbol BTC/USDT vs BTC/USDT:USDT inconsistency | ⚠️ PARTIAL PATCH |
| BUG-IDEM | S1 | Tidak ada clientOrderId pada createOrder | 🔴 OPEN |

---

## 4. ROADMAP PRIORITAS

### Phase 1 — Immediate (Gate Blocker)

| # | Task | Priority | Status |
|---|------|----------|--------|
| 1.1 | PRE-HF-3E-OBS: debug endpoint /api/debug/last-signals-raw | P0 | ✅ DONE |
| 1.2 | Paper trading storage → Local JSON (Firestore diganti) | P0 | ✅ DONE |
| 1.3 | Tambah clientOrderId (UUID v4) pada setiap createOrder | P0 | 🔴 OPEN |
| 1.4 | Final approve PRE-HF-3E (tunggu live Force Run) | P0 | ⏳ PENDING |

### Phase 2 — Stabilisasi (30 Hari)

| # | Task | Priority |
|---|------|----------|
| 2.1 | Global Kill-Switch (sekarang bisa di local file, tidak perlu Firestore) | P0 |
| 2.2 | Promise.allSettled di fetchMarketDataWithIndicators | **P0** — BUG-PROMISE diduga penyebab IP ban Binance (429 concurrent requests) |
| 2.3 | Fix hardcoded LEVERAGE = 20 → config user per symbol | P1 | ✅ DONE |
| 2.4 | Max Drawdown Guard | P1 |
| 2.5 | LLM Circuit Breaker (Claude + Gemini fallback sudah ada, perlu timeout guard) | P1 |
| 2.6 | Exposure Limit per koin + total portfolio | P2 |
| 2.7 | Unpause Step 1C-1b (setelah 1.4) | P1 |
| 2.8 | Aktivasi HF-3 (setelah 1.4) | P1 |
| 2.9 | DC-1 validated on live run — confirm MATCH rate acceptable | P1 | ✅ DONE — 90% MATCH (28/31) |

### Phase 3 — Arsitektur (60 Hari)

| # | Task | Priority |
|---|------|----------|
| 3.1 | Decimal.js untuk seluruh kalkulasi wallet/margin/PnL | P1 |
| 3.2 | Reconciliation Loop (Ghost Position detection) | P1 |
| 3.3 | Structured Logging (Pino → JSON) | P2 |
| 3.4 | Metrics endpoint /metrics | P2 |
| 3.5 | CCXT Symbol Adapter class | P2 |
| 3.6 | Local JSON → FIFO write queue + atomic backup | P2 |
| 3.7 | Finalisasi parity_v2, retire legacy paper engine | P1 |

### Phase 4 — Advanced (90 Hari)

| # | Task | Priority |
|---|------|----------|
| 4.1 | Decouple LLM ke background worker | P2 |
| 4.2 | REST Polling → CCXT Pro WebSockets | P2 |
| 4.3 | In-memory state → Redis | P3 |
| 4.4 | Event-Sourced Backtesting Engine | P3 |
| 4.5 | API Key → GCP Secret Manager (jika kembali ke cloud) | P3 |
| 4.6 | Deploy kembali ke GCP Cloud Run (setelah billing direview) | P3 |

---

## 4B. FREQTRADE-INSPIRED IMPROVEMENTS — IMPLEMENTATION QUEUE

> Diinspirasi dari eksplorasi codebase Freqtrade (sesi 2026-04-26).
> Tersimpan di sini agar konteks tidak hilang antar sesi.
> Kerjakan secara berurutan — setiap item independen, tidak saling blokir.

### STATUS RINGKAS

| # | Item | Bug/Task | Status |
|---|------|----------|--------|
| 1 | Chunked fetchInChunks | BUG-PROMISE | 🔴 OPEN — next |
| 2 | Order reconciliation loop | BUG-GHOST | 🔴 OPEN |
| 3 | Leverage dari config | BUG-LEVERAGE | ✅ DONE (2026-04-26) |
| 4 | Max drawdown guard | Phase 2.4 | 🔴 OPEN |

---

### ITEM 1 — BUG-PROMISE: Chunked fetchInChunks
**Status:** 🔴 OPEN | **Priority:** P0 | **Estimasi:** ~50 baris TypeScript

**Root cause:**
`fetchMarketDataWithIndicators` di `server.ts` memanggil `Promise.all([...31 pair...])` — fail-fast + semua request concurrent → Binance 429 / IP ban.

**Lokasi kode yang diubah:**
- `server.ts` — fungsi `fetchMarketDataWithIndicators` (cari dengan grep `fetchMarketDataWithIndicators`)
- Ganti `Promise.all` → helper `fetchInChunks` dengan `Promise.allSettled`

**Implementasi helper (tambahkan di server.ts, sebelum fetchMarketDataWithIndicators):**
```typescript
// [BUG-PROMISE] Chunked async executor — inspired by Freqtrade exchange/exchange.py chunks(100)
async function fetchInChunks<T>(
  tasks: (() => Promise<T>)[],
  chunkSize = 5,           // 5 concurrent untuk Binance — lebih konservatif dari Freqtrade (100)
  delayBetweenChunksMs = 200  // 200ms jeda antar chunk — cegah burst
): Promise<(T | null)[]> {
  const results: (T | null)[] = [];
  for (let i = 0; i < tasks.length; i += chunkSize) {
    const chunk = tasks.slice(i, i + chunkSize).map(fn => fn());
    const settled = await Promise.allSettled(chunk);
    for (const r of settled) {
      results.push(r.status === 'fulfilled' ? r.value : null);
      if (r.status === 'rejected') {
        console.warn('[BUG-PROMISE] Chunk fetch failed:', r.reason?.message || r.reason);
      }
    }
    if (i + chunkSize < tasks.length) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenChunksMs));
    }
  }
  return results;
}
```

**Cara wrap fetchMarketDataWithIndicators:**
```typescript
// SEBELUM (fail-fast, concurrent flood):
const results = await Promise.all(symbols.map(s => fetchOne(s)));

// SESUDAH (chunked, partial failure tolerant):
const tasks = symbols.map(s => () => fetchOne(s));
const results = await fetchInChunks(tasks, 5, 200);
const validResults = results.filter((r): r is NonNullable<typeof r> => r !== null);
```

**Checklist sebelum implement:**
- [ ] Cari exact signature `fetchMarketDataWithIndicators` — pastikan return type tidak berubah
- [ ] `Promise.all` mungkin ada lebih dari 1 lokasi — grep semua `Promise.all` di server.ts
- [ ] Hasil null dari chunk yang gagal harus di-handle (skip symbol, log warning)
- [ ] Jangan ubah `fetchMarketDataWithIndicators` untuk LIVE path — hanya paper engine path jika terpisah
- [ ] TypeScript: pastikan return type `fetchInChunks<T>` compatible dengan consumer

**Parameter tuning:**
- `chunkSize = 5` — konservatif untuk Binance; Freqtrade pakai 100 tapi mereka HTTP/2
- `delayBetweenChunksMs = 200` — 200ms × 6 chunks (31 pairs) = ~1.2s total overhead (acceptable)
- Jika masih 429, naikkan delay ke 500ms atau turunkan chunk ke 3

---

### ITEM 2 — BUG-GHOST: Order Reconciliation Loop
**Status:** 🔴 OPEN | **Priority:** P0 | **Estimasi:** ~80 baris TypeScript

**Root cause:**
Jika `createOrder()` success di Binance tapi response tidak diterima (NetworkError), posisi terbuka di exchange tapi tidak tercatat di paper engine → ghost position.

**Lokasi kode yang diubah:**
- `src/paper-engine/localStore.ts` — tambah `PENDING_ORDERS_FILE` + fungsi load/sync
- `server.ts` — tambah `pendingOrders` store, wire ke createOrder, tambah reconciliation loop

**Struktur data (tambah ke localStore.ts):**
```typescript
// Tambah di localStore.ts
export interface PendingOrder {
  clientOrderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  price: number;
  createdAt: number;    // unix ms
  paperPosId?: string;  // ID paper position yang menunggu konfirmasi
}

// File: data/pending_orders.json
export function loadPendingOrders(): PendingOrder[] { ... }
export function syncPendingOrdersToDisk(orders: PendingOrder[]): void { ... }
```

**Reconciliation loop di server.ts:**
```typescript
// Jalankan tiap 30 detik — TERPISAH dari paper engine cycle
const GHOST_TIMEOUT_MS = 5 * 60 * 1000; // 5 menit tanpa konfirmasi = suspected ghost

async function reconcilePendingOrders() {
  if (pendingOrders.size === 0) return;
  for (const [clientOrderId, order] of pendingOrders) {
    try {
      const exchangeOrder = await binance.fetchOrder(clientOrderId, order.symbol);
      if (exchangeOrder.status === 'closed') {
        // Konfirmasi: posisi terbuka di exchange → pastikan ada di paper
        confirmPendingOrder(clientOrderId, order);
        pendingOrders.delete(clientOrderId);
      } else if (Date.now() - order.createdAt > GHOST_TIMEOUT_MS) {
        // Timeout: alert Telegram, tandai untuk investigasi manual
        await sendTelegramMessage(
          `⚠️ [BUG-GHOST] Suspected ghost position: ${order.symbol} ${order.side}\n` +
          `ClientOrderId: ${clientOrderId}\nCreated: ${new Date(order.createdAt).toISOString()}`
        );
        pendingOrders.delete(clientOrderId);
      }
    } catch (err) {
      console.warn('[BUG-GHOST] Reconcile fetch failed:', clientOrderId, err);
    }
  }
}
```

**Wire ke createOrder (live path — PERIKSA DULU SEBELUM EDIT):**
```typescript
// Simpan pending order SEBELUM createOrder dipanggil
const clientOrderId = generateClientOrderId(); // UUID v4 (sekaligus fix BUG-IDEM)
pendingOrders.set(clientOrderId, { clientOrderId, symbol, side, size, price, createdAt: Date.now() });
syncPendingOrdersToDisk([...pendingOrders.values()]);
try {
  const result = await binance.createOrder(symbol, 'market', sideStr, size, undefined, { clientOrderId });
  pendingOrders.delete(clientOrderId); // Sukses → hapus dari pending
} catch (NetworkError) {
  // JANGAN hapus dari pending — biarkan reconciliation loop yang handle
  console.warn('[BUG-GHOST] NetworkError on createOrder — pending order retained for reconciliation');
}
```

**PENTING — Guardrail sebelum implement:**
- `createOrder` ada di **LIVE execution path** → **WAJIB tanya user sebelum edit**
- Reconciliation loop hanya boleh ALERT, tidak auto-create atau auto-cancel position
- `pendingOrders` harus persist ke disk (survive server restart)
- BUG-IDEM (clientOrderId) harus diimplementasi bersamaan

---

### ITEM 4 — Max Drawdown Guard (Phase 2.4)
**Status:** 🔴 OPEN | **Priority:** P1 | **Estimasi:** ~30 baris TypeScript

**Tujuan:**
Stop semua operasi paper engine jika equity turun X% dari peak. Terinspirasi dari Freqtrade `max_drawdown` config + `check_max_drawdown()`.

**Lokasi kode yang diubah:**
- `server.ts` — tambah tracking `peakEquity`, fungsi `checkMaxDrawdown()`, wire ke `runPaperTradingEngine`
- `src/paper-engine/types.ts` — tambah `maxDrawdownPct?: number` ke `PaperWallet` (opsional)
- `data/paper_wallet.json` — akan menyimpan `peakEquity` untuk persist antar restart

**Implementasi (tambah di server.ts, di dalam/sebelum runPaperTradingEngine):**
```typescript
// [Phase 2.4] Max Drawdown Guard — inspired by Freqtrade freqtradebot.py check_max_drawdown()
const MAX_DRAWDOWN_PCT = 20; // 20% drawdown dari peak → stop engine

function checkMaxDrawdown(wallet: PaperWallet): boolean {
  // Update peak equity
  const peakEquity = (wallet as any).peakEquity || wallet.balance;
  if (wallet.equity > peakEquity) {
    (wallet as any).peakEquity = wallet.equity;
    syncWalletToDisk(wallet); // persist peak
  }
  // Check drawdown
  const drawdownPct = ((peakEquity - wallet.equity) / peakEquity) * 100;
  if (drawdownPct >= MAX_DRAWDOWN_PCT) {
    console.error(`[MAX-DRAWDOWN] TRIGGERED: ${drawdownPct.toFixed(1)}% drawdown (peak: $${peakEquity.toFixed(2)}, now: $${wallet.equity.toFixed(2)})`);
    sendTelegramMessage(
      `🚨 <b>MAX DRAWDOWN TRIGGERED</b>\n` +
      `Drawdown: ${drawdownPct.toFixed(1)}% dari peak\n` +
      `Peak: $${peakEquity.toFixed(2)} → Sekarang: $${wallet.equity.toFixed(2)}\n` +
      `Paper engine DIHENTIKAN — restart manual untuk lanjutkan.`
    );
    return true; // sinyal stop
  }
  return false;
}
```

**Wire ke runPaperTradingEngine (awal cycle, sebelum evaluasi):**
```typescript
async function runPaperTradingEngine() {
  // [Phase 2.4] Max drawdown check — stop sebelum cycle berjalan
  if (checkMaxDrawdown(cachedPaperWallet)) {
    isPaperTradingRunning = false;
    if (paperTradingInterval) {
      clearInterval(paperTradingInterval);
      paperTradingInterval = null;
    }
    return;
  }
  // ... sisa engine cycle seperti biasa
}
```

**Config (tambahkan ke approved_settings atau hardcode dulu):**
```typescript
// Sementara hardcode, nanti bisa diambil dari policy/config
const MAX_DRAWDOWN_PCT = parseFloat(process.env.MAX_DRAWDOWN_PCT || '20');
```

**Checklist sebelum implement:**
- [ ] `peakEquity` harus persist ke `paper_wallet.json` (agar tidak reset tiap server restart)
- [ ] Guard harus bisa di-reset manual via API endpoint `POST /api/paper/reset-drawdown-peak`
- [ ] Threshold `MAX_DRAWDOWN_PCT` idealnya bisa dikonfigurasi via env atau API
- [ ] Pastikan tidak blokir `syncPaperPrices` — hanya blokir evaluasi (engine cycle)

---

## 4A. CURRENT ACTIVE PRIORITY — TELEGRAM DECISION CARD PARITY

> **Status:** Active | **Phase:** Paper Consistency → Decision Card Parity → Backtesting

### Objective

Telegram Decision Card HARUS menggunakan core logic yang sama dengan Paper Trading Engine. **Reuse, bukan duplikasi.**

### Module Responsibilities

| Module | Role | Status |
|--------|------|--------|
| Paper Trading Core | Authority — decision truth source | ✅ Active & stable |
| Decision Output Layer | Normalize raw → structured decisions | ✅ Built (`decisionNormalizer.ts`) |
| Telegram Decision Card | Format only — presenter, NEVER logic | ✅ Built (`src/telegram/decisionCardFormatter.ts`) |
| DC-PARITY Pre-populate | Evaluasi live position → `lastDecisionOutputs` sebelum DC-TRACE | ✅ Active |
| DC-TRACE (DC-1) | Observability — MATCH/MISMATCH log per symbol | ✅ Active |
| DC-2 Soft Override | Override `card.action_now` dengan parity action | ✅ Active |
| Backtesting Layer | Replay decisions (Phase 2) | ⏳ After parity stable |

### Hard Rules — Decision Card Parity

- ❌ **No 2nd trading logic** untuk Telegram — reuse Paper Core
- ❌ **Jangan break** paper trading behavior yang sudah stable
- ✅ **Hedging-recovery logic** tetap canonical
- ✅ Formatting boleh berbeda, **semantics harus align**

### Key File Locations

| Concern | Location |
|---------|----------|
| Decision logic | Paper Trading Core (`server.ts` + `src/paper-engine/`) |
| Output schema / types | `src/paper-engine/types.ts` — `DecisionOutput` |
| Normalizer | `src/paper-engine/decisionNormalizer.ts` |
| Telegram formatter | `src/telegram/decisionCardFormatter.ts` |
| In-memory store | `lastDecisionOutputs: Map<string, DecisionOutput>` di `server.ts` ~630 |
| DC-PARITY seam | `server.ts` ~1199 — pre-populate sebelum DC-TRACE loop |
| DC-TRACE seam | `server.ts` ~1308 — log MATCH/MISMATCH/AI_ONLY_FALLBACK |
| DC-2 Override seam | `server.ts` ~1310 — override `card.action_now` |
| Debug endpoint | `GET /api/debug/last-signals-raw` |
| AI Usage endpoint | `GET /api/ai-usage` |

### Done Criteria (Decision Card Parity)

- [x] DecisionOutput contract defined (`types.ts`) ✅
- [x] Normalizer built (`decisionNormalizer.ts`) ✅
- [x] Formatter built (`src/telegram/decisionCardFormatter.ts`) ✅
- [x] `handlePaperDecisionOutput` wired after `evaluateParityPaper` ✅
- [x] DC-PARITY pre-populate dari live Binance positions ✅
- [x] DC-TRACE (DC-1) active — MATCH/MISMATCH observable per symbol ✅
- [x] DC-2 Soft Override active ✅
- [x] DC-1 validated on live Force Run — 28/31 = 90% MATCH (2026-04-13) ✅
- [ ] Parity checks pass
- [ ] Ready for backtesting phase

---

## 5. LOCAL STORAGE ARCHITECTURE (Paper Trading)

> Menggantikan Firestore setelah Google billing di-suspend dan quota habis.

### File JSON

```
d:\sentinel\sentinelv2\sentinel-V2\data\
├── paper_wallet.json       — PaperWallet object (balance, equity, freeMargin, marginRatio)
├── paper_positions.json    — PaperPosition[] array (posisi terbuka)
├── paper_history.json      — PaperHistory[] array (max 200 closed trades)
├── trading_journal.json    — JournalEntry[] array (linked per posisi)
└── ai_run_history.json     — AiRunRecord[] array (max 500) — persisted across server restarts
```

### API localStore.ts

| Fungsi | Deskripsi |
|--------|-----------|
| `loadAllFromDisk()` | Load semua state saat server startup |
| `syncWalletToDisk(wallet)` | Atomic write wallet setelah setiap perubahan |
| `syncPositionsToDisk(positions)` | Atomic write positions array |
| `syncHistoryToDisk(history)` | Atomic write history array |
| `syncJournalToDisk(journal)` | Atomic write journal array |
| `upsertJournalEntry(journal, id, data)` | Merge update ke journal entry |
| `resetDisk(journal)` | Reset semua files ke default, preserve non-PAPER_BOT journal |
| `newPosId()` | Generate unique position ID (ganti `doc(collection(db,...)).id`) |
| `loadAiRunHistory()` | Load AI run history dari disk saat server startup |
| `syncAiRunHistoryToDisk(history)` | Atomic write ai_run_history.json, trim ke 500 entries |

### Write Pattern

Atomic write: tulis ke `.tmp` → rename ke file target. Mencegah partial write jika server crash.

### Live Mirror Import

Endpoint `POST /api/paper/import-live` — one-time snapshot dari live Binance → paper trading.

- Mengambil semua posisi terbuka dari Binance Futures (via CCXT `fetchPositions()`)
- Mengambil wallet balance dari `fetchAccountRisk()` (walletBalance, equity, freeMargin)
- Menyimpan ke `cachedPaperPositions` + `cachedPaperWallet`, lalu sync ke disk
- Field `isLiveImport: true` + `importedAt` ditandai di setiap posisi
- Leverage per posisi diambil dari CCXT response (fix BUG-LEVERAGE untuk imported positions)
- `effectiveLeverage` + `effectiveMmr` dikalibrasi dari Binance actual data dan disimpan di wallet — dipakai oleh `computeHedgeMarginUsed()` dan `computeMaintenanceMargin()` selama engine berjalan
- UI: tombol "Import Live" di PaperTradingView.tsx — double-click confirm (4 detik timeout)
- **Tujuan:** simulasi live trading menggunakan paper engine — bukan continuous sync

### Guardrail

- Jangan kembalikan paper trading ke Firestore tanpa approval eksplisit.
- Jika butuh backup, gunakan archive endpoint `/api/paper/archive` → upload ke GCS.
- `data/` folder tidak boleh di-gitignore — state harus persist.

---

## 6. AI ENGINE CONFIGURATION

### Primary: Claude Sonnet 4.6

- Model ID: `claude-sonnet-4-6`
- API Key: `ANTHROPIC_API_KEY` di `.env`
- Max tokens: **32000** (naik dari 8192 — cover full 31-card response)
- Mode: **Streaming** — `messages.stream().finalMessage()` (wajib untuk max_tokens > ~16K)
- Chart image: **TIDAK dikirim** ke Claude (analisis dari JSON market data sudah cukup)

### Fallback: Gemini Flash

- Model: `gemini-1.5-flash` (env: `GEMINI_MONITOR_MODEL` di `.env`)
- API Key: `GEMINI_API_KEY` di `.env`
- Hard cap: `maxOutputTokens: 8192`
- Aktif jika Claude gagal setelah 3 retry
- **Catatan:** gemini-2.5-flash-preview-05-20 deprecated; gemini-2.0-flash "not available to new users" → final stable: `gemini-1.5-flash`

### Cost Estimate (Aktual dari Anthropic Console)

| Skenario | Token (in/out) | Biaya/run |
|----------|----------------|-----------|
| Claude Sonnet 4.6 Force Run (31 pairs) | ~67K / ~32K | ~$0.82 |
| Gemini Flash (fallback) | ~67K / ~8K | ~$0.01 |

### Mode Operasi

- **MANUAL-ONLY**: Auto-interval dinonaktifkan. AI hanya via tombol Force Run.
- Cron AI (`checkRiskAndNotify`, `generateAutoJournal`) di-comment di `scheduleCronJobs()`.
- Paper trading engine (`runPaperTradingEngine`) tetap berjalan setiap 60 detik — **tidak** pakai AI.

### Monitoring Widget

- Endpoint: `GET /api/ai-usage` (returns `sessionRuns`, `totalRuns`, `claudeRuns`, `geminiRuns`, `failedRuns`, `estCostUSD`, dll)
- Widget di dashboard: Force Runs count, Success/Failed, Est. Cost USD, Avg Duration, Last 10 history
- State: `aiRunHistory[]` in-memory + **persisted ke `data/ai_run_history.json`** (tidak reset tiap restart)
- `/api/ai-usage` field `sessionRuns` = jumlah run sejak server restart terakhir

---

## 7. SOP TRADING — REFERENSI CEPAT

> Bagian ini untuk konteks jika Claude Code diminta mengedit logic trading.

### Hierarki Keputusan (Rule Precedence)

```
1. GOLDEN RULE         → No cut loss on red leg. Reduce hanya hijau.
2. MR HARD GUARD       → MRProjected > 25% → BLOK ekspansi.
3. AMBIGUITY BLOCK     → Trend/MR/hedge/struktur tidak jelas → BLOK.
   3A: Adverse spot > 4% → blok recovery.
   3B: LOCK_EXIT_URGENCY → ADD_LONG_0.5 boleh jika kondisi spesifik.
4. RECOVERY_SUSPENDED  → CHOP berat → blok ekspansi.
5. ENTRY-ANCHOR STOP   → Proteksi defensif leg hijau.
6. CONTEXT + TREND     → Baru evaluasi setelah 1-5 lolos.
7. STRUCTURAL MANEUVER → 6.4A / 6.4B / 6.4C / 6.5.
8. APPROVED SETTINGS   → Hanya parameter numerik.
   8A: POST-ACTION RECLASSIFICATION setelah setiap aksi.
9. FALLBACK            → HOLD / WAIT & SEE / LOCK_NEUTRAL.
```

### Klasifikasi Structure (dari rasio qty LIVE)

| Rasio (Dominan/Minor) | Structure |
|------------------------|-----------|
| 0.95–1.05 | LOCK_1TO1 |
| 1.40–1.60 | LONG_1P5_SHORT_1 / SHORT_1P5_LONG_1 |
| 1.90–2.10 | LONG_2_SHORT_1 / SHORT_2_LONG_1 |

### Context Mode

| Mode | Arti | Aksi Dibolehkan |
|------|-------|-----------------|
| CONTINUATION_RECOVERY | Profit leg searah trend | ADD 0.5, bangun 2:1, kejar BEP |
| REVERSAL_DEFENSE | Profit leg terancam reversal | REDUCE bertahap ke Lock 1:1 |
| LOCK_WAIT_SEE | Lock 1:1, ambigu | Tunggu sinyal jelas |
| EXIT_READY | 2:1 mendekati BEP | EXIT penuh, reset |
| RISK_DENIED | Guardrail aktif | Tetap defensif |

### Rumus BEP

```
BEP_GROSS = ((Qty_Long × Entry_Long) - (Qty_Short × Entry_Short)) / (Qty_Long - Qty_Short)
```

Selalu nyatakan apakah yang ditampilkan BEP_GROSS atau BEP_NET.

### MR Global

| MR | Status | Aksi |
|----|--------|------|
| < 15% | AMAN | Entry, ADD, 2:1 |
| 15–25% | WASPADA | Kurangi ekspansi, fokus de-risk |
| ≥ 25% | DARURAT | Hanya REDUCE, LOCK, TP |

### Post-Action Reclassification (WAJIB)

Setelah **setiap** aksi yang mengubah posisi:

1. Hitung ulang qty live → Structure baru
2. Update GreenLeg / RedLeg
3. Update HedgeLegStatus (HEDGE_FULL / RESIDUAL_OPPOSING_LEG / NONE)
4. Evaluasi ulang ContextMode (Structure ≠ ContextMode)
5. Evaluasi ulang RiskOverride
6. Baru nilai aksi lanjutan

---

## 8. REGRESSION CHECKLIST

Jalankan checklist ini **sebelum setiap commit**.

### A. Codebase Guardrail

```
[ ] Sentuhan server.ts HANYA pada paper evaluator seam
[ ] Tidak ubah live execution path
[ ] Tidak ubah fetchMarketDataWithIndicators (kecuali task 2.2)
[ ] Tidak ganti canonical enum parity
[ ] Regression pack_v2 HIJAU
[ ] Regression pack_aux HIJAU
[ ] HF-3 semi-auto: hanya tulis hf3Recommendation ke monitoring feed, tidak auto-execute
[ ] Step 1C-1b: collectExitDecisions dipanggil, deprecated block tetap komentar
```

### B. Safety Controls

```
[ ] clientOrderId ada pada setiap createOrder
[ ] Max Drawdown guard aktif (setelah Phase 2.4)
[ ] LLM Circuit Breaker aktif (setelah Phase 2.5)
[ ] Reconciliation setelah NetworkError (setelah Phase 3.2)
```

### C. Data Integrity

```
[ ] Paper trading storage menggunakan localStore.ts (BUKAN Firestore)
[ ] data/ folder ada dan writable
[ ] Atomic write berfungsi (.tmp → rename)
[ ] Leverage diambil dari config user, bukan hardcoded
[ ] fetchMarketDataWithIndicators pakai Promise.allSettled (Phase 2.2)
[ ] Kalkulasi finansial pakai Decimal.js (setelah Phase 3.1)
[ ] Symbol normalization konsisten (setelah Phase 3.5)
```

### D. Parity V2

```
[ ] Feature flag PAPER_ENGINE_MODE=parity_v2 aktif
[ ] SR-06, SR-10, SR-11, SR-12 tetap sinkron
[ ] AUX-01/02/03 terpisah dan tidak interfere
[ ] Legacy paper engine deprecated setelah parity_v2 stable
```

### E. Decision Card Parity

```
[ ] DC-PARITY pre-populate berjalan (log [DC-PARITY] per symbol)
[ ] DC-TRACE log MATCH/MISMATCH/AI_ONLY_FALLBACK per symbol
[ ] DC-2 Override aktif (log [DC-2-OVERRIDE] jika ada parity decision)
[ ] Telegram Decision Card menggunakan logic dari Paper Core (bukan parallel)
[ ] Semantic parity w/ paper trading output
[ ] Hedging-recovery logic unchanged
```

### F. AI Engine

```
[ ] ANTHROPIC_API_KEY terset di .env
[ ] generateWithRetry menggunakan Claude Sonnet 4.6 sebagai primary
[ ] Claude: messages.stream().finalMessage() (bukan messages.create()) — wajib untuk max_tokens 32000
[ ] Gemini Flash fallback berfungsi jika Claude gagal (model: gemini-1.5-flash)
[ ] Chart image TIDAK dikirim ke Claude (null, bukan chartBase64)
[ ] /api/ai-usage endpoint return JSON (bukan HTML), ada field sessionRuns
[ ] AI Usage widget muncul di dashboard
[ ] data/ai_run_history.json ada dan ter-load saat startup
```

---

## 9. CONVENTIONS & PATTERNS

### Pattern Baku Refactor

```typescript
// evaluate → collect decisions[] → execute loop
const decisions: Decision[] = [];

// Phase 1: Evaluate
for (const pos of positions) {
  const decision = evaluatePosition(pos, marketData);
  decisions.push(decision);
}

// Phase 2: Execute
for (const d of decisions) {
  await executeDecision(d);
  await reclassify(d.symbol); // WAJIB post-action
}
```

### Paper Trading Storage Pattern

```typescript
// BENAR — update cache dulu, lalu sync ke disk
cachedPaperPositions[idx].size = newSize;
syncPositionsToDisk(cachedPaperPositions);

// SALAH — jangan pakai Firestore untuk paper trading
backgroundSyncFirestore(setDoc(doc(db, 'paper_positions', id), data));
```

### Naming Conventions

| Konsep | Nama di Kode |
|--------|-------------|
| Qty lock aktif | `ActiveLockBaseQty` |
| Tambah 50% | `ADD_LONG_0.5` / `ADD_SHORT_0.5` |
| Kurangi 50% | `REDUCE_LONG_0.5` / `REDUCE_SHORT_0.5` |
| Struktur klasifikasi | `classifyStructure()` dengan toleransi 0.95–1.05 |
| BEP | `BEP_GROSS_PRICE` (tanpa fee) / `BEP_NET_PRICE` (dengan fee) |

### Error Handling

- Firestore (non-paper): gunakan `withFirestoreFailSoft` wrapper — jangan blocking.
- Paper trading storage: `localStore.ts` — error di-log, tidak throw (fire-and-forget safe).
- CCXT calls: selalu handle `NetworkError`, `ExchangeError`, `RateLimitExceeded`.
- Claude API: max 3 retry dengan exponential backoff → fallback Gemini Flash.
- Async sync: paper trading — `syncXxxToDisk()` functions, tidak blocking.

---

## 10. WORKFLOW UNTUK CLAUDE CODE

Ketika user memberikan task:

1. **Baca section 2 (Golden Rules)** — pastikan task tidak melanggar guardrail.
2. **Identifikasi file** — navigasi ke file yang relevan, baca konteks sekitar.
3. **Cek section 4A (Decision Card Parity)** — jika task menyangkut Telegram/Decision Card, pastikan reuse logic.
4. **Cek section 5 (Local Storage)** — jika task menyangkut paper trading persistence, gunakan `localStore.ts`.
5. **Edit minimal** — jangan refactor hal yang tidak diminta.
6. **Type-check** — jalankan `npx tsc --noEmit` setelah edit.
7. **Regression** — jalankan regression pack jika tersedia.
8. **Report** — jelaskan apa yang diubah dan file mana yang tersentuh.

Jika task ambigu atau berpotensi menyentuh live execution path → **TANYA USER DULU**, jangan asumsi.

---

## 11. DECISION LOG

| Tanggal | Keputusan | Alasan |
|---------|-----------|--------|
| 2026-04-26 | BUG-LEVERAGE FIXED: leverage_config.json per symbol | CCXT return leverage=0 tanpa filter symbol → hardcoded fallback || 20. Fix: `LeverageConfig` di localStore.ts, `getLeverageForSymbol()` di server.ts, wire ke `openPos()` (2 titik) + `computeHedgeMarginUsed()`. Import Live auto-update config dari Binance actual. API GET/PUT `/api/paper/leverage-config`. tsc clean. |
| 2026-04-26 | Freqtrade dieksplorasi → 4 improvement items disimpan ke CLAUDE.md section 4B | BUG-PROMISE (chunked fetchInChunks), BUG-GHOST (reconciliation loop), BUG-LEVERAGE (done), Phase 2.4 (max drawdown). Detail implementasi + pseudocode tersimpan untuk sesi berikutnya. |
| 2026-04-23 | Step 1C-1b DONE: exitEvaluator.ts wired ke server.ts | Phase 4B refactor — TP Sentinel + BEP Full Cycle diekstrak ke isolated evaluator; collect→execute pattern; inline lama di-deprecated (retained untuk validasi) |
| 2026-04-23 | HF-3 DONE: lockExitUrgency.ts standalone (RC-3 fix) | LOCK_EXIT_URGENCY hanya jalan saat freshSignal ada — kondisi margin bleed justru terjadi tanpa sinyal baru. Fix: evaluator standalone wired setelah for loop, semi-auto (hf3Recommendation di monitoring feed) |
| 2026-04-23 | RC-1 DONE: paperTrendFetcher.ts injected ke enrichedSignal | PrimaryTrend4H selalu UNCLEAR karena paper engine tidak fetch market data. Fix: OHLCV 4H + ATR Range Filter, cache 4 min, enrichedSignal inject sebelum evaluateParityPaper |
| 2026-04-23 | parity_runtime.ts: guard !freshSignal.side → HOLD | Synthetic trend-only enrichedSignal (no side field) menyebabkan signalSide default ke 'SHORT' → bisa trigger ADD/OPEN keliru. Guard dipasang sebelum signalSide derivation |
| 2026-04-13 | max_tokens Claude: 8192 → 32000 + streaming | 8192 truncating 9/31 cards; streaming wajib untuk request >16K token output |
| 2026-04-13 | GEMINI_MONITOR_MODEL final: gemini-1.5-flash | gemini-2.5-flash-preview-05-20 deprecated, gemini-2.0-flash "not available to new users" |
| 2026-04-13 | AI run history dipersist ke data/ai_run_history.json | aiRunHistory[] di-reset tiap server restart → counter kembali ke 0 |
| 2026-04-16 | MARGIN-CALIB: effectiveLeverage + effectiveMmr dari Binance | CCXT return leverage=20 semua posisi → free margin $289 vs Binance $344; dikalibrasi saat import (totalNettedNotional / totalIM = true leverage; totalMaintMargin / totalEntryNotional = true MMR) |
| 2026-04-16 | PaperWallet type: tambah effectiveLeverage? + effectiveMmr? | Calibration constants disimpan per wallet, bukan hardcoded di fungsi — backward compat: field opsional, fallback ke default jika tidak ada |
| 2026-04-13 | Margin ratio formula: initial → maintenance (0.5% notional) | Paper MR 60% vs Binance 18.25% — paper pakai initial margin (5% di 20x), Binance pakai maintenance (0.5%) |
| 2026-04-13 | `POST /api/paper/import-live` + "Import Live" UI | User minta simulasi live trading menggunakan paper engine — one-time snapshot import |
| 2026-04-13 | Vite watcher ignore data/ | Vite trigger full page reload tiap JSON write di data/ — setiap 60 detik |
| 2026-04-13 | npm cache dipindah ke D:\npm-cache | C: drive penuh (0 bytes) setelah npm install; `npm config set cache D:\npm-cache` |
| 2026-04-13 | DC-1 validated: 90% MATCH (28/31) | Live Force Run 2026-04-13 — 3 MISMATCH: claude=TAKE_PROFIT, parity=HOLD (DC-2 override ke HOLD) |
| 2026-04-13 | AI_COST_PER_RUN_USD: $0.33 → $0.82 | Aktual dari Anthropic console setelah max_tokens=32000 |
| 2026-04-13 | Paper trading migrated Firestore → Local JSON | Google billing closed, Firestore quota habis, paper state reset tiap restart |
| 2026-04-13 | `data/` folder di `d:\sentinel\sentinelv2\sentinel-V2\data\` | User request: jangan di C:\, taruh di folder sentinel (D:\) |
| 2026-04-13 | AI Usage widget ditambah ke dashboard | User butuh monitor force run count + estimasi biaya Claude per session |
| 2026-04-13 | DC-2 Soft Override diaktifkan | DC-PARITY pre-populate sudah fix AI_ONLY_FALLBACK, DC-2 bisa jalan |
| 2026-04-13 | Chart image tidak dikirim ke Claude | Claude analisis dari JSON market data, image menyebabkan MIME type error + tidak perlu |
| 2026-04-11 | AI Engine migrasi Gemini → Claude Sonnet 4.6 | Google billing closed → Gemini 429 quota exceeded |
| 2026-04-11 | Mode MANUAL-ONLY — auto-interval AI dinonaktifkan | Server lokal sementara, user mau kontrol manual kapan AI dipanggil |
| 2026-04-11 | Gemini Flash tetap sebagai fallback | Jika Claude gagal, sistem tidak berhenti total |
| 2026-04-10 | DC-TRACE (DC-1) active, DC-2 override deferred (saat itu) | DC-1 harus validated live sebelum card mutation |
| 2026-04-10 | handlePaperDecisionOutput TIDAK send Telegram langsung | Double-send risk — TelegramRenderer path sudah handle |
| 2026-04-10 | PRE-HF-3E-OBS endpoint selesai | /api/debug/last-signals-raw capture BEFORE guardrail |
| 2026-04-08 | clientOrderId jadi P0 | Double order = financial loss |
| 2026-04-08 | Kill-Switch jadi P0 Phase 2 | Tidak ada emergency brake |
| 2026-04-08 | WebSockets/Redis tetap Phase 4 | Semi-auto + pair terbatas, REST cukup |
| 2026-04-08 | CLAUDE.md dibuat | Agar Claude Code punya full context setiap session |
