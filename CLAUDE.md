# CLAUDE.md — SENTINEL V2 Project Intelligence

> File ini dibaca otomatis oleh Claude Code setiap session.
> Terakhir diperbarui: 8 April 2026.

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
| AI Engine | Google GenAI (Gemini API) via `@google/genai` |
| Exchange | Binance Futures via CCXT |
| Database | Firebase Firestore (fail-soft wrapper) |
| Hosting | Google Cloud Run |

### File Penting

| File/Folder | Fungsi |
|-------------|--------|
| `server.ts` | Monolith utama — live execution, paper engine, API endpoints |
| `src/paper-engine/types.ts` | Type definitions (sudah refactor Phase 4B Step 1A) |
| `src/paper-engine/valuation.ts` | Kalkulasi valuasi (sudah refactor Phase 4B Step 1B) |
| `src/prompts/buildMonitoringPrompt.ts` | Prompt assembly untuk Gemini |
| `src/core/policy/` | Policy runtime — bootstrap, registry, selectors, validator |

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
6. **HF-3 tetap OFF** sampai PRE-HF-3E final approved.
7. **Step 1C-1b (Exit Logic extraction) tetap PAUSED** sampai PRE-HF-3E final approved.
8. Pattern baku untuk refactor: **evaluate → collect decisions[] → execute loop**.

### 2.3 Sebelum Setiap Edit

```
CHECKLIST:
[ ] Apakah edit ini menyentuh live execution path? → Jika ya, STOP, tanya user.
[ ] Apakah edit ini mengubah enum/type yang dipakai parity_v2? → Jika ya, cek backward compat.
[ ] Setelah edit, jalankan regression pack. Hijau? → Baru commit.
```

---

## 3. ARCHITECTURE STATUS (Per 8 April 2026)

### Phase Arsitektur: 2.5 Hybrid Rollback Baseline

- ✅ 4A — Policy Runtime (PolicyRegistry/Selectors)
- ✅ 4B Step 1A — types.ts refactored
- ✅ 4B Step 1B — valuation.ts refactored
- ✅ 4B Step 1C-1a — Emergency De-Risk (collect→execute pattern)
- ⏸️ 4B Step 1C-1b — Exit Logic extraction — **PAUSED**
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
| PRE-HF-3E-OBS | 📋 PLANNED | Debug endpoint /api/debug/last-signals-raw |
| HF-3 | ⏸️ BLOCKED | Menunggu PRE-HF-3E final |

### Known Root Causes

| # | Deskripsi | Status |
|---|-----------|--------|
| RC-1 | Paper engine hanya fetch currentPrice, tidak fetch market data/trend | 🔴 OPEN |
| RC-2 | freshSignal.trend/smc missing di signal contract | ✅ FIXED |
| RC-3 | LOCK_EXIT_URGENCY hanya di Entry Logic, tidak standalone | 🔴 OPEN |
| RC-4 | backgroundSyncFirestore tanpa guard if(pos) di MODIFY_POSITION | 🔴 OPEN |

### Known Bugs (dari Audit External)

| ID | Severity | Deskripsi | Status |
|----|----------|-----------|--------|
| BUG-LEVERAGE | S1 | `const LEVERAGE = 20` hardcoded di syncPaperPrices | 🔴 OPEN |
| BUG-PROMISE | S1 | Promise.all di fetchMarketDataWithIndicators (fail-fast) | 🔴 OPEN |
| BUG-GHOST | S0 | Ghost Position jika NetworkError saat createOrder | 🔴 OPEN |
| BUG-RACE | S1 | Race condition backgroundSyncFirestore tanpa ordering | 🔴 OPEN |
| BUG-FLOAT | S1 | IEEE 754 floating point untuk kalkulasi finansial | 🔴 OPEN |
| BUG-SYMBOL | S2 | CCXT symbol BTC/USDT vs BTC/USDT:USDT inconsistency | ⚠️ PARTIAL PATCH |
| BUG-IDEM | S1 | Tidak ada clientOrderId pada createOrder | 🔴 OPEN |

---

## 4. ROADMAP PRIORITAS

### Phase 1 — Immediate (Gate Blocker)

| # | Task | Priority |
|---|------|----------|
| 1.1 | PRE-HF-3E-OBS: debug endpoint /api/debug/last-signals-raw | P0 |
| 1.2 | Patch RC-4: backgroundSyncFirestore guard if(pos) di MODIFY_POSITION | P0 |
| 1.3 | Tambah clientOrderId (UUID v4) pada setiap createOrder | P0 |
| 1.4 | Final approve PRE-HF-3E (blocked by 1.1) | P0 |

### Phase 2 — Stabilisasi (30 Hari)

| # | Task | Priority |
|---|------|----------|
| 2.1 | Global Kill-Switch di Firestore | P0 |
| 2.2 | Promise.allSettled di fetchMarketDataWithIndicators | P1 |
| 2.3 | Fix hardcoded LEVERAGE = 20 → config user per symbol | P1 |
| 2.4 | Max Drawdown Guard | P1 |
| 2.5 | LLM Circuit Breaker | P1 |
| 2.6 | Exposure Limit per koin + total portfolio | P2 |
| 2.7 | Unpause Step 1C-1b (setelah 1.4) | P1 |
| 2.8 | Aktivasi HF-3 (setelah 1.4) | P1 |

### Phase 3 — Arsitektur (60 Hari)

| # | Task | Priority |
|---|------|----------|
| 3.1 | Decimal.js untuk seluruh kalkulasi wallet/margin/PnL | P1 |
| 3.2 | Reconciliation Loop (Ghost Position detection) | P1 |
| 3.3 | Structured Logging (Pino → JSON) | P2 |
| 3.4 | Metrics endpoint /metrics | P2 |
| 3.5 | CCXT Symbol Adapter class | P2 |
| 3.6 | backgroundSyncFirestore → FIFO queue + retry | P2 |
| 3.7 | Finalisasi parity_v2, retire legacy paper engine | P1 |

### Phase 4 — Advanced (90 Hari)

| # | Task | Priority |
|---|------|----------|
| 4.1 | Decouple LLM ke background worker | P2 |
| 4.2 | REST Polling → CCXT Pro WebSockets | P2 |
| 4.3 | In-memory state → Redis | P3 |
| 4.4 | Event-Sourced Backtesting Engine | P3 |
| 4.5 | API Key → GCP Secret Manager | P3 |

---

## 5. SOP TRADING — REFERENSI CEPAT

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

## 6. REGRESSION CHECKLIST

Jalankan checklist ini **sebelum setiap commit**.

### A. Codebase Guardrail

```
[ ] Sentuhan server.ts HANYA pada paper evaluator seam
[ ] Tidak ubah live execution path
[ ] Tidak ubah fetchMarketDataWithIndicators (kecuali task 2.2)
[ ] Tidak ganti canonical enum parity
[ ] Regression pack_v2 HIJAU
[ ] Regression pack_aux HIJAU
[ ] HF-3 tetap OFF
[ ] Step 1C-1b tetap PAUSED
```

### B. Safety Controls

```
[ ] Kill-Switch tersedia dan berfungsi (setelah Phase 2.1)
[ ] clientOrderId ada pada setiap createOrder
[ ] Max Drawdown guard aktif (setelah Phase 2.4)
[ ] LLM Circuit Breaker aktif (setelah Phase 2.5)
[ ] Reconciliation setelah NetworkError (setelah Phase 3.2)
```

### C. Data Integrity

```
[ ] Leverage diambil dari config user, bukan hardcoded
[ ] fetchMarketDataWithIndicators pakai Promise.allSettled
[ ] Kalkulasi finansial pakai Decimal.js (setelah Phase 3.1)
[ ] backgroundSyncFirestore ada ordering guarantee (setelah Phase 3.6)
[ ] Symbol normalization konsisten (setelah Phase 3.5)
```

### D. Parity V2

```
[ ] Feature flag PAPER_ENGINE_MODE=parity_v2 aktif
[ ] SR-06, SR-10, SR-11, SR-12 tetap sinkron
[ ] AUX-01/02/03 terpisah dan tidak interfere
[ ] Legacy paper engine deprecated setelah parity_v2 stable
```

---

## 7. CONVENTIONS & PATTERNS

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

### Naming Conventions

| Konsep | Nama di Kode |
|--------|-------------|
| Qty lock aktif | `ActiveLockBaseQty` |
| Tambah 50% | `ADD_LONG_0.5` / `ADD_SHORT_0.5` |
| Kurangi 50% | `REDUCE_LONG_0.5` / `REDUCE_SHORT_0.5` |
| Struktur klasifikasi | `classifyStructure()` dengan toleransi 0.95–1.05 |
| BEP | `BEP_GROSS_PRICE` (tanpa fee) / `BEP_NET_PRICE` (dengan fee) |

### Error Handling

- Firestore: gunakan `withFirestoreFailSoft` wrapper — jangan blocking.
- CCXT calls: selalu handle `NetworkError`, `ExchangeError`, `RateLimitExceeded`.
- Gemini API: set timeout, handle hang scenario.
- Async sync: `backgroundSyncFirestore` — fire-and-forget tapi log errors.

---

## 8. WORKFLOW UNTUK CLAUDE CODE

Ketika user memberikan task:

1. **Baca section 2 (Golden Rules)** — pastikan task tidak melanggar guardrail.
2. **Identifikasi file** — navigasi ke file yang relevan, baca konteks sekitar.
3. **Edit minimal** — jangan refactor hal yang tidak diminta.
4. **Type-check** — jalankan `npx tsc --noEmit` setelah edit.
5. **Regression** — jalankan regression pack jika tersedia.
6. **Report** — jelaskan apa yang diubah dan file mana yang tersentuh.

Jika task ambigu atau berpotensi menyentuh live execution path → **TANYA USER DULU**, jangan asumsi.

---

## 9. DECISION LOG

| Tanggal | Keputusan | Alasan |
|---------|-----------|--------|
| 2026-04-08 | Adopt Gemini audit findings ke roadmap | External review valid |
| 2026-04-08 | clientOrderId jadi P0 | Double order = financial loss |
| 2026-04-08 | Kill-Switch jadi P0 Phase 2 | Tidak ada emergency brake |
| 2026-04-08 | WebSockets/Redis tetap Phase 4 | Semi-auto + pair terbatas, REST cukup |
| 2026-04-08 | CLAUDE.md dibuat | Agar Claude Code punya full context setiap session |
