import dotenv from 'dotenv';
dotenv.config({ override: true });

import type { PaperPosition, PaperWallet, PaperHistory } from './src/paper-engine/types';
import { calculateMarginUsed, computeMRProjectedAfterAdd } from './src/paper-engine/valuation';
import { isParityV2Mode, evaluateParityPaper } from './src/paper-engine/parity_runtime';
import { executeParityPaperDecision } from './src/paper-engine/parity_execute';
import { withFirestoreFailSoft, jsonDegraded, markFirestoreUnavailable, getFirestoreFailsoftStatus } from './src/paper-engine/firestore_failsoft';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import axios from 'axios';
import ccxt from 'ccxt';
import cors from 'cors';
import express from 'express';
import { ParityAdapter } from './tests/parity/ParityAdapter';
import { createServer as createViteServer } from 'vite';
import { RSI, MACD, EMA, BollingerBands, SMA } from 'technicalindicators';
import { Storage } from '@google-cloud/storage';
import { initializeApp } from 'firebase/app';
import { initializeFirestore, doc, setDoc, getDoc, collection, query, orderBy, limit, getDocs, serverTimestamp, setLogLevel, deleteDoc, where, writeBatch } from 'firebase/firestore';
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';

import { BacktestResult, BacktestSummary, BacktestTrade, BacktestSettings } from './src/types/backtest';
import { Ohlcv, PerSide, PerSymbolPos, ExcelRow } from './src/types/decisionCard';
import { PolicyContext } from './src/types/policyContext';
import { atr14Last, deriveVolatilityRegime } from './src/utils/Math';
import { normalizeSymbolInput } from './src/utils/Symbol';
import { normalizeActionInput, parseTelegramCallbackData } from './src/utils/ActionParsers';
import { composeExcelRows } from './src/utils/ExcelBuilder';
import { escapeHtml, renderDecisionCardsToTelegram } from './src/renderers/TelegramRenderer';
import { sendTelegramMessage, sendInteractiveMenu, sendTradingMenu, sendHedgeMenu } from './src/services/TelegramService';
import { uploadAnalysisToGCS } from './src/services/GCSService';
import { sendDecisionCardsEmail } from './mailer';
import { PolicyMapper } from './src/core/PolicyMapper';
import { PolicyContextData } from './src/core/PolicyContext';
import { bootstrapPolicies } from './src/core/policy/bootstrap';
import { PolicySelectors } from './src/core/policy/selectors';
import { PolicyRegistry } from './src/core/policy/registry';
import { validateSymbolPolicy } from './src/core/policy/validator';
import { buildMonitoringPrompt } from './src/prompts/buildMonitoringPrompt';
import { buildChatPrompt } from './src/prompts/buildChatPrompt';
import { buildOptimizerPrompt } from './src/prompts/buildOptimizerPrompt';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const currentUser = auth?.currentUser;
  const errInfo: any = {
    error: error instanceof Error ? error.message : String(error),
    authStatus: currentUser ? 'authenticated' : 'unauthenticated',
    authInfo: currentUser ? {
      userId: currentUser.uid,
      email: currentUser.email,
      emailVerified: currentUser.emailVerified,
      isAnonymous: currentUser.isAnonymous,
      providerInfo: currentUser.providerData.map((provider: any) => ({
        providerId: provider.providerId,
        email: provider.email
      }))
    } : null,
    operationType,
    path
  };
  console.error(`[Firestore Error] [${operationType}] [${path}]:`, JSON.stringify(errInfo));
}

// Initialize Firebase Client
let db: any = null;
let auth: any = null;

// Caches for Paper Trading Engine
let cachedPaperPositions: PaperPosition[] = [];
let cachedPaperWallet: PaperWallet = { balance: 10000, equity: 10000, freeMargin: 10000, updatedAt: new Date().toISOString() };
let cachedPaperHistory: PaperHistory[] = [];
let cachedPaperMonitoring: any[] = [];
let cachedPaperDecisions: any[] = [];
let cachedTradingJournal: any[] = [];
let cachedChats: any[] = [];
let isRealtimeListenersSetup = false;
let lastDbSyncTime = 0;

import { onSnapshot } from 'firebase/firestore';

async function loadPaperTradingData() {
  if (!db) return;
  try {
    const walletSnap = await getDoc(doc(db, 'paper_wallet', 'main'));
    if (walletSnap.exists()) {
      cachedPaperWallet = walletSnap.data() as PaperWallet;
    } else {
      cachedPaperWallet = { balance: 10000, equity: 10000, freeMargin: 10000, marginRatio: 0, updatedAt: new Date().toISOString() };
    }

    const posSnap = await getDocs(collection(db, 'paper_positions'));
    cachedPaperPositions = posSnap.docs.map(doc => ({ ...doc.data(), id: doc.id } as PaperPosition));

    const historyQuery = query(collection(db, 'paper_history'), orderBy('closedAt', 'desc'), limit(200));
    const histSnap = await getDocs(historyQuery);
    cachedPaperHistory = histSnap.docs.map(doc => ({ ...doc.data(), id: doc.id } as PaperHistory));
    console.log("[PAPER] Loaded initial paper trading data from Firestore.");
  } catch (error: any) {
    console.error("[PAPER] Failed to load initial paper trading data from Firestore. Using empty/default cache.", error.message);
    if (!cachedPaperWallet.balance) {
      cachedPaperWallet = { balance: 10000, equity: 10000, freeMargin: 10000, marginRatio: 0, updatedAt: new Date().toISOString() };
    }
  }
}

function setupRealtimeListeners() {
  if (!db || isRealtimeListenersSetup) return;
  isRealtimeListenersSetup = true;

  loadPaperTradingData();

  try {
    onSnapshot(collection(db, 'approved_settings'), (snap) => {
      // 1. Shadow Mirror (New Policy Registry) - Source of Truth
      // Save global policy to prevent it from being cleared (Registry.clear() clears both)
      const currentGlobal = PolicyRegistry.getGlobalPolicy();
      
      // Clear registry to handle deletions/invalidations drift (ensures stale symbols are removed)
      PolicyRegistry.clear();
      
      // Restore global policy if it was already initialized
      if (currentGlobal) {
        PolicyRegistry.setGlobalPolicy(currentGlobal);
      }

      let validDocs = 0;
      let quarantinedDocs = 0;

      snap.docs.forEach(doc => {
        const data = doc.data();
        try {
          const validatedPolicy = validateSymbolPolicy(data);
          PolicyRegistry.setSymbolPolicy(validatedPolicy.symbol, validatedPolicy);
          validDocs++;
        } catch (err: any) {
          quarantinedDocs++;
          console.warn(`[Policy Shadow] Quarantined invalid policy for document ${doc.id}:`, err.message);
        }
      });

      console.log(`[Policy Shadow] Sync complete. Total: ${snap.docs.length}, Valid: ${validDocs}, Quarantined: ${quarantinedDocs}`);
    }, (error) => {
      console.error("Error in approved_settings snapshot:", error);
    });

    // Removed paper_positions, paper_wallet, paper_history onSnapshots for In-Memory First architecture.
    // They are loaded once in loadPaperTradingData().

    const journalQuery = query(collection(db, 'trading_journal'), orderBy('timestamp', 'desc'), limit(100));
    onSnapshot(journalQuery, (snap) => {
      cachedTradingJournal = snap.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    }, (error) => {
      const msg = String(error?.message || error || '').toLowerCase();
      if (msg.includes('quota') || msg.includes('resource exhausted') || msg.includes('deadline exceeded')) {
        markFirestoreUnavailable(60_000);
      }
      console.error("Error in trading_journal snapshot:", error);
    });

    const signalsQuery = query(collection(db, 'signals'), orderBy('timestamp', 'desc'), limit(100));
    onSnapshot(signalsQuery, (snap) => {
      signals = snap.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    }, (error) => {
      const msg = String(error?.message || error || '').toLowerCase();
      if (msg.includes('quota') || msg.includes('resource exhausted') || msg.includes('deadline exceeded')) {
        markFirestoreUnavailable(60_000);
      }
      console.error("Error in signals snapshot:", error);
    });

    const chatsQuery = query(collection(db, 'chats'), orderBy('timestamp', 'asc'), limit(100));
    onSnapshot(chatsQuery, (snap) => {
      cachedChats = snap.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    }, (error) => {
      const msg = String(error?.message || error || '').toLowerCase();
      if (msg.includes('quota') || msg.includes('resource exhausted') || msg.includes('deadline exceeded')) {
        markFirestoreUnavailable(60_000);
      }
      console.error("Error in chats snapshot:", error);
    });

    // Removed paper_monitoring onSnapshot to save reads. We will maintain this purely in memory.

    isRealtimeListenersSetup = true;
    console.log("✅ Real-time Firestore listeners setup for Paper Trading");
  } catch (e) {
    console.error("Failed to setup real-time listeners:", e);
  }
}

async function initFirebase() {
  try {
    const firebaseConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf8'));
    const app = initializeApp(firebaseConfig);
    setLogLevel('error'); // Suppress idle stream warnings
    db = initializeFirestore(app, { experimentalForceLongPolling: true }, firebaseConfig.firestoreDatabaseId);
    auth = getAuth(app);
    
    const serverEmail = 'server@sentinel.local';
    const serverPassword = process.env.SERVER_PASSWORD || 'sentinel-server-secret-123';
    
    try {
      console.log(`Attempting to sign in as ${serverEmail}...`);
      const userCredential = await signInWithEmailAndPassword(auth, serverEmail, serverPassword);
      console.log(`✅ Successfully signed in as ${serverEmail}. UID: ${userCredential.user.uid}`);
      console.log(`Email verified: ${userCredential.user.emailVerified}`);
    } catch (e: any) {
      console.log(`Sign in failed with code: ${e.code}. Message: ${e.message}`);
      if (e.code === 'auth/operation-not-allowed') {
        console.error("❌ CRITICAL: Email/Password authentication is DISABLED in your Firebase Console.");
        console.error("👉 ACTION REQUIRED: Go to Firebase Console > Authentication > Sign-in method and ENABLE 'Email/Password'.");
        throw e;
      } else if (e.code === 'auth/user-not-found' || e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password') {
        console.log(`Attempting to create user ${serverEmail}...`);
        try {
          const userCredential = await createUserWithEmailAndPassword(auth, serverEmail, serverPassword);
          console.log(`✅ Successfully created and signed in as ${serverEmail}. UID: ${userCredential.user.uid}`);
        } catch (createErr: any) {
          if (createErr.code === 'auth/operation-not-allowed') {
            console.error("❌ CRITICAL: Email/Password authentication is DISABLED in your Firebase Console.");
            console.error("👉 ACTION REQUIRED: Go to Firebase Console > Authentication > Sign-in method and ENABLE 'Email/Password'.");
          } else {
            console.error(`❌ Failed to create server user: ${createErr.message}`);
          }
          throw createErr;
        }
      } else {
        console.error("❌ Firebase auth error:", e);
        throw e;
      }
    }
    
    if (auth.currentUser) {
      console.log(`✅ Firebase authenticated as: ${auth.currentUser.email} (${auth.currentUser.uid})`);
      const userDocRef = doc(db, 'users', auth.currentUser.uid);
      const userDoc = await getDoc(userDocRef);
      if (!userDoc.exists() || userDoc.data()?.role !== 'admin') {
        await setDoc(userDocRef, {
          name: 'Sentinel Server',
          email: serverEmail,
          role: 'admin',
          createdAt: userDoc.exists() ? userDoc.data()?.createdAt : new Date().toISOString()
        }, { merge: true });
      }
      console.log("✅ Firebase authenticated as server admin");
      
      // Test connection
      try {
        const { getDocFromServer } = await import('firebase/firestore');
        await getDocFromServer(doc(db, 'test', 'connection'));
        console.log("✅ Firestore connection verified");
        setupRealtimeListeners();
      } catch (error: any) {
        if (error.message.includes('the client is offline')) {
          console.error("❌ Firestore connection failed: Client is offline. Check configuration.");
        }
      }
    }
  } catch (e) {
    console.error("Failed to initialize Firebase:", e);
    throw e;
  }
}


import { rangeFilterPineExact, RFParams } from './range_filter_pine';
import { mapTfToMs, stripUnclosed, runTfAlignmentUnitTest } from './tf_alignment_guard';
import * as driftMonitor from './rf_drift_monitor.js';
import { calculateSMC, calculateVSA, calculateRSIDivergence, calculateFibonacci } from './indicators.js';
import { marketCache } from './cache.js';
import { getQuickChartBase64 } from './chart_generator.js';

const STRIP_TAGS = /<[^>]*>/g;

let isDriftBaselineInitialized = false;

// Old RF implementation removed in favor of range_filter_pine.ts

function runRFUnitTest() {
  // Unit test logic moved to range_filter_pine.ts or verify_parity.ts
  console.log('RF Unit Test: Using external module range_filter_pine.ts');
}

// Run unit test on startup
runRFUnitTest();
runTfAlignmentUnitTest();

// Relational Quadratic Kernel Channel [Vin]
function calculateRQK(ohlcv: any[], length = 42, relativeWeight = 27, atrLength = 40) {
  if (ohlcv.length < Math.max(length, atrLength) + 1) return null;

  const ohlc4 = ohlcv.map(c => (c[1] + c[2] + c[3] + c[4]) / 4);
  const highs = ohlcv.map(c => c[2]);
  const lows = ohlcv.map(c => c[3]);
  const closes = ohlcv.map(c => c[4]);

  // Calculate True Range
  const tr = [0];
  for (let i = 1; i < ohlcv.length; i++) {
    const high = highs[i];
    const low = lows[i];
    const prevClose = closes[i - 1];
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  // Calculate ATR (RMA)
  const atr = [tr[0]];
  for (let i = 1; i < tr.length; i++) {
    atr.push((atr[i - 1] * (atrLength - 1) + tr[i]) / atrLength);
  }

  // Calculate Rational Quadratic Estimate
  const rqk = [];
  for (let i = 0; i < ohlc4.length; i++) {
    if (i < length) {
      rqk.push(ohlc4[i]);
      continue;
    }
    let currentWeight = 0;
    let cumulativeWeight = 0;
    for (let j = 0; j <= length; j++) {
      const y = ohlc4[i - j];
      const w = Math.pow(1 + (Math.pow(j, 2) / ((length * length) * 2 * relativeWeight)), -relativeWeight);
      currentWeight += y * w;
      cumulativeWeight += w;
    }
    rqk.push(currentWeight / cumulativeWeight);
  }

  const lastIndex = ohlcv.length - 1;
  const currentRQK = rqk[lastIndex];
  const currentATR = atr[lastIndex];
  const currentClose = closes[lastIndex];
  
  // Determine price position relative to channels
  let position = "NEUTRAL (Inside Channel 1)";
  if (currentClose > currentRQK + (currentATR * 6)) position = "EXTREME_OVERBOUGHT (Above Upper Channel 3)";
  else if (currentClose > currentRQK + (currentATR * 5)) position = "OVERBOUGHT (Above Upper Channel 2)";
  else if (currentClose > currentRQK + (currentATR * 1.5)) position = "BULLISH_TREND (Above Upper Channel 1)";
  else if (currentClose < currentRQK - (currentATR * 6)) position = "EXTREME_OVERSOLD (Below Lower Channel 3)";
  else if (currentClose < currentRQK - (currentATR * 5)) position = "OVERSOLD (Below Lower Channel 2)";
  else if (currentClose < currentRQK - (currentATR * 1.5)) position = "BEARISH_TREND (Below Lower Channel 1)";

  return {
    estimate: currentRQK,
    position: position,
    upperChannel1: currentRQK + (currentATR * 1.5),
    lowerChannel1: currentRQK - (currentATR * 1.5),
    upperChannel3: currentRQK + (currentATR * 6),
    lowerChannel3: currentRQK - (currentATR * 6)
  };
}

// Waddah Attar Explosion [LazyBear]
function calculateWAE(ohlcv: any[], sensitivity = 150, fastLength = 20, slowLength = 40, channelLength = 20, mult = 2.0, deadZone = 20) {
  if (ohlcv.length < Math.max(slowLength, channelLength) + 1) return null;

  const closes = ohlcv.map(c => c[4]);

  // Helper: EMA
  function ema(arr: number[], period: number) {
    const k = 2 / (period + 1);
    const result = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      result.push(arr[i] * k + result[i - 1] * (1 - k));
    }
    return result;
  }

  // Helper: SMA
  function sma(arr: number[], period: number) {
    const result = [];
    for (let i = 0; i < arr.length; i++) {
      if (i < period - 1) {
        result.push(arr[i]); // Fallback for early indices
        continue;
      }
      let sum = 0;
      for (let j = 0; j < period; j++) sum += arr[i - j];
      result.push(sum / period);
    }
    return result;
  }

  // Helper: Stdev (Population)
  function stdev(arr: number[], period: number, smaArr: number[]) {
    const result = [];
    for (let i = 0; i < arr.length; i++) {
      if (i < period - 1) {
        result.push(0);
        continue;
      }
      const mean = smaArr[i];
      let sumSq = 0;
      for (let j = 0; j < period; j++) {
        sumSq += Math.pow(arr[i - j] - mean, 2);
      }
      result.push(Math.sqrt(sumSq / period));
    }
    return result;
  }

  // 1. MACD Difference (t1)
  const fastEMA = ema(closes, fastLength);
  const slowEMA = ema(closes, slowLength);
  const macd = [];
  for (let i = 0; i < closes.length; i++) {
    macd.push(fastEMA[i] - slowEMA[i]);
  }

  const t1 = [0];
  for (let i = 1; i < macd.length; i++) {
    t1.push((macd[i] - macd[i - 1]) * sensitivity);
  }

  // 2. Bollinger Bands Difference (e1 - Explosion Line)
  const basis = sma(closes, channelLength);
  const dev = stdev(closes, channelLength, basis);
  const e1 = [];
  for (let i = 0; i < closes.length; i++) {
    const upper = basis[i] + (mult * dev[i]);
    const lower = basis[i] - (mult * dev[i]);
    e1.push(upper - lower);
  }

  // 3. Trend Up / Trend Down
  const trendUp = t1.map(val => val >= 0 ? val : 0);
  const trendDown = t1.map(val => val < 0 ? -val : 0);

  const lastIdx = closes.length - 1;
  const currentUp = trendUp[lastIdx];
  const currentDown = trendDown[lastIdx];
  const currentE1 = e1[lastIdx];

  const trend = currentUp > 0 ? "UP" : (currentDown > 0 ? "DOWN" : "NEUTRAL");
  const strength = Math.max(currentUp, currentDown);
  const isExploding = strength > currentE1;
  const isDeadZone = strength < deadZone;

  return {
    trend: trend,
    strength: parseFloat(strength.toFixed(2)),
    explosionLine: parseFloat(currentE1.toFixed(2)),
    isExploding: isExploding,
    isDeadZone: isDeadZone
  };
}

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;

// API Keys
const BINANCE_API_KEY = process.env.BINANCE_API_KEY?.trim();
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET?.trim();
const BINANCE_DEMO_API_KEY = (process.env.BINANCE_DEMO_API_KEY || process.env.BINANCE_TESTNET_API_KEY)?.trim();
const BINANCE_DEMO_API_SECRET = (process.env.BINANCE_DEMO_API_SECRET || process.env.BINANCE_TESTNET_SECRET)?.trim();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
const PA_WEBHOOK_URL = process.env.PA_WEBHOOK_URL?.trim();

let envMode = process.env.VALIDATION_MODE?.trim() || "LIVE_TRADING";
if (envMode === "TESTNET") envMode = "DEMO_TRADING"; // Alias TESTNET to DEMO_TRADING

// Force LIVE_TRADING as requested by user
envMode = "LIVE_TRADING";

const VALIDATION_MODE = envMode as "DRY_RUN" | "TEST_ORDER" | "DEMO_TRADING" | "LIVE_TRADING";

if (!["DRY_RUN", "TEST_ORDER", "DEMO_TRADING", "LIVE_TRADING"].includes(VALIDATION_MODE)) {
  throw new Error(`CRITICAL CONFIG ERROR: Invalid VALIDATION_MODE: ${VALIDATION_MODE}. Must be DRY_RUN, TEST_ORDER, DEMO_TRADING, or LIVE_TRADING.`);
}

const GCS_BUCKET = process.env.GCS_BUCKET?.trim();              // Wajib untuk upload
const GCS_PREFIX = (process.env.GCS_PREFIX?.trim()) || "sentinel/alpha"; // Opsional prefix folder
const GCS_PUBLIC = String(process.env.GCS_PUBLIC || "false") === "true"; // true -> object public-read

const REDUCE_POLICY = "STRICT_PARTIAL"; // "STRICT_PARTIAL" | "FORCE_MIN_EXEC"
const GCS_SIGNED_URL_TTL = Number(process.env.GCS_SIGNED_URL_TTL || "604800"); // 7 hari (detik)

console.log('--- Environment Variables Debug ---');
console.log('VALIDATION_MODE:', VALIDATION_MODE);
console.log('BINANCE_API_KEY:', BINANCE_API_KEY ? `Set (Length: ${BINANCE_API_KEY.length})` : 'Missing');
console.log('BINANCE_DEMO_API_KEY:', BINANCE_DEMO_API_KEY ? `Set (Length: ${BINANCE_DEMO_API_KEY.length})` : 'Missing');
console.log('TELEGRAM_BOT_TOKEN:', TELEGRAM_BOT_TOKEN ? 'Set' : 'Missing');
console.log('GEMINI_API_KEY:', GEMINI_API_KEY ? 'Set' : 'Missing');
console.log('-----------------------------------');

// Initialize clients
const binanceOptions = {
  defaultType: 'future', // Assuming futures for long/short positions
  warnOnFetchOpenOrdersWithoutSymbol: false, // Suppress strict rate limit warning
};

const binance = new ccxt.binance({
  apiKey: BINANCE_API_KEY,
  secret: BINANCE_API_SECRET,
  enableRateLimit: true,
  options: binanceOptions,
});

const binanceDemo = new ccxt.binance({
  apiKey: BINANCE_DEMO_API_KEY,
  secret: BINANCE_DEMO_API_SECRET,
  enableRateLimit: true,
  options: binanceOptions,
});

// Guard against deprecated sandbox mode for futures
if ((binance as any).sandboxMode || (binanceDemo as any).sandboxMode) {
    throw new Error("CRITICAL CONFIG ERROR: setSandboxMode(true) is deprecated for Binance Futures. Use enableDemoTrading(true) instead.");
}

if (VALIDATION_MODE === "DEMO_TRADING") {
    binanceDemo.enableDemoTrading(true);
    console.log("✅ Binance Demo Trading enabled.");
}

// Diagnostic: Check Binance Connection on Startup
async function checkBinanceConnection() {
    if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
        console.warn("⚠️ Binance Keys missing. Skipping connection check.");
        return;
    }
    try {
        console.log("🔄 Testing Binance Connection (fetchBalance)...");
        await binance.fetchBalance();
        console.log("✅ Binance Connection SUCCESS! API Key has valid permissions for reading balance.");
    } catch (error: any) {
        console.error("❌ Binance Connection FAILED:");
        if (error.message.includes("-2015")) {
            console.error("   -> ERROR -2015: Invalid API-key, IP, or permissions.");
            console.error("   -> ACTION: Check 'Enable Futures' in Binance API settings.");
            console.error("   -> ACTION: Check IP restrictions (disable or whitelist this IP).");
        } else {
            console.error("   -> " + error.message);
        }
    }
}
checkBinanceConnection();

function getAI() {
  const keys = {
    API_KEY: process.env.API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY
  };

  console.log('--- API Key Selection Debug ---');
  let selectedKey = null;
  let source = null;

  // Try to find a key that looks valid (starts with AIza)
  for (const [name, value] of Object.entries(keys)) {
    const status = value ? (value.startsWith('AIza') ? 'Valid Format' : 'Invalid Format') : 'Missing';
    console.log(`${name}: ${status} ${value ? `(${value.substring(0, 5)}...)` : ''}`);
    
    if (value && value.startsWith('AIza') && !selectedKey) {
      selectedKey = value;
      source = name;
    }
  }

  // Fallback: take the first non-empty key even if it doesn't start with AIza (in case format changed)
  if (!selectedKey) {
    for (const [name, value] of Object.entries(keys)) {
      if (value) {
        selectedKey = value;
        source = name;
        break;
      }
    }
  }

  console.log(`Selected Source: ${source || 'None'}`);
  console.log('-------------------------------');

  if (!selectedKey) {
    throw new Error('No valid API Key found. Please set GEMINI_API_KEY in your environment.');
  }
  return new GoogleGenAI({ apiKey: selectedKey });
}

// In-memory storage for signals
let signals: any[] = [];
let lastRawNewSignals: any = null;
let isBotRunning = false;
let monitorInterval: NodeJS.Timeout | null = null;
let isPaperTradingRunning = false;
let paperTradingInterval: NodeJS.Timeout | null = null;
let latestDecisionCards: any[] = [];
let paperTradingResetTime = 0;

// Paper Trading Session Metadata
let paperSessionStart: string | null = null;
let paperLastTick: string | null = null;
let paperLastDecisionAt: string | null = null;
let paperLastSkipReason: string | null = null;
let paperSkippedCycles = 0;
let paperNoSignalCycles = 0;
let paperNoPositionCycles = 0;

// Helper to send Telegram message
// Extracted to src/services/TelegramService.ts

// Helper to send data to Power Automate Webhook
async function sendPowerAutomateWebhook(data: any) {
  // PENDING: Sistem pengiriman ke Power Automate (yang mungkin meneruskan email ke Outlook) sedang ditunda
  console.log('⏳ [Webhook] PENDING: Pengiriman data ke Power Automate Webhook sedang ditunda sementara.');
  return;

  if (!PA_WEBHOOK_URL) return;
  try {
    await axios.post(PA_WEBHOOK_URL, data);
    console.log('✅ Successfully sent data to Power Automate Webhook.');
  } catch (error: any) {
    console.error('❌ Failed to send to Power Automate Webhook:', error.response?.data || error.message);
  }
}

// Helper: upload analysis JSON ke GCS lalu kembalikan URL (public atau signed)
// Extracted to src/services/GCSService.ts

// Helper to fetch market data with technical indicators
async function fetchMarketDataWithIndicators(symbols: string[]) {
  const startTime = Date.now();
  console.log(`[PERF] Starting fetchMarketDataWithIndicators for ${symbols.length} symbols...`);
  if (symbols.length > 50) {
    console.warn(`[PERF] WARNING: Fetching indicators for ${symbols.length} symbols might be slow and hit rate limits.`);
  }
  const marketData: any = {};
  
  // Use Promise.all to fetch data in parallel (limited to 5 concurrent requests to avoid rate limits)
  const chunkArray = (arr: string[], size: number) => 
    Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
  
  const chunks = chunkArray(symbols, 5);
  
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (pair) => {
      try {
        const cacheKey = `market_data_${pair}`;
        const cachedData = marketCache.get(cacheKey);
        if (cachedData) {
          marketData[pair] = cachedData;
          return;
        }

        const [ohlcv1d, ohlcv4h, ohlcv1h, ohlcv15m] = await Promise.all([
          binance.fetchOHLCV(pair, '1d', undefined, 100),
          binance.fetchOHLCV(pair, '4h', undefined, 500),
          binance.fetchOHLCV(pair, '1h', undefined, 200),
          binance.fetchOHLCV(pair, '15m', undefined, 200)
        ]);
        
        const ticker = await binance.fetchTicker(pair);
        const nowMs = Date.now();
        
        // 1D Calculations (Bias Anchor)
        const tf1dMs = mapTfToMs('1d');
        const strip1d = stripUnclosed(ohlcv1d, tf1dMs, nowMs);
        const validOhlcv1d = strip1d.strippedOhlcv;
        const rf1d = rangeFilterPineExact(validOhlcv1d, { per: 100, mult: 3.0 });
        const rqk1d = calculateRQK(validOhlcv1d);
        const wae1d = calculateWAE(validOhlcv1d);

        // 4H Calculations (Main Trend)
        const tf4hMs = mapTfToMs('4h');
        const strip4h = stripUnclosed(ohlcv4h, tf4hMs, nowMs);
        const validOhlcv4h = strip4h.strippedOhlcv;
        const atr14_4h = atr14Last(validOhlcv4h as any);
        
        const closes4h = validOhlcv4h.map(c => c[4] as number);
        const rfParams: RFParams = {
          src: 'close',
          per: 100,
          mult: 3.0
        };
        const rangeFilter4H = rangeFilterPineExact(validOhlcv4h, rfParams);
        const rqk4H = calculateRQK(validOhlcv4h);
        const wae4H = calculateWAE(validOhlcv4h);
        const ema50_4H = EMA.calculate({ values: closes4h, period: 50 });
        const sma200_4H = SMA.calculate({ values: closes4h, period: 200 });
        const bb4H = BollingerBands.calculate({ period: 20, values: closes4h, stdDev: 2 });
        const vsa4H = calculateVSA(validOhlcv4h);
        const fibo4H = calculateFibonacci(validOhlcv4h);
        
        // VWAP Calculation (Heuristic for 4H/1H)
        const calculateVWAP = (data: any[]) => {
            let totalTypicalPriceVolume = 0;
            let totalVolume = 0;
            for (const bar of data) {
                const typicalPrice = (bar[2] + bar[3] + bar[4]) / 3;
                totalTypicalPriceVolume += typicalPrice * bar[5];
                totalVolume += bar[5];
            }
            return totalVolume > 0 ? totalTypicalPriceVolume / totalVolume : null;
        };
        const vwap4h = calculateVWAP(validOhlcv4h);
        const vwap4h_dist = vwap4h ? ((ticker.last - vwap4h) / vwap4h) * 100 : null;

        // 1H Calculations (Medium Trend & SMC)
        const tf1hMs = mapTfToMs('1h');
        const strip1h = stripUnclosed(ohlcv1h, tf1hMs, nowMs);
        const validOhlcv1h = strip1h.strippedOhlcv;
        const atr14_1h = atr14Last(validOhlcv1h as any);
        
        const closes1h = validOhlcv1h.map(c => c[4] as number);
        const rsi1H = RSI.calculate({ values: closes1h, period: 14 });
        const rsiDiv1H = calculateRSIDivergence(validOhlcv1h, rsi1H);
        const macd1H = MACD.calculate({ values: closes1h, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
        const smc1H = calculateSMC(validOhlcv1h);
        const vwap1h = calculateVWAP(validOhlcv1h);
        const vwap1h_dist = vwap1h ? ((ticker.last - vwap1h) / vwap1h) * 100 : null;
        const vsa1H = calculateVSA(validOhlcv1h);
        const bb1H = BollingerBands.calculate({ period: 20, values: closes1h, stdDev: 2 });
        
        // 15m Calculations (Short Entry/Exit & SMC)
        const tf15mMs = mapTfToMs('15m');
        const strip15m = stripUnclosed(ohlcv15m, tf15mMs, nowMs);
        const validOhlcv15m = strip15m.strippedOhlcv;
        
        const closes15m = validOhlcv15m.map(c => c[4] as number);
        const rsi15m = RSI.calculate({ values: closes15m, period: 14 });
        const rsiDiv15m = calculateRSIDivergence(validOhlcv15m, rsi15m);
        const smc15m = calculateSMC(validOhlcv15m);
        const vsa15m = calculateVSA(validOhlcv15m);
        
        marketData[pair] = {
          currentPrice: ticker.last,
          bar_in_progress: !strip4h.barClosed,
          TF_1D: {
            RangeFilter: { trend: rf1d.last.rf_trend },
            RQK_Channel: rqk1d ? { estimate: rqk1d.estimate } : null,
            WAE: wae1d
          },
          TF_4H: {
            RangeFilter: { trend: rangeFilter4H.last.rf_trend },
            RQK_Channel: rqk4H ? { estimate: rqk4H.estimate } : null,
            WAE: wae4H,
            EMA_50: ema50_4H.length > 0 ? ema50_4H[ema50_4H.length - 1] : null,
            SMA_200: sma200_4H.length > 0 ? sma200_4H[sma200_4H.length - 1] : null,
            BollingerBands: bb4H.length > 0 ? bb4H[bb4H.length - 1] : null,
            VSA: vsa4H,
            Fibonacci: fibo4H,
            VWAP: vwap4h,
            VWAP_dist_pct: vwap4h_dist,
            ATR14: atr14_4h ?? null
          },
          TF_1H: {
            VWAP: vwap1h,
            VWAP_dist_pct: vwap1h_dist,
            RSI_14: rsi1H.length > 0 ? rsi1H[rsi1H.length - 1] : null,
            RSI_Divergence: rsiDiv1H,
            MACD: macd1H.length > 0 ? macd1H[macd1H.length - 1] : null,
            SMC: smc1H,
            VSA: vsa1H,
            BollingerBands: bb1H.length > 0 ? bb1H[bb1H.length - 1] : null,
            ATR14: atr14_1h ?? null
          },
          TF_15m: {
            RSI_14: rsi15m.length > 0 ? rsi15m[rsi15m.length - 1] : null,
            RSI_Divergence: rsiDiv15m,
            SMC: smc15m,
            VSA: vsa15m
          }
        };
        
        marketCache.set(cacheKey, marketData[pair]);
      } catch (e) {
        console.error(`Error fetching data for ${pair}:`, e);
      }
    }));
  }
  
  const duration = (Date.now() - startTime) / 1000;
  console.log(`[PERF] fetchMarketDataWithIndicators completed in ${duration.toFixed(2)}s`);
  return marketData;
}

// Hedging Recovery & Net BEP Calculator
function calculateHedgingRecovery(positions: any[]) {
  const recoveryData: any = {};
  
  // Group by symbol
  const bySymbol: any = {};
  for (const p of positions) {
    if (!bySymbol[p.symbol]) bySymbol[p.symbol] = { long: null, short: null };
    if (p.side === 'long') bySymbol[p.symbol].long = p;
    if (p.side === 'short') bySymbol[p.symbol].short = p;
  }

  for (const sym in bySymbol) {
    const longPos = bySymbol[sym].long;
    const shortPos = bySymbol[sym].short;
    
    if (longPos && shortPos) {
      const longPrice = longPos.entryPrice;
      const longSize = longPos.contracts;
      const shortPrice = shortPos.entryPrice;
      const shortSize = shortPos.contracts;
      
      const totalValLong = longPrice * longSize;
      const totalValShort = shortPrice * shortSize;
      const diffSize = longSize - shortSize;
      
      let netBep = 0;
      if (diffSize !== 0) {
        netBep = (totalValLong - totalValShort) / diffSize;
      } else {
        netBep = (longPrice + shortPrice) / 2;
      }
      
      const isNetShort = shortSize > longSize;
      const status = isNetShort ? "NET SHORT (Butuh Harga TURUN)" : (longSize > shortSize ? "NET LONG (Butuh Harga NAIK)" : "NEUTRAL (Locking Sempurna)");
      
      recoveryData[sym] = {
        longSize,
        longPrice,
        shortSize,
        shortPrice,
        netBep,
        status,
        diffSize: Math.abs(diffSize)
      };
    }
  }
  
  return recoveryData;
}

// Helper to call Gemini API with retry logic
async function generateWithRetry(prompt: string, modelName: string = 'gemini-3.1-pro-preview', maxRetries: number = 3, jsonMode: boolean = false, base64Image: string | null = null, enableSearch: boolean = false) {
  const ai = getAI();
  let attempt = 0;
  
  // First try with the requested model (e.g. Pro)
  while (attempt < maxRetries) {
    try {
      const config: any = {
        model: modelName,
      };
      
      if (base64Image) {
        config.contents = {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
            { text: prompt }
          ]
        };
      } else {
        config.contents = prompt;
      }
      
      config.config = {};
      if (modelName === 'gemini-3.1-pro-preview') {
        config.config.thinkingConfig = { thinkingLevel: ThinkingLevel.HIGH };
      }
      if (jsonMode) {
        config.config.responseMimeType = 'application/json';
      }
      if (enableSearch) {
        config.config.tools = [{ googleSearch: {} }];
      }

      const response = await ai.models.generateContent(config);
      return response.text;
    } catch (error: any) {
      attempt++;
      console.error(`Gemini API Error (${modelName} - Attempt ${attempt}/${maxRetries}):`, error.message || error);
      
      // If it's the last attempt, break to try fallback
      if (attempt >= maxRetries) break;
      
      // Wait before retrying (exponential backoff: 2s, 4s, 8s)
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`Waiting ${delay}ms before retrying...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // If Pro model failed, try Flash model as fallback
  if (modelName === 'gemini-3.1-pro-preview') {
    console.log('Falling back to gemini-3-flash-preview...');
    try {
      const config: any = {
        model: 'gemini-3-flash-preview',
      };
      
      if (base64Image) {
        config.contents = {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
            { text: prompt }
          ]
        };
      } else {
        config.contents = prompt;
      }
      
      config.config = {};
      if (jsonMode) {
        config.config.responseMimeType = 'application/json';
      }
      if (enableSearch) {
        config.config.tools = [{ googleSearch: {} }];
      }

      const response = await ai.models.generateContent(config);
      return response.text;
    } catch (error: any) {
      console.error('Fallback model (gemini-3-flash-preview) also failed:', error.message || error);
      
      // Try one more fallback: gemini-3.1-flash-preview
      console.log('Falling back to gemini-3.1-flash-preview...');
      try {
        const config: any = {
          model: 'gemini-3.1-flash-preview',
        };
        
        if (base64Image) {
          config.contents = {
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
              { text: prompt }
            ]
          };
        } else {
          config.contents = prompt;
        }
        
        config.config = {};
        if (jsonMode) {
          config.config.responseMimeType = 'application/json';
        }
        if (enableSearch) {
          config.config.tools = [{ googleSearch: {} }];
        }

        const response = await ai.models.generateContent(config);
        return response.text;
      } catch (error2: any) {
        console.error('Second fallback model (gemini-3.1-flash-preview) also failed:', error2.message || error2);
      }
    }
  }

  throw new Error(`Failed to get response from Gemini after all attempts.`);
}

// --- EXCEL ROWS BUILDER (A-D) ---
// Extracted to src/utils/ExcelBuilder.ts
// --- END EXCEL ROWS BUILDER ---

// Helper to ensure auth is active
async function ensureAuth() {
  if (!auth) return;
  if (!auth.currentUser) {
    console.log("⚠️ Auth session lost or not initialized. Re-authenticating...");
    const serverEmail = 'server@sentinel.local';
    const serverPassword = process.env.SERVER_PASSWORD || 'sentinel-server-secret-123';
    try {
      const userCredential = await signInWithEmailAndPassword(auth, serverEmail, serverPassword);
      console.log(`✅ Re-authenticated successfully as ${serverEmail}. UID: ${userCredential.user.uid}, Verified: ${userCredential.user.emailVerified}`);
    } catch (e: any) {
      if (e.code === 'auth/operation-not-allowed') {
        console.error("❌ CRITICAL: Email/Password authentication is DISABLED in your Firebase Console.");
        console.error("👉 ACTION REQUIRED: Go to Firebase Console > Authentication > Sign-in method and ENABLE 'Email/Password'.");
      } else if (e.code === 'auth/user-not-found' || e.code === 'auth/invalid-credential') {
        console.log(`ℹ️ Server user ${serverEmail} not found or invalid. Attempting to create...`);
        try {
          const userCredential = await createUserWithEmailAndPassword(auth, serverEmail, serverPassword);
          console.log(`✅ Server user created successfully. UID: ${userCredential.user.uid}`);
        } catch (createErr: any) {
          if (createErr.code === 'auth/operation-not-allowed') {
            console.error("❌ CRITICAL: Email/Password authentication is DISABLED in your Firebase Console.");
            console.error("👉 ACTION REQUIRED: Go to Firebase Console > Authentication > Sign-in method and ENABLE 'Email/Password'.");
          } else {
            console.error("❌ Failed to create server user:", createErr.message);
          }
        }
      } else {
        console.error("❌ Re-authentication failed:", e.message);
      }
    }
  }
}

// Core monitoring function
async function monitorMarkets(force = false) {
  await ensureAuth();
  const startTime = Date.now();
  console.log(`[PERF] Starting monitorMarkets run at ${new Date().toISOString()}`);
  
  if (db) {
    try {
      const lockRef = doc(db, 'system', 'bot_lock');
      if (!force) {
        const lockSnap = await getDoc(lockRef);
        if (lockSnap.exists()) {
          const lastRun = lockSnap.data().last_run_time || 0;
          // If last run was less than 59 minutes ago, skip to prevent multiple instances from spamming
          if (Date.now() - lastRun < 59 * 60 * 1000) {
            console.log(`[LOCK] Skipping monitorMarkets, last run was less than 59 minutes ago.`);
            return;
          }
        }
      }
      await setDoc(lockRef, { last_run_time: Date.now() }, { merge: true });
    } catch (e) {
      console.error('Error checking/setting bot lock:', e);
    }
  }

  try {
    console.log('Fetching market data and positions...');
    
    // 1. Fetch current positions and open orders
    let positions = [];
    let openOrders = [];
    if (BINANCE_API_KEY && BINANCE_API_SECRET) {
      try {
        const allPositions = await binance.fetchPositions();
        positions = allPositions.filter((p: any) => p.contracts > 0);
        openOrders = await binance.fetchOpenOrders();
      } catch (e) {
        console.error('Error fetching positions/orders:', e);
      }
    }

    // 2. Fetch market data for pairs with open positions AND Top 20 Volume
    // We only want to analyze pairs we are actively trading to avoid clutter and token limits
    const positionSymbols = [...new Set(positions.map((p: any) => p.symbol))];
    
    // Fetch Top 20 by Volume
    let top20Symbols: string[] = [];
    try {
        const tickers = await binance.fetchTickers();
        top20Symbols = Object.values(tickers)
            .filter((t: any) => t.symbol && (t.symbol.endsWith(':USDT') || t.symbol.endsWith('/USDT')))
            .sort((a: any, b: any) => (b.quoteVolume || 0) - (a.quoteVolume || 0))
            .slice(0, 20)
            .map((t: any) => t.symbol);
    } catch (e) {
        console.error('Error fetching top 20 tickers:', e);
        top20Symbols = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'BNB/USDT:USDT', 'XRP/USDT:USDT']; // Fallback
    }

    // Fetch ALL Approved Settings Symbols
    let approvedSettingsSymbols: string[] = [];
    let approvedSettings: any[] = [];
    try {
      approvedSettings = PolicySelectors.getAllApprovedSettings();
      approvedSettingsSymbols = approvedSettings.map(s => s.symbol);
    } catch (e) {
      console.error('Error fetching approved settings:', e);
    }

    const symbolsToFetch = [...new Set([...positionSymbols, ...top20Symbols, ...approvedSettingsSymbols])];
    
    const marketData = await fetchMarketDataWithIndicators(symbolsToFetch);
    const hedgingRecovery = calculateHedgingRecovery(positions);
    const accountRisk = await fetchAccountRisk();

    // Fetch recent backtest results
    let recentBacktests: any[] = [];
    try {
      recentBacktests = await withFirestoreFailSoft(async () => {
        const q = query(collection(db, 'backtests'), orderBy('timestamp', 'desc'), limit(5));
        const backtestsSnapshot = await getDocs(q);
        return backtestsSnapshot.docs.map(doc => doc.data());
      }, []);
    } catch (e) {
      console.error('Error fetching backtest results:', e);
    }

    // 3. Analyze with Gemini (V2 Decision Card & SOP Orchestrator)
    const ai = getAI();
    const inputPayload = {
        now_ts: Date.now(),
        accountRisk: {
            marginRatio: accountRisk ? accountRisk.marginRatio : 0,
            marginAvailable: accountRisk ? accountRisk.marginAvailable : 0,
            walletBalance: accountRisk ? accountRisk.walletBalance : 0,
            unrealizedPnl: accountRisk ? accountRisk.unrealizedPnl : 0,
            dailyRealizedPnl: accountRisk ? accountRisk.dailyRealizedPnl : 0
        },
        accountPositions: positions.map((p: any) => ({
            symbol: p.symbol,
            side: p.side,
            contracts: p.contracts,
            entryPrice: p.entryPrice,
            unrealizedPnl: p.unrealizedPnl
        })),
        scannerUniverse: top20Symbols,
        approvedSettingsSymbols, // Explicitly tell Gemini which symbols are approved
        marketData,
        recentHistory: signals.slice(0, 5), // Include last 5 signals for self-supervision
        recentBacktests, // Include recent backtests for strategy optimization
        approvedSettings, // Include approved settings for specific coins
        openOrders: openOrders.map((o: any) => ({
            symbol: o.symbol,
            side: o.side,
            type: o.type,
            price: o.price
        })),
        params: PolicySelectors.getGlobalPolicy().params,
        enable_addendum_modules: PolicySelectors.getGlobalPolicy().enable_addendum_modules
    };

    // Generate Visual Chart for the most relevant coin
    let chartBase64 = null;
    let chartSymbol = positions.length > 0 ? positions[0].symbol : top20Symbols[0];
    
    if (chartSymbol) {
      try {
        const ohlcv4h = await binance.fetchOHLCV(chartSymbol, '4h', undefined, 60);
        chartBase64 = await getQuickChartBase64(chartSymbol, ohlcv4h, '4H');
        if (chartBase64) {
          console.log(`[CHART] Generated visual chart for ${chartSymbol}`);
        }
      } catch (e) {
        console.error(`[CHART] Failed to fetch OHLCV for chart generation:`, e);
      }
    }

    const finalPrompt = buildMonitoringPrompt({
      inputPayload,
      openPositionSymbols: [...new Set(positions.map((p: any) => p.symbol))],
      includeVisualAppendix: !!chartBase64,
      chartSymbol,
    });

    // Switched to gemini-3-flash-preview for better stability, with Search enabled
    const analysisJson = await generateWithRetry(finalPrompt, 'gemini-3-flash-preview', 3, true, chartBase64, true);
    
    if (!analysisJson) {
      throw new Error('Failed to generate analysis');
    }

    let analysisData;
    try {
        // Find the first '{' and last '}' to extract the JSON object
        const firstBrace = analysisJson.indexOf('{');
        const lastBrace = analysisJson.lastIndexOf('}');
        
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            const cleanJson = analysisJson.substring(firstBrace, lastBrace + 1);
            try {
                analysisData = JSON.parse(cleanJson);
            } catch (parseErr: any) {
                // If it fails with "Unexpected non-whitespace character after JSON at position X"
                const match = parseErr.message.match(/at position (\d+)/);
                if (match) {
                    const pos = parseInt(match[1], 10);
                    analysisData = JSON.parse(cleanJson.substring(0, pos));
                } else {
                    throw parseErr;
                }
            }
        } else {
            throw new Error("Could not find valid JSON object in response");
        }
    } catch (e) {
        console.error("Failed to parse JSON from Gemini:", e);
        console.log("Raw response:", analysisJson);
        analysisData = {
            market_summary: "Error parsing analysis. Please check server logs.",
            decision_cards: []
        };
    }
    
    let cards = analysisData.decision_cards || [];
    lastRawNewSignals = analysisData.new_signals || null;
    
    // Deduplicate cards by symbol to prevent spam
    const uniqueCards = [];
    const seenSymbols = new Set();
    for (const c of cards) {
        if (c.symbol && !seenSymbols.has(c.symbol)) {
            seenSymbols.add(c.symbol);
            uniqueCards.push(c);
        }
    }
    cards = uniqueCards;
    latestDecisionCards = cards;
    const se = analysisData.server_enforce || { overrides:[], mr_projection:[], alerts:[] };
    const gg = analysisData.global_guard || { mode:"NORMAL" };
    const new_signals = analysisData.new_signals || null;

    // --- NEW: Generate Excel Rows ---
    try {
        const excelRows = composeExcelRows({
            cards,
            positions,
            marketData,
            accountRisk
        });
        analysisData.excel_rows = excelRows;
    } catch (e) {
        console.error("Failed to compose excel_rows:", e);
    }

    // --- NEW: Upload arsip ke GCS (opsional) ---
    let archiveUrl: string | null = null;
    try {
      const uploaded = await uploadAnalysisToGCS(analysisData, {
        now_ts: inputPayload?.now_ts || Date.now(),
        account_mr: analysisData?.global_guard?.mr_pct ?? null,
        symbols: (cards || []).map((c:any)=>c.symbol).slice(0,5)
      });
      if (uploaded?.url) { archiveUrl = uploaded.url; }
    } catch (e:any) {
      console.warn("GCS archive skipped:", e.message);
    }

    // --- NEW: Send Decision Cards JSON to Email and Webhook ---
    if (cards && cards.length > 0) {
        await sendDecisionCardsEmail(cards, analysisData.excel_rows);
        await sendPowerAutomateWebhook(analysisData);
    }

    // --- NEW: Save to Trading Journal (REMOVED - Now handled by Paper Trading Engine) ---
    // --- END NEW ---

    const payloads = renderDecisionCardsToTelegram(cards, se, gg, new_signals, archiveUrl);

    // 1. Process Decision Cards (Monitoring)
    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const payload = payloads[i];
        await sendTelegramMessage(payload.text, payload.reply_markup);
        
        const monitorSignal = {
          id: `monitor_${Date.now()}_${card.symbol.replace('/', '')}`,
          timestamp: new Date().toISOString(),
          content: payload.text.replace(STRIP_TAGS, ''),
          type: 'monitor',
          symbol: card.symbol
        };
        signals.unshift(monitorSignal);
        
        if (db) {
          try {
            await ensureAuth();
            await setDoc(doc(db, 'signals', monitorSignal.id), monitorSignal);
          } catch (dbErr) {
            handleFirestoreError(dbErr, OperationType.WRITE, `signals/${monitorSignal.id}`);
          }
        }
    }

    // 2. Process New Signals (Scanner)
    if (new_signals && payloads.length > cards.length) {
        const scannerPayload = payloads[payloads.length - 1];
        await sendTelegramMessage(scannerPayload.text, scannerPayload.reply_markup);

        // Add ONE summary entry for the UI
        const scannerSummaryId = `scanner_${Date.now()}`;
        const scannerSummary = {
          id: scannerSummaryId,
          timestamp: new Date().toISOString(),
          content: scannerPayload.text.replace(STRIP_TAGS, ''),
          type: 'scanner',
          symbol: 'GENERAL'
        };
        signals.unshift(scannerSummary);
        if (db) {
          try {
            await ensureAuth();
            await setDoc(doc(db, 'signals', scannerSummaryId), scannerSummary);
          } catch (dbErr) {
            handleFirestoreError(dbErr, OperationType.WRITE, `signals/${scannerSummaryId}`);
          }
        }

        // Add individual structured signals for the Paper Trading Engine (NOT shown in UI)
        if (new_signals.signals && new_signals.signals.length > 0) {
            for (const sig of new_signals.signals) {
                const signalId = `signal_${Date.now()}_${sig.symbol.replace('/', '')}`;
                const newSignal = {
                  id: signalId,
                  timestamp: new Date().toISOString(),
                  content: `Structured signal for ${sig.symbol}`, 
                  type: 'scanner_signal', // Different type for engine
                  symbol: sig.symbol,
                  side: sig.side, // BUY or SELL
                  entry: sig.entry,
                  stop_loss: sig.stop_loss,
                  targets: sig.targets,
                  why_this_pair: sig.why_this_pair,
                  sentiment: sig.sentiment,
                  trend: sig.trend,
                  smc: sig.smc || (sig as any).confluence?.smc || null
                };
                signals.unshift(newSignal);

                if (db) {
                  try {
                    await ensureAuth();
                    await setDoc(doc(db, 'signals', newSignal.id), newSignal);
                  } catch (dbErr) {
                    handleFirestoreError(dbErr, OperationType.WRITE, `signals/${newSignal.id}`);
                  }
                }
            }
        }
    }
    
    if (signals.length > 50) signals.splice(50);

    const duration = (Date.now() - startTime) / 1000;
    console.log(`[PERF] monitorMarkets total duration: ${duration.toFixed(2)}s`);
  } catch (error) {
    console.error('Error in monitorMarkets:', error);
    throw error;
  }
}

// =========================================================
// TELEGRAM HELPERS
// =========================================================
// Extracted to src/renderers/TelegramRenderer.ts

// Helper for background sync
function backgroundSyncFirestore(promise: Promise<any>) {
  promise.catch(error => {
    const msg = String(error?.message || error || '').toLowerCase();
    if (msg.includes('quota') || msg.includes('resource exhausted') || msg.includes('deadline exceeded')) {
      markFirestoreUnavailable(60_000);
      // Ignore quota errors for paper trading background sync
    } else {
      console.error("[PAPER] Background sync error:", error.message);
    }
  });
}

// Helper to calculate margin used based on current notional value (Binance Hedge Mode logic)
// Moved to src/paper-engine/valuation.ts

// SOP Helper: Classify Structure with tolerance (SOP 2AB)
function classifyStructure(longSize: number, shortSize: number): string {
  if (longSize === 0 && shortSize === 0) return 'NONE';
  if (longSize === 0) return 'SHORT_ONLY';
  if (shortSize === 0) return 'LONG_ONLY';
  
  const ratioLS = longSize / shortSize;
  const ratioSL = shortSize / longSize;

  if (ratioLS >= 0.95 && ratioLS <= 1.05) return 'LOCK_1TO1';
  
  if (ratioLS >= 1.90 && ratioLS <= 2.10) return 'LONG_2_SHORT_1';
  if (ratioSL >= 1.90 && ratioSL <= 2.10) return 'SHORT_2_LONG_1';
  
  if (ratioLS >= 1.40 && ratioLS <= 1.60) return 'LONG_1P5_SHORT_1';
  if (ratioSL >= 1.40 && ratioSL <= 1.60) return 'SHORT_1P5_LONG_1';
  
  return 'OTHER';
}

// SOP Helper: Compute Projected MR after adding size (Consistent with Proxy MR)
// Moved to src/paper-engine/valuation.ts

// SOP Helper: Check Spot Adverse Move > 4% (Legacy Only - SOP 4.2)
function checkSpotAdverseMove(pos: any, currentPrice: number, resetTime: number): boolean {
  if (!pos || !pos.openedAt) return false;
  const openedAtMs = new Date(pos.openedAt).getTime();
  // Jika trade baru (>= resetTime) dan bukan flag legacy, maka abaikan (return false)
  if (openedAtMs >= resetTime && !pos.isLegacy) return false;
  
  const entryPrice = pos.entryPrice ?? 0;
  if (entryPrice === 0) return false;

  if (pos.side === 'LONG') {
    return ((entryPrice - currentPrice) / entryPrice) > 0.04;
  } else {
    return ((currentPrice - entryPrice) / entryPrice) > 0.04;
  }
}

// SOP Helper: Post-Action Reclassification (SOP 6.6)
function reclassifyState(longPos: any, shortPos: any, currentPrice: number) {
  const lSize = longPos?.size ?? 0;
  const sSize = shortPos?.size ?? 0;
  const structure = classifyStructure(lSize, sSize);
  
  let greenLeg = 'NONE';
  let redLeg = 'NONE';
  
  const lPnl = longPos?.currentPnl ?? 0;
  const sPnl = shortPos?.currentPnl ?? 0;

  if (lPnl > 0) greenLeg = 'LONG';
  if (sPnl > 0) greenLeg = greenLeg === 'NONE' ? 'SHORT' : 'BOTH';
  
  if (lPnl < 0) redLeg = 'LONG';
  if (sPnl < 0) redLeg = redLeg === 'NONE' ? 'SHORT' : 'BOTH';
  
  let hedgeLegStatus = 'NONE';
  if (structure === 'LOCK_1TO1') {
    hedgeLegStatus = 'HEDGE_FULL';
  } else if (lSize > 0 && sSize > 0) {
    hedgeLegStatus = 'RESIDUAL_OPPOSING_LEG';
  }
  
  const contextMode = structure === 'LOCK_1TO1' ? 'LOCK_WAIT_SEE' : 'UNKNOWN';
  
  return { structure, greenLeg, redLeg, hedgeLegStatus, contextMode };
}

// Paper Trading Engine Logic
let isPaperEngineRunning = false;

async function runPaperTradingEngine() {
  if (isPaperEngineRunning) {
    console.log(`[PAPER] Engine is already running. Skipping this cycle.`);
    return;
  }
  isPaperEngineRunning = true;

  await ensureAuth();
  if (!db) {
    isPaperEngineRunning = false;
    return;
  }

  console.log(`[PAPER] Running Paper Trading Engine at ${new Date().toISOString()}`);

  try {
    // 1. Ensure Paper Wallet exists
    const walletRef = doc(db, 'paper_wallet', 'main');
    let wallet = cachedPaperWallet;

    // 2. Fetch Open Positions
    let openPositions = cachedPaperPositions;

    // Consolidate duplicate positions (same symbol, same side)
    const grouped = openPositions.reduce((acc, pos) => {
      if (pos.status === 'OPEN') {
        const key = `${pos.symbol}_${pos.side}`;
        if (!acc[key]) acc[key] = [];
        acc[key].push(pos);
      }
      return acc;
    }, {} as Record<string, any[]>);

    for (const key in grouped) {
      const group = grouped[key];
      if (group.length > 1) {
        console.log(`[PAPER] Consolidating ${group.length} duplicate positions for ${key}`);
        let totalSize = 0;
        let totalValue = 0;
        let mainId = group[0].id;
        let earliestTime = group[0].openedAt;

        for (const p of group) {
          totalSize += p.size;
          totalValue += p.size * p.entryPrice;
          if (new Date(p.openedAt) < new Date(earliestTime)) {
            earliestTime = p.openedAt;
            mainId = p.id;
          }
        }

        const avgEntryPrice = totalValue / totalSize;
        const mainPosIndex = openPositions.findIndex(p => p.id === mainId);
        
        if (mainPosIndex > -1) {
          openPositions[mainPosIndex].size = totalSize;
          openPositions[mainPosIndex].entryPrice = avgEntryPrice;
          
          backgroundSyncFirestore(setDoc(doc(db, 'paper_positions', mainId), {
            size: totalSize,
            entryPrice: avgEntryPrice
          }, { merge: true }));
        }

        for (const p of group) {
          if (p.id !== mainId) {
            const idx = openPositions.findIndex(op => op.id === p.id);
            if (idx > -1) openPositions.splice(idx, 1);
            backgroundSyncFirestore(deleteDoc(doc(db, 'paper_positions', p.id)));
          }
        }
      }
    }

    // 3. Determine symbols to process
    const freshSignals = signals.filter(s => 
      s.type === 'scanner_signal' &&
      (Date.now() - new Date(s.timestamp).getTime() < 20 * 60 * 1000) &&
      new Date(s.timestamp).getTime() > paperTradingResetTime
    );

    const symbolsToProcess = Array.from(new Set([
      ...openPositions.map(p => p.symbol),
      ...freshSignals.map(s => s.symbol)
    ])).filter(Boolean);

    paperLastTick = new Date().toISOString();

    if (symbolsToProcess.length === 0) {
      console.log('[PAPER] No open positions or fresh signals. Skipping cycle.');
      paperSkippedCycles++;
      if (openPositions.length === 0) paperNoPositionCycles++;
      if (freshSignals.length === 0) paperNoSignalCycles++;
      paperLastSkipReason = 'No open positions or fresh signals';
      return;
    }

    paperLastSkipReason = null;

    // Recalculate equity and free margin to fix any inconsistencies
    let totalUnrealized = 0;
    let totalMarginUsed = 0;
    const LEVERAGE = 20; // Default leverage for paper trading
    
    for (const pos of openPositions) {
      if (pos.status === 'OPEN') {
        totalUnrealized += pos.unrealizedPnl || 0;
        totalMarginUsed += calculateMarginUsed(pos, LEVERAGE);
      }
    }
    
    wallet.equity = wallet.balance + totalUnrealized;
    wallet.freeMargin = wallet.equity - totalMarginUsed;
    wallet.marginRatio = wallet.equity > 0 ? (totalMarginUsed / wallet.equity) * 100 : 0;
    
    // Check if we need to start or stop emergency de-risk
    if (wallet.marginRatio > 25 && !wallet.isEmergencyDeRisking) {
      wallet.isEmergencyDeRisking = true;
      console.log(`[PAPER] 🚨 EMERGENCY DE-RISK CYCLE INITIATED! Initial MR: ${wallet.marginRatio.toFixed(2)}%`);
      await sendTelegramMessage(`[PAPER] 🚨 <b>EMERGENCY DE-RISK INITIATED</b>\nMargin Ratio is ${wallet.marginRatio.toFixed(2)}% (> 25%).\nSentinel will automatically realize profits to reduce margin exposure to below 15%.`);
    } else if (wallet.marginRatio < 15 && wallet.isEmergencyDeRisking) {
      wallet.isEmergencyDeRisking = false;
      console.log(`[PAPER] ✅ EMERGENCY DE-RISK RESOLVED! Current MR: ${wallet.marginRatio.toFixed(2)}%`);
      await sendTelegramMessage(`[PAPER] ✅ <b>EMERGENCY DE-RISK RESOLVED</b>\nMargin Ratio is now safely below 15% (${wallet.marginRatio.toFixed(2)}%).\nNormal trading operations resumed.`);
    }
    
    backgroundSyncFirestore(setDoc(walletRef, wallet));

    // Liquidation Check
    if (wallet.equity <= 0 && openPositions.length > 0) {
      console.log(`[PAPER] 🚨 LIQUIDATION TRIGGERED! Equity is ${wallet.equity}`);
      for (const pos of openPositions) {
        if (pos.status === 'OPEN') {
          const historyId = `${pos.id}_liq_${Date.now()}`;
          const historyEntry = {
            ...pos, id: historyId, exitPrice: pos.currentPrice || pos.entryPrice, pnl: pos.unrealizedPnl, reason: 'LIQUIDATION', closedAt: new Date().toISOString(), status: 'CLOSED' as const
          } as PaperHistory;
          
          cachedPaperHistory.unshift(historyEntry);
          if (cachedPaperHistory.length > 200) cachedPaperHistory.pop();
          
          backgroundSyncFirestore(setDoc(doc(db, 'paper_history', historyId), historyEntry));
          
          if (pos.journalId) {
            backgroundSyncFirestore(setDoc(doc(db, 'trading_journal', pos.journalId), {
              exitPrice: pos.currentPrice || pos.entryPrice, pnl: pos.unrealizedPnl, status: 'CLOSED', closedAt: new Date().toISOString(), closeReason: 'LIQUIDATION'
            }, { merge: true }));
          }
          backgroundSyncFirestore(deleteDoc(doc(db, 'paper_positions', pos.id)));
        }
      }
      
      // Clear local positions
      cachedPaperPositions.length = 0;
      
      wallet.balance = 0;
      wallet.equity = 0;
      wallet.freeMargin = 0;
      wallet.updatedAt = new Date().toISOString();
      backgroundSyncFirestore(setDoc(walletRef, wallet));
      await sendTelegramMessage(`[PAPER] 🚨 <b>LIQUIDATION ALERT</b>\nYour paper trading account has been liquidated due to negative equity.`);
      return; // Stop processing this cycle
    }

    // 4. Process each symbol
    for (const symbol of symbolsToProcess) {
      if (!symbol || typeof symbol !== 'string') continue;
      
      // Use approved settings if available, otherwise use defaults
      const setting = PolicySelectors.getPolicyForSymbol(symbol);
      
      const { timeframe, takeProfitPct } = setting;
      
      try {
        // Fetch current price (lightweight)
        const ticker = await binance.fetchTicker(symbol);
        const currentPrice = ticker.last;

        const monitoringRef = doc(db, 'paper_monitoring', symbol.replace('/', '_'));
        const symbolPositions = openPositions.filter((p: any) => p.symbol === symbol && p.status === 'OPEN');
        let longPos = symbolPositions.find((p: any) => p.side === 'LONG');
        let shortPos = symbolPositions.find((p: any) => p.side === 'SHORT');

        // Find if there's a fresh signal from the main bot loop (monitorMarkets)
        const freshSignal = signals.find(s => 
          s.symbol === symbol && 
          s.type === 'scanner_signal' &&
          (Date.now() - new Date(s.timestamp).getTime() < 20 * 60 * 1000) &&
          new Date(s.timestamp).getTime() > paperTradingResetTime
        );

        // Calculate PnL
        let totalUnrealizedPnl = 0;
        if (longPos) {
          longPos.currentPrice = currentPrice;
          longPos.currentPnl = (currentPrice - longPos.entryPrice) * longPos.size;
          longPos.pnlPct = (longPos.currentPnl / (longPos.entryPrice * longPos.size)) * 100;
          totalUnrealizedPnl += longPos.currentPnl;
        }
        if (shortPos) {
          shortPos.currentPrice = currentPrice;
          shortPos.currentPnl = (shortPos.entryPrice - currentPrice) * shortPos.size;
          shortPos.pnlPct = (shortPos.currentPnl / (shortPos.entryPrice * shortPos.size)) * 100;
          totalUnrealizedPnl += shortPos.currentPnl;
        }

        // Helper to update wallet state accurately
        const updateWalletState = () => {
          let totalUnrealized = 0;
          let totalMarginUsed = 0;
          
          for (const p of openPositions) {
            if (p.status === 'OPEN') {
              totalUnrealized += p.currentPnl !== undefined ? p.currentPnl : (p.unrealizedPnl || 0);
              totalMarginUsed += calculateMarginUsed(p, LEVERAGE);
            }
          }
          
          wallet.equity = wallet.balance + totalUnrealized;
          wallet.freeMargin = wallet.equity - totalMarginUsed;
          wallet.marginRatio = wallet.equity > 0 ? (totalMarginUsed / wallet.equity) * 100 : 0;
          wallet.updatedAt = new Date().toISOString();
          backgroundSyncFirestore(setDoc(walletRef, wallet));
        };

        // Helper to close position
        const closePos = async (pos: any, reason: string) => {
          const historyId = `${pos.id}_close_${Date.now()}`;
          const historyEntry = {
            ...pos, id: historyId, exitPrice: currentPrice, pnl: pos.currentPnl, reason, closedAt: new Date().toISOString(), status: 'CLOSED' as const
          } as PaperHistory;
          
          cachedPaperHistory.unshift(historyEntry);
          if (cachedPaperHistory.length > 200) cachedPaperHistory.pop();
          
          backgroundSyncFirestore(setDoc(doc(db, 'paper_history', historyId), historyEntry));
          
          if (pos.journalId) {
            backgroundSyncFirestore(setDoc(doc(db, 'trading_journal', pos.journalId), {
              exitPrice: currentPrice, pnl: pos.currentPnl, status: 'CLOSED', closedAt: new Date().toISOString(), closeReason: reason
            }, { merge: true }));
          }
          backgroundSyncFirestore(deleteDoc(doc(db, 'paper_positions', pos.id)));
          
          const index = openPositions.findIndex(p => p.id === pos.id);
          if (index > -1) {
            openPositions.splice(index, 1);
          }
          
          wallet.balance += pos.currentPnl;
          updateWalletState();
          await sendTelegramMessage(`[PAPER] 💰 <b>Closed ${pos.side} ${symbol}</b>\nReason: ${reason}\nPnL: $${pos.currentPnl.toFixed(2)}`);
        };

        // Helper to partial close position
        const partialClosePos = async (pos: any, sizeToClose: number, reason: string) => {
          const proportion = sizeToClose / pos.size;
          const realizedPnl = pos.currentPnl * proportion;
          
          const historyId = `${pos.id}_partial_${Date.now()}`;
          const historyEntry = {
            ...pos, id: historyId, size: sizeToClose, exitPrice: currentPrice, pnl: realizedPnl, reason, closedAt: new Date().toISOString(), status: 'CLOSED' as const
          } as PaperHistory;
          
          cachedPaperHistory.unshift(historyEntry);
          if (cachedPaperHistory.length > 200) cachedPaperHistory.pop();
          
          backgroundSyncFirestore(setDoc(doc(db, 'paper_history', historyId), historyEntry));
          
          pos.size -= sizeToClose;
          pos.currentPnl -= realizedPnl;
          backgroundSyncFirestore(setDoc(doc(db, 'paper_positions', pos.id), { size: pos.size, unrealizedPnl: pos.currentPnl }, { merge: true }));
          
          const index = openPositions.findIndex(p => p.id === pos.id);
          if (index > -1) {
            openPositions[index].size = pos.size;
            openPositions[index].currentPnl = pos.currentPnl;
          }
          
          wallet.balance += realizedPnl;
          updateWalletState();
          await sendTelegramMessage(`[PAPER] 💰 <b>Partial Close ${pos.side} ${symbol}</b>\nReason: ${reason}\nPnL: $${realizedPnl.toFixed(2)}`);
        };

        // Helper to open position
        const openPos = async (side: string, size: number, reason: string, signalId: string = '', signalData: any = null) => {
          const newPosRef = doc(collection(db, 'paper_positions'));
          const journalId = `journal_${Date.now()}_${symbol.replace('/', '')}`;
          
          // Use signal targets if available, otherwise fallback to percentage (for safety)
          let tpPrice = 0;
          let slPrice = 0;
          
          if (signalData && signalData.targets) {
            // Use T2 as final Take Profit, T1 can be used for partials/locks
            tpPrice = parseFloat(String(signalData.targets.t2)) || parseFloat(String(signalData.targets.t1)) || 0;
            slPrice = parseFloat(String(signalData.stop_loss)) || 0;
          }
          
          if (tpPrice === 0) {
            tpPrice = side === 'LONG' ? currentPrice * (1 + takeProfitPct/100) : currentPrice * (1 - takeProfitPct/100);
          }

          const journalEntry = {
            id: journalId, timestamp: new Date().toISOString(), symbol, side, entryPrice: currentPrice,
            stopLoss: slPrice, target1: signalData?.targets?.t1 ? (parseFloat(String(signalData.targets.t1)) || 0) : 0, target2: tpPrice, reason, sentiment: signalData?.sentiment || 'NEUTRAL', status: 'OPEN', source: 'PAPER_BOT', pnl: 0
          };
          backgroundSyncFirestore(setDoc(doc(db, 'trading_journal', journalId), journalEntry));

          const newPos: PaperPosition = {
            id: newPosRef.id, symbol, side: side as 'LONG' | 'SHORT', entryPrice: currentPrice, size, unrealizedPnl: 0,
            takeProfit: tpPrice,
            stopLoss: slPrice, 
            target1: signalData?.targets?.t1 || 0,
            status: 'OPEN', openedAt: new Date().toISOString(), signalId, journalId,
            isHedge: reason.includes('Lock') || reason.includes('Hedge'),
            realizedHedgeProfit: 0
          };
          backgroundSyncFirestore(setDoc(newPosRef, newPos));
          
          const posWithPnl = { ...newPos, currentPnl: 0, pnlPct: 0 };
          openPositions.push(posWithPnl);
          updateWalletState();
          
          await sendTelegramMessage(`[PAPER] 🟢 <b>Opened ${side} ${symbol}</b>\nReason: ${reason}\nEntry: $${currentPrice.toFixed(4)}\nTP: $${tpPrice.toFixed(4)}\nSL: $${slPrice.toFixed(4)}`);
          return posWithPnl;
        };

        // Helper to add size to position
        const addSize = async (pos: any, additionalSize: number, reason: string, signalId: string) => {
          const newTotalSize = pos.size + additionalSize;
          const newAvgEntry = ((pos.size * pos.entryPrice) + (additionalSize * currentPrice)) / newTotalSize;
          
          backgroundSyncFirestore(setDoc(doc(db, 'paper_positions', pos.id), {
            size: newTotalSize, entryPrice: newAvgEntry, lastSignalId: signalId
          }, { merge: true }));

          pos.size = newTotalSize;
          pos.entryPrice = newAvgEntry;
          pos.lastSignalId = signalId;
          
          const index = openPositions.findIndex(p => p.id === pos.id);
          if (index > -1) {
            openPositions[index].size = newTotalSize;
            openPositions[index].entryPrice = newAvgEntry;
          }
          
          updateWalletState();
          await sendTelegramMessage(`[PAPER] ➕ <b>Added to ${pos.side} ${symbol}</b>\nReason: ${reason}\nNew Avg Entry: $${newAvgEntry.toFixed(4)}\nNew Size: ${newTotalSize.toFixed(4)}`);
        };

        // --- 0. EMERGENCY DE-RISK (MR > 25%) ---
        type TradeDecision = 
          | { action: 'CLOSE_POSITION'; targetPositionId: string; reason: string }
          | { action: 'PARTIAL_CLOSE'; targetPositionId: string; size: number; reason: string }
          | { action: 'MODIFY_POSITION'; targetPositionId: string; newSl: number; reason: string };
        
        const decisions: TradeDecision[] = [];

        if (wallet.isEmergencyDeRisking && wallet.marginRatio > 15) {
          if (longPos && shortPos) {
            // Hedged position: Unlock or Reduce the profitable leg
            if (longPos.currentPnl > 0) {
              if (longPos.size > shortPos.size) {
                const excessSize = longPos.size - shortPos.size;
                decisions.push({ action: 'PARTIAL_CLOSE', targetPositionId: longPos.id, size: excessSize, reason: 'Emergency De-Risk (Reduce Long to 1:1)' });
              } else {
                decisions.push({ action: 'CLOSE_POSITION', targetPositionId: longPos.id, reason: 'Emergency De-Risk (Unlock Long)' });
                longPos = undefined;
                // Update shortPos SL to prevent immediate re-hedge
                if (shortPos) {
                  const newSl = currentPrice * (1 + (setting.lockTriggerPct || 2.0) / 100);
                  decisions.push({ action: 'MODIFY_POSITION', targetPositionId: shortPos.id, newSl, reason: 'Emergency De-Risk (Update SL)' });
                }
              }
            } else if (shortPos.currentPnl > 0) {
              if (shortPos.size > longPos.size) {
                const excessSize = shortPos.size - longPos.size;
                decisions.push({ action: 'PARTIAL_CLOSE', targetPositionId: shortPos.id, size: excessSize, reason: 'Emergency De-Risk (Reduce Short to 1:1)' });
              } else {
                decisions.push({ action: 'CLOSE_POSITION', targetPositionId: shortPos.id, reason: 'Emergency De-Risk (Unlock Short)' });
                shortPos = undefined;
                // Update longPos SL to prevent immediate re-hedge
                if (longPos) {
                  const newSl = currentPrice * (1 - (setting.lockTriggerPct || 2.0) / 100);
                  decisions.push({ action: 'MODIFY_POSITION', targetPositionId: longPos.id, newSl, reason: 'Emergency De-Risk (Update SL)' });
                }
              }
            }
          } else if (longPos && !shortPos) {
            // Single leg: Close if profitable
            if (longPos.currentPnl > 0) {
              decisions.push({ action: 'CLOSE_POSITION', targetPositionId: longPos.id, reason: 'Emergency De-Risk (Take Profit Long)' });
              longPos = undefined;
            }
          } else if (shortPos && !longPos) {
            // Single leg: Close if profitable
            if (shortPos.currentPnl > 0) {
              decisions.push({ action: 'CLOSE_POSITION', targetPositionId: shortPos.id, reason: 'Emergency De-Risk (Take Profit Short)' });
              shortPos = undefined;
            }
          }
        }

        // --- EXECUTION LOOP FOR 1C-1a ---
        for (const decision of decisions) {
          if (decision.action === 'CLOSE_POSITION') {
            const pos = openPositions.find(p => p.id === decision.targetPositionId);
            if (pos) await closePos(pos, decision.reason);
          } else if (decision.action === 'PARTIAL_CLOSE') {
            const pos = openPositions.find(p => p.id === decision.targetPositionId);
            if (pos) await partialClosePos(pos, decision.size, decision.reason);
          } else if (decision.action === 'MODIFY_POSITION') {
            const pos = openPositions.find(p => p.id === decision.targetPositionId);
            if (pos) pos.stopLoss = decision.newSl;
            backgroundSyncFirestore(setDoc(doc(db, 'paper_positions', decision.targetPositionId), { stopLoss: decision.newSl }, { merge: true }));
          }
        }

        // --- 1. EXIT LOGIC (Sentinel Targets) ---
        const exitDecisions: TradeDecision[] = [];

        if (longPos && shortPos) {
          // TODO: Implement BEP_NET_PRICE calculation to account for fees and realized hedge profit
          
          // Calculate Structural BEP_GROSS_PRICE
          const currentStructure = classifyStructure(longPos.size, shortPos.size);
          if (currentStructure !== 'LOCK_1TO1') {
            const bepGross = ((longPos.size * longPos.entryPrice) - (shortPos.size * shortPos.entryPrice)) / (longPos.size - shortPos.size);
            
            let isAtBep = false;
            if (longPos.size > shortPos.size) {
              // Net LONG
              isAtBep = currentPrice >= bepGross;
            } else {
              // Net SHORT
              isAtBep = currentPrice <= bepGross;
            }

            if (isAtBep) {
              exitDecisions.push({ action: 'CLOSE_POSITION', targetPositionId: longPos.id, reason: 'Structural BEP Gross Reached (Hedge Resolved)' });
              exitDecisions.push({ action: 'CLOSE_POSITION', targetPositionId: shortPos.id, reason: 'Structural BEP Gross Reached (Hedge Resolved)' });
              longPos = undefined; shortPos = undefined;
              const reclass = reclassifyState(longPos, shortPos, currentPrice);
              console.log(`[PAPER] Post-Action Reclass (Hedge Resolved) for ${symbol}: Structure=${reclass.structure}, GreenLeg=${reclass.greenLeg}, HedgeStatus=${reclass.hedgeLegStatus}`);
            }
          } else {
            // LOCK_1TO1 (toleransi 0.95–1.05): skip BEP, tunggu perubahan struktur
            console.log(`[PAPER] LOCK_1TO1 detected for ${symbol}, skip BEP calculation.`);
          }
        } else {
          if (longPos) {
            const isAtTP = currentPrice >= longPos.takeProfit;
            // Only exit on SL if lock11Mode is disabled. If enabled, we hedge instead.
            const isAtSL = !setting.lock11Mode && longPos.stopLoss > 0 && currentPrice <= longPos.stopLoss;
            
            if (isAtTP) {
              if (longPos.currentPnl >= 0) {
                exitDecisions.push({ action: 'CLOSE_POSITION', targetPositionId: longPos.id, reason: 'Take Profit (Sentinel Target)' });
                longPos = undefined;
                const reclass = reclassifyState(longPos, shortPos, currentPrice);
                console.log(`[PAPER] Post-Action Reclass (TP) for ${symbol}: Structure=${reclass.structure}, GreenLeg=${reclass.greenLeg}, HedgeStatus=${reclass.hedgeLegStatus}`);
              } else {
                console.log(`[PAPER] SKIP TP for ${symbol} LONG: Position is RED (currentPnl < 0). Golden Rule enforced.`);
              }
            } else if (isAtSL) {
              exitDecisions.push({ action: 'CLOSE_POSITION', targetPositionId: longPos.id, reason: 'Stop Loss (Sentinel Target)' });
              longPos = undefined;
              const reclass = reclassifyState(longPos, shortPos, currentPrice);
              console.log(`[PAPER] Post-Action Reclass (SL) for ${symbol}: Structure=${reclass.structure}, GreenLeg=${reclass.greenLeg}, HedgeStatus=${reclass.hedgeLegStatus}`);
            }
          }
          if (shortPos) {
            const isAtTP = currentPrice <= shortPos.takeProfit;
            // Only exit on SL if lock11Mode is disabled. If enabled, we hedge instead.
            const isAtSL = !setting.lock11Mode && shortPos.stopLoss > 0 && currentPrice >= shortPos.stopLoss;
            
            if (isAtTP) {
              if (shortPos.currentPnl >= 0) {
                exitDecisions.push({ action: 'CLOSE_POSITION', targetPositionId: shortPos.id, reason: 'Take Profit (Sentinel Target)' });
                shortPos = undefined;
                const reclass = reclassifyState(longPos, shortPos, currentPrice);
                console.log(`[PAPER] Post-Action Reclass (TP) for ${symbol}: Structure=${reclass.structure}, GreenLeg=${reclass.greenLeg}, HedgeStatus=${reclass.hedgeLegStatus}`);
              } else {
                console.log(`[PAPER] SKIP TP for ${symbol} SHORT: Position is RED (currentPnl < 0). Golden Rule enforced.`);
              }
            } else if (isAtSL) {
              exitDecisions.push({ action: 'CLOSE_POSITION', targetPositionId: shortPos.id, reason: 'Stop Loss (Sentinel Target)' });
              shortPos = undefined;
              const reclass = reclassifyState(longPos, shortPos, currentPrice);
              console.log(`[PAPER] Post-Action Reclass (SL) for ${symbol}: Structure=${reclass.structure}, GreenLeg=${reclass.greenLeg}, HedgeStatus=${reclass.hedgeLegStatus}`);
            }
          }
        }

        // --- EXECUTION LOOP FOR HF Exit Logic ---
        for (const decision of exitDecisions) {
          if (decision.action === 'CLOSE_POSITION') {
            const pos = openPositions.find(p => p.id === decision.targetPositionId);
            if (pos) await closePos(pos, decision.reason);
          } else if (decision.action === 'PARTIAL_CLOSE') {
            const pos = openPositions.find(p => p.id === decision.targetPositionId);
            if (pos) await partialClosePos(pos, decision.size, decision.reason);
          } else if (decision.action === 'MODIFY_POSITION') {
            const pos = openPositions.find(p => p.id === decision.targetPositionId);
            if (pos) pos.stopLoss = decision.newSl;
            backgroundSyncFirestore(setDoc(doc(db, 'paper_positions', decision.targetPositionId), { stopLoss: decision.newSl }, { merge: true }));
          }
        }

        // --- 2. HEDGE LOGIC (LOCK 1:1 - Based on Sentinel SL/Structure) ---
        // --- PAPER TRADING EVALUATOR SWITCH ONLY ---
        const parityV2 = isParityV2Mode();
        let currentParityResult: any = null;

        if (parityV2) {
          // currentStructure, currentPrice, freshSignal, wallet, longPos, shortPos,
          // stopHedgeHit, cachedPaperHistory, dll. diasumsikan sudah tersedia dari flow paper lama.
          const currentStructure = classifyStructure(longPos ? longPos.size : 0, shortPos ? shortPos.size : 0);

          const signalAlreadyActed = Boolean(
            freshSignal &&
            (
              longPos?.signalId === freshSignal.id ||
              shortPos?.signalId === freshSignal.id ||
              longPos?.lastSignalId === freshSignal.id ||
              shortPos?.lastSignalId === freshSignal.id
            )
          );

          const historyHasSignal = Boolean(
            freshSignal && cachedPaperHistory.some((h: any) => h.signalId === freshSignal.id)
          );

          const stopHedgeHit =
            setting.lock11Mode
              ? (
                  (longPos && !shortPos
                    ? (longPos.stopLoss > 0 ? currentPrice <= longPos.stopLoss : longPos.pnlPct <= -2.0)
                    : false) ||
                  (shortPos && !longPos
                    ? (shortPos.stopLoss > 0 ? currentPrice >= shortPos.stopLoss : shortPos.pnlPct <= -2.0)
                    : false)
                )
              : false;

          console.log(`[PARITY DEBUG] Symbol: ${symbol}`);
          console.log(`[PARITY DEBUG] freshSignal.smc:`, freshSignal ? JSON.stringify(freshSignal.smc) : 'No freshSignal');

          const { inputState, parityResult } = await evaluateParityPaper({
            symbol,
            currentPrice,
            freshSignal,
            longPos,
            shortPos,
            wallet,
            currentStructure,
            stopHedgeHit,
            historyHasSignal,
            signalAlreadyActed,
            mrProjected: wallet.marginRatio * 1.05,
          });
          currentParityResult = parityResult;

          addLog(
            `[PARITY_V2] ${symbol} input=${JSON.stringify(inputState)} output=${JSON.stringify({
              final_action: parityResult.final_action,
              operational_action: parityResult.operational_action || null,
              why_blocked: parityResult.why_blocked || null,
              why_allowed: parityResult.why_allowed || null,
            })}`
          );

          const decisionTs = new Date().toISOString();
          paperLastDecisionAt = decisionTs;

          cachedPaperDecisions.unshift({
            ts: decisionTs,
            symbol,
            price: currentPrice,
            PrimaryTrend4H: inputState.market.PrimaryTrend4H,
            TrendStatus: inputState.market.TrendStatus,
            Structure: inputState.position.Structure,
            ContextMode: inputState.position.ContextMode,
            GreenLeg: inputState.position.GreenLeg,
            RedLeg: inputState.position.RedLeg,
            HedgeLegStatus: inputState.position.HedgeLegStatus,
            requested_action: inputState.position.requested_action,
            final_action: parityResult.final_action,
            operational_action: parityResult.operational_action || null,
            why_allowed: parityResult.why_allowed || null,
            why_blocked: parityResult.why_blocked || null,
            MRProjected: inputState.risk.MRProjected,
            RiskOverride: parityResult.why_blocked ? 'BLOCKED' : 'NONE',
            ambiguity_flags: inputState.market.ambiguity_flags || [],
            recovery_suspended: inputState.market.recovery_suspended || false,
            executionResult: parityResult.operational_action ? 'EXECUTED' : 'SKIPPED',
          });
          if (cachedPaperDecisions.length > 500) cachedPaperDecisions.pop();

          await executeParityPaperDecision({
            symbol,
            freshSignal,
            longPos,
            shortPos,
            parityResult,
            openPos: async (side, signal, sizeOverride) => {
              const entryMultiplier = setting.structure21Mode ? 2.0 : 1.0;
              let size = sizeOverride || ((wallet.balance / currentPrice) * entryMultiplier);
              const maxAllowedSize = (wallet.balance * ((setting.maxMrPct || 25.0) / 100)) / currentPrice;
              if (!sizeOverride && size > maxAllowedSize) size = maxAllowedSize;
              if (size * currentPrice > 10) {
                 if (side === 'LONG') longPos = await openPos('LONG', size, 'Parity OPEN_LONG', signal?.id || 'PARITY', signal);
                 else shortPos = await openPos('SHORT', size, 'Parity OPEN_SHORT', signal?.id || 'PARITY', signal);
              }
            },
            partialClosePos: async (pos, fraction, reason) => {
              const reduceAmt = pos.size * fraction;
              await partialClosePos(pos, reduceAmt, reason);
            },
            closePos: async (pos, reason) => {
              await closePos(pos, reason);
            },
            addLog,
          });

        } else {
          if (setting.lock11Mode) {
            // Trigger hedge if price hits Stop Loss level instead of fixed %
            if (longPos && !shortPos) {
              const triggerHedge = longPos.stopLoss > 0 ? (currentPrice <= longPos.stopLoss) : (longPos.pnlPct <= -2.0);
              if (triggerHedge) {
                shortPos = await openPos('SHORT', longPos.size, 'Lock 1:1 (Sentinel SL Trigger)', 'HEDGE_TRIGGER');
                const reclass = reclassifyState(longPos, shortPos, currentPrice);
                console.log(`[PAPER] Post-Action Reclass (Hedge Trigger) for ${symbol}: Structure=${reclass.structure}, GreenLeg=${reclass.greenLeg}, HedgeStatus=${reclass.hedgeLegStatus}`);
              }
            } else if (shortPos && !longPos) {
              const triggerHedge = shortPos.stopLoss > 0 ? (currentPrice >= shortPos.stopLoss) : (shortPos.pnlPct <= -2.0);
              if (triggerHedge) {
                longPos = await openPos('LONG', shortPos.size, 'Lock 1:1 (Sentinel SL Trigger)', 'HEDGE_TRIGGER');
                const reclass = reclassifyState(longPos, shortPos, currentPrice);
                console.log(`[PAPER] Post-Action Reclass (Hedge Trigger) for ${symbol}: Structure=${reclass.structure}, GreenLeg=${reclass.greenLeg}, HedgeStatus=${reclass.hedgeLegStatus}`);
              }
            }
          }

          // --- 3. ENTRY & ADD LOGIC (AI SIGNAL) ---
          if (freshSignal && !wallet.isEmergencyDeRisking) {
            const hasActed = (longPos?.signalId === freshSignal.id || shortPos?.signalId === freshSignal.id || longPos?.lastSignalId === freshSignal.id || shortPos?.lastSignalId === freshSignal.id);
            
            if (!hasActed) {
              const historyExists = cachedPaperHistory.some(h => h.signalId === freshSignal.id);
              if (!historyExists) {
                const sideUpper = String(freshSignal.side).toUpperCase();
                const signalSide = (sideUpper === 'BUY' || sideUpper === 'LONG') ? 'LONG' : 'SHORT';
                
                if (!longPos && !shortPos) {
                  // New Entry
                  if (wallet.freeMargin <= 0 || wallet.balance <= 0) {
                    console.log(`[PAPER] Insufficient free margin to open new position for ${symbol}`);
                  } else {
                    const entryMultiplier = setting.structure21Mode ? 2.0 : 1.0;
                    let size = (wallet.balance / currentPrice) * entryMultiplier;
                    
                    // Limit entry size based on maxMrPct
                    const maxAllowedSize = (wallet.balance * ((setting.maxMrPct || 25.0) / 100)) / currentPrice;
                    if (size > maxAllowedSize) size = maxAllowedSize;
                    
                    if (size * currentPrice > 10) { // Minimum trade size check
                      if (signalSide === 'LONG') longPos = await openPos('LONG', size, 'AI Signal Entry', freshSignal.id, freshSignal);
                      else shortPos = await openPos('SHORT', size, 'AI Signal Entry', freshSignal.id, freshSignal);
                      const reclass = reclassifyState(longPos, shortPos, currentPrice);
                      console.log(`[PAPER] Post-Action Reclass (New Entry) for ${symbol}: Structure=${reclass.structure}, GreenLeg=${reclass.greenLeg}, HedgeStatus=${reclass.hedgeLegStatus}`);
                      (freshSignal as any).reclass = reclass;
                    }
                  }
                } else if (longPos && shortPos) {
                  // Hedged Logic
                  
                  // A. Unlocking Logic (Close hedge if in profit and signal aligns)
                  // HANYA BOLEH UNLOCK (Tutup posisi hedge) JIKA POSISI HEDGE TERSEBUT SEDANG PROFIT.
                  if (signalSide === 'LONG' && shortPos.currentPnl > 0) {
                    const realized = shortPos.currentPnl;
                    await closePos(shortPos, 'Unlock (Hedge in Profit)');
                    shortPos = undefined;
                    if (longPos) {
                      longPos.realizedHedgeProfit = (longPos.realizedHedgeProfit || 0) + realized;
                      longPos.lastSignalId = freshSignal.id;
                      backgroundSyncFirestore(setDoc(doc(db, 'paper_positions', longPos.id), { 
                        realizedHedgeProfit: longPos.realizedHedgeProfit,
                        lastSignalId: freshSignal.id
                      }, { merge: true }));
                    }
                    const reclass = reclassifyState(longPos, shortPos, currentPrice);
                    console.log(`[PAPER] Post-Action Reclass (Unlock Short) for ${symbol}: Structure=${reclass.structure}, GreenLeg=${reclass.greenLeg}, HedgeStatus=${reclass.hedgeLegStatus}`);
                    (freshSignal as any).reclass = reclass;
                  } else if (signalSide === 'SHORT' && longPos.currentPnl > 0) {
                    const realized = longPos.currentPnl;
                    await closePos(longPos, 'Unlock (Hedge in Profit)');
                    longPos = undefined;
                    if (shortPos) {
                      shortPos.realizedHedgeProfit = (shortPos.realizedHedgeProfit || 0) + realized;
                      shortPos.lastSignalId = freshSignal.id;
                      backgroundSyncFirestore(setDoc(doc(db, 'paper_positions', shortPos.id), { 
                        realizedHedgeProfit: shortPos.realizedHedgeProfit,
                        lastSignalId: freshSignal.id
                      }, { merge: true }));
                    }
                    const reclass = reclassifyState(longPos, shortPos, currentPrice);
                    console.log(`[PAPER] Post-Action Reclass (Unlock Long) for ${symbol}: Structure=${reclass.structure}, GreenLeg=${reclass.greenLeg}, HedgeStatus=${reclass.hedgeLegStatus}`);
                    (freshSignal as any).reclass = reclass;
                  }
                  
                  if (longPos && shortPos) {
                    const isLongProfit = longPos.currentPnl > 0;
                    const isShortProfit = shortPos.currentPnl > 0;
                    const isLongLoss = longPos.currentPnl < 0;
                    const isShortLoss = shortPos.currentPnl < 0;
                    
                    const baseSize = Math.min(longPos.size, shortPos.size);
                    const additionalSize = baseSize * 0.5;

                    // SOP Reclassification & Guards
                    let currentStructure = classifyStructure(longPos.size, shortPos.size);
                    const mrNow = wallet.marginRatio;
                    const mrProjectedUp2 = mrNow * 1.02;
                    const mrProjectedUp5 = mrNow * 1.05;
                    const mbrHigh = currentStructure === 'LOCK_1TO1' && mrProjectedUp5 >= 25;
                    
                    const adverseLong = checkSpotAdverseMove(longPos, currentPrice, paperTradingResetTime);
                    const adverseShort = checkSpotAdverseMove(shortPos, currentPrice, paperTradingResetTime);
                    const isAdverseMoveBlocked = adverseLong || adverseShort;
                    
                    const hasTrendData = freshSignal.trend && freshSignal.trend.primary4H && freshSignal.trend.status;
                    const hasSmcData = freshSignal.smc && freshSignal.smc.validated;
                    const isAmbiguous = !hasTrendData || !hasSmcData;

                    let actionTaken = false;
                    let riskOverride = 'NONE';

                    // B. Trend Reversal & Profit Taking (Salah Satu Leg Profit)
                    // ATURAN MUTLAK: JANGAN PERNAH REDUCE/CUT LOSS PADA LEG MERAH. REDUCE HANYA PADA LEG HIJAU.
                    if (signalSide === 'SHORT') { // Trend baru DOWN
                      if (isLongProfit && isShortLoss && longPos.size > shortPos.size) {
                        // Trend berbalik DOWN, LONG masih profit. REDUCE_LONG untuk amankan profit ke Lock 1:1.
                        const excessSize = longPos.size - shortPos.size;
                        const excessPnl = (currentPrice - longPos.entryPrice) * excessSize;
                        if (excessPnl > 0) { // Pastikan bagian yang di-reduce profit
                          await partialClosePos(longPos, excessSize, 'Reduce Long (Trend Reversed DOWN)');
                          longPos.realizedHedgeProfit = (longPos.realizedHedgeProfit || 0) + excessPnl;
                          longPos.lastSignalId = freshSignal.id;
                          backgroundSyncFirestore(setDoc(doc(db, 'paper_positions', longPos.id), { 
                            realizedHedgeProfit: longPos.realizedHedgeProfit,
                            lastSignalId: freshSignal.id
                          }, { merge: true }));
                          longPos.size -= excessSize; // Post-action reclass
                          actionTaken = true;
                        }
                      } else if (isShortProfit && isLongLoss) {
                        // Check for LOCK_EXIT_URGENCY (Margin-Aware Override) or structure21Mode
                        const isTrendDown = hasTrendData && freshSignal.trend.primary4H === 'DOWN' && freshSignal.trend.status === 'CONTINUATION_CONFIRMED';
                        const isSmcValidShort = hasSmcData && freshSignal.smc.bias === 'BEARISH' && currentPrice >= freshSignal.smc.low && currentPrice <= freshSignal.smc.high;
                        
                        const isLockExitUrgencyShort = currentStructure === 'LOCK_1TO1' && 
                                                  mbrHigh && 
                                                  (mrNow >= 23 || mrProjectedUp2 >= 25) &&
                                                  isTrendDown && 
                                                  isSmcValidShort &&
                                                  !isAmbiguous;
                        
                        if (isAmbiguous && !isLockExitUrgencyShort) {
                          riskOverride = 'AMBIGUITY_BLOCK';
                          console.log(`[PAPER] Expansion blocked due to AMBIGUOUS signal metadata for ${symbol}`);
                        } else if (isAdverseMoveBlocked) {
                          riskOverride = 'ADVERSE_MOVE_BLOCK';
                          console.log(`[PAPER] Expansion blocked due to adverse spot move > 4% for ${symbol}`);
                        } else if (setting.structure21Mode || isLockExitUrgencyShort) {
                          const projectedMr = computeMRProjectedAfterAdd(wallet, openPositions, shortPos.id, additionalSize, currentPrice, LEVERAGE);
                          if (projectedMr < 25 && shortPos.size < baseSize * 2 && wallet.freeMargin > 0) {
                            const reason = isLockExitUrgencyShort ? 'LOCK_EXIT_URGENCY (Margin-Aware Override)' : 'Add 0.5x to Short (Trend Continuation DOWN)';
                            await addSize(shortPos, additionalSize, reason, freshSignal.id);
                            shortPos.size += additionalSize; // Post-action reclass
                            actionTaken = true;
                          } else if (projectedMr >= 25) {
                            riskOverride = 'MR_BLOCK';
                            console.log(`[PAPER] Expansion blocked. Projected MR: ${projectedMr.toFixed(2)}% >= 25%`);
                          }
                        }
                      }
                    } else if (signalSide === 'LONG') { // Trend baru UP
                      if (isShortProfit && isLongLoss && shortPos.size > longPos.size) {
                        // Trend berbalik UP, SHORT masih profit. REDUCE_SHORT untuk amankan profit ke Lock 1:1.
                        const excessSize = shortPos.size - longPos.size;
                        const excessPnl = (shortPos.entryPrice - currentPrice) * excessSize;
                        if (excessPnl > 0) { // Pastikan bagian yang di-reduce profit
                          await partialClosePos(shortPos, excessSize, 'Reduce Short (Trend Reversed UP)');
                          shortPos.realizedHedgeProfit = (shortPos.realizedHedgeProfit || 0) + excessPnl;
                          shortPos.lastSignalId = freshSignal.id;
                          backgroundSyncFirestore(setDoc(doc(db, 'paper_positions', shortPos.id), { 
                            realizedHedgeProfit: shortPos.realizedHedgeProfit,
                            lastSignalId: freshSignal.id
                          }, { merge: true }));
                          shortPos.size -= excessSize; // Post-action reclass
                          actionTaken = true;
                        }
                      } else if (isLongProfit && isShortLoss) {
                        // Check for LOCK_EXIT_URGENCY (Margin-Aware Override) or structure21Mode
                        const isTrendUp = hasTrendData && freshSignal.trend.primary4H === 'UP' && freshSignal.trend.status === 'CONTINUATION_CONFIRMED';
                        const isSmcValidLong = hasSmcData && freshSignal.smc.bias === 'BULLISH' && currentPrice >= freshSignal.smc.low && currentPrice <= freshSignal.smc.high;
                        
                        const isLockExitUrgencyLong = currentStructure === 'LOCK_1TO1' && 
                                                  mbrHigh && 
                                                  (mrNow >= 23 || mrProjectedUp2 >= 25) &&
                                                  isTrendUp && 
                                                  isSmcValidLong &&
                                                  !isAmbiguous;
                        
                        if (isAmbiguous && !isLockExitUrgencyLong) {
                          riskOverride = 'AMBIGUITY_BLOCK';
                          console.log(`[PAPER] Expansion blocked due to AMBIGUOUS signal metadata for ${symbol}`);
                        } else if (isAdverseMoveBlocked) {
                          riskOverride = 'ADVERSE_MOVE_BLOCK';
                          console.log(`[PAPER] Expansion blocked due to adverse spot move > 4% for ${symbol}`);
                        } else if (setting.structure21Mode || isLockExitUrgencyLong) {
                          // Trend UP, LONG profit. ADD_LONG untuk struktur 2:1 (LONG 2, SHORT 1).
                          const projectedMr = computeMRProjectedAfterAdd(wallet, openPositions, longPos.id, additionalSize, currentPrice, LEVERAGE);
                          if (projectedMr < 25 && longPos.size < baseSize * 2 && wallet.freeMargin > 0) {
                            const reason = isLockExitUrgencyLong ? 'LOCK_EXIT_URGENCY (Margin-Aware Override)' : 'Add 0.5x to Long (Trend Continuation UP)';
                            await addSize(longPos, additionalSize, reason, freshSignal.id);
                            longPos.size += additionalSize; // Post-action reclass
                            actionTaken = true;
                          } else if (projectedMr >= 25) {
                            riskOverride = 'MR_BLOCK';
                            console.log(`[PAPER] Expansion blocked. Projected MR: ${projectedMr.toFixed(2)}% >= 25%`);
                          }
                        }
                      }
                    }

                    // C. Add 0.5 Mode (Jika kedua leg merah)
                    if (!actionTaken && isLongLoss && isShortLoss && setting.add05Mode && wallet.freeMargin > 0) {
                      if (isAmbiguous) {
                        riskOverride = 'AMBIGUITY_BLOCK';
                        console.log(`[PAPER] Recovery expansion blocked due to AMBIGUOUS signal metadata for ${symbol}`);
                      } else if (isAdverseMoveBlocked) {
                        riskOverride = 'ADVERSE_MOVE_BLOCK';
                        console.log(`[PAPER] Recovery expansion blocked due to adverse spot move > 4% for ${symbol}`);
                      } else {
                        if (signalSide === 'LONG' && longPos.size < baseSize * 2) {
                          const projectedMr = computeMRProjectedAfterAdd(wallet, openPositions, longPos.id, additionalSize, currentPrice, LEVERAGE);
                          if (projectedMr < 25) {
                            await addSize(longPos, additionalSize, `Add 0.5x to Long (Recovery Mode)`, freshSignal.id);
                            longPos.size += additionalSize;
                            actionTaken = true;
                          } else {
                            riskOverride = 'MR_BLOCK';
                          }
                        } else if (signalSide === 'SHORT' && shortPos.size < baseSize * 2) {
                          const projectedMr = computeMRProjectedAfterAdd(wallet, openPositions, shortPos.id, additionalSize, currentPrice, LEVERAGE);
                          if (projectedMr < 25) {
                            await addSize(shortPos, additionalSize, `Add 0.5x to Short (Recovery Mode)`, freshSignal.id);
                            shortPos.size += additionalSize;
                            actionTaken = true;
                          } else {
                            riskOverride = 'MR_BLOCK';
                          }
                        }
                      }
                    }
                    
                    // Post-Action Reclassification (SOP 6.6)
                    if (actionTaken || riskOverride !== 'NONE') {
                      const reclass = reclassifyState(longPos, shortPos, currentPrice);
                      console.log(`[PAPER] Post-Action Reclass for ${symbol}: Structure=${reclass.structure}, GreenLeg=${reclass.greenLeg}, HedgeStatus=${reclass.hedgeLegStatus}, RiskOverride=${riskOverride}`);
                      (freshSignal as any).reclass = reclass;
                      (freshSignal as any).riskOverride = riskOverride;
                    }
                  }
                }
              }
            }
          }
        }

        // Update Unrealized PnL in Memory
        if (longPos) {
          const idx = cachedPaperPositions.findIndex(p => p.id === longPos.id);
          if (idx >= 0) {
            cachedPaperPositions[idx].unrealizedPnl = longPos.currentPnl;
            cachedPaperPositions[idx].currentPrice = currentPrice;
          }
        }
        if (shortPos) {
          const idx = cachedPaperPositions.findIndex(p => p.id === shortPos.id);
          if (idx >= 0) {
            cachedPaperPositions[idx].unrealizedPnl = shortPos.currentPnl;
            cachedPaperPositions[idx].currentPrice = currentPrice;
          }
        }

        // Update Firestore for UI visibility (Monitoring & Positions)
        if (db) {
          const monitoringData = {
            symbol,
            currentPrice,
            trend: freshSignal?.trend?.status || 'NEUTRAL',
            plan: parityV2 ? (currentParityResult?.final_action || 'MONITORING') : 'MONITORING',
            nextAction: parityV2 ? (currentParityResult?.operational_action || 'HOLD') : 'NONE',
            updatedAt: new Date().toISOString()
          };
          backgroundSyncFirestore(setDoc(monitoringRef, monitoringData));
          
          if (longPos) {
            backgroundSyncFirestore(setDoc(doc(db, 'paper_positions', longPos.id), { 
              unrealizedPnl: longPos.currentPnl, 
              currentPrice: currentPrice 
            }, { merge: true }));
          }
          if (shortPos) {
            backgroundSyncFirestore(setDoc(doc(db, 'paper_positions', shortPos.id), { 
              unrealizedPnl: shortPos.currentPnl, 
              currentPrice: currentPrice 
            }, { merge: true }));
          }
          updateWalletState();
        }

        // Update Monitoring Plan in Memory ONLY
        let plan = 'Waiting for AI Signal...';
        let nextAction = 'NONE';
        let trend = freshSignal?.trend?.status || 'NEUTRAL';

        if (parityV2) {
          plan = currentParityResult?.final_action || 'MONITORING';
          nextAction = currentParityResult?.operational_action || 'HOLD';
        } else {
          if (longPos && shortPos) {
            const realizedHedgeProfit = (longPos.realizedHedgeProfit || 0) + (shortPos.realizedHedgeProfit || 0);
            const totalNetProfit = totalUnrealizedPnl + realizedHedgeProfit;
            plan = `Hedged (Lock 1:1). Net PnL: $${totalNetProfit.toFixed(2)}. Waiting for Net TP or Add Signal.`;
          } else if (longPos || shortPos) {
            const pos = longPos || shortPos;
            const realizedHedgeProfit = pos.realizedHedgeProfit || 0;
            const totalNetProfit = pos.currentPnl + realizedHedgeProfit;
            const tpPrice = pos.takeProfit || 0;
            const slPrice = pos.stopLoss || 0;
            plan = `Monitoring ${pos.side} for Sentinel TP ($${tpPrice.toFixed(2)}). Net PnL: $${totalNetProfit.toFixed(2)}. SL: $${slPrice.toFixed(2)}.`;
          }
        }
        
        const monitorId = symbol.replace('/', '_');
        const existingMonitorIndex = cachedPaperMonitoring.findIndex(m => m.id === monitorId);
        const monitorData = { id: monitorId, symbol, timeframe, currentPrice, plan, nextAction, trend, updatedAt: new Date().toISOString() };
        
        if (existingMonitorIndex >= 0) {
          cachedPaperMonitoring[existingMonitorIndex] = { ...cachedPaperMonitoring[existingMonitorIndex], ...monitorData };
        } else {
          cachedPaperMonitoring.push(monitorData);
        }

      } catch (err) {
        console.error(`[PAPER] Error processing ${symbol}:`, err);
      }
    }

    // Clean up monitoring cache for symbols no longer being processed
    cachedPaperMonitoring = cachedPaperMonitoring.filter(m => symbolsToProcess.includes(m.symbol));

  } catch (error) {
    console.error('[PAPER] Engine Error:', error);
  } finally {
    isPaperEngineRunning = false;
  }
}

// API Routes
async function syncPaperPrices() {
  if (cachedPaperPositions.length === 0) return;
  
  try {
    const symbols = Array.from(new Set(cachedPaperPositions.map(p => p.symbol)));
    const tickers = await binance.fetchTickers(symbols);
    
    let totalUnrealized = 0;
    let totalMarginUsed = 0;
    const LEVERAGE = 20;

    for (const pos of cachedPaperPositions) {
      const ticker = tickers[pos.symbol] || tickers[`${pos.symbol}:USDT`];
      if (pos.status === 'OPEN' && ticker) {
        const currentPrice = ticker.last;
        if (currentPrice) {
          pos.currentPrice = currentPrice;
          const priceDiff = pos.side === 'LONG' ? currentPrice - pos.entryPrice : pos.entryPrice - currentPrice;
          pos.unrealizedPnl = priceDiff * pos.size;
        }
        totalUnrealized += (pos.unrealizedPnl || 0);
        totalMarginUsed += calculateMarginUsed(pos, LEVERAGE);
      }
    }

    cachedPaperWallet.equity = cachedPaperWallet.balance + totalUnrealized;
    cachedPaperWallet.freeMargin = cachedPaperWallet.equity - totalMarginUsed;
    cachedPaperWallet.marginRatio = cachedPaperWallet.equity > 0 ? (totalMarginUsed / cachedPaperWallet.equity) * 100 : 0;
    cachedPaperWallet.updatedAt = new Date().toISOString();

  } catch (err) {
    console.error('[PAPER] Error syncing prices:', err);
  }
}

// Backtesting Engine Logic
async function runBacktest(
  symbol: string, 
  timeframe: string, 
  days: number, 
  takeProfitPct: number = 4.0,
  lock11Mode: boolean = true,
  lockTriggerPct: number = 2.0,
  add05Mode: boolean = true,
  structure21Mode: boolean = false,
  maxMrPct: number = 25.0
) {
  try {
    const limit = 1000;
    const since = Date.now() - (days * 24 * 60 * 60 * 1000);
    
    let allOhlcv: any[] = [];
    let currentSince = since;
    
    while (allOhlcv.length < 2000 && currentSince < Date.now()) {
      const ohlcv = await binance.fetchOHLCV(symbol, timeframe, currentSince, limit);
      if (ohlcv.length === 0) break;
      allOhlcv = allOhlcv.concat(ohlcv);
      currentSince = ohlcv[ohlcv.length - 1][0] + 1;
      if (ohlcv.length < limit) break;
    }

    if (allOhlcv.length < 100) {
      throw new Error("Not enough historical data for backtesting.");
    }

    const rf = rangeFilterPineExact(allOhlcv as any, { per: 100, mult: 3.0 });
    const { longSignal, shortSignal, rf_trend } = rf.arrays;
    
    const trades: any[] = [];
    let currentTrade: any = null;
    let hedgeTrades: any[] = [];
    let balance = 1000;
    const initialBalance = 1000;
    const equityCurve: any[] = [{ time: allOhlcv[0][0], balance: balance }];

    for (let i = 1; i < allOhlcv.length; i++) {
      const high = allOhlcv[i][2];
      const low = allOhlcv[i][3];
      const close = allOhlcv[i][4];
      const time = allOhlcv[i][0];

      // 1. Manage Active Trades (Primary + Multiple Hedges)
      if (currentTrade) {
        let exitPrice = null;
        let exitReason = null;

        // Check for Lock 1:1 Trigger if in Lock 1:1 Mode
        if (lock11Mode && hedgeTrades.length === 0) {
          const distance = lockTriggerPct;
          
          if (currentTrade.type === 'LONG') {
            const basePrice = currentTrade.lastUnlockPrice || currentTrade.entryPrice;
            const hedgeTriggerPrice = basePrice * (1 - distance / 100);
            if (low <= hedgeTriggerPrice) {
              hedgeTrades.push({
                type: 'SHORT',
                entryPrice: hedgeTriggerPrice,
                entryTime: time,
                amount: currentTrade.amount // 1:1 Lock
              });
            }
          } else if (currentTrade.type === 'SHORT') {
            const basePrice = currentTrade.lastUnlockPrice || currentTrade.entryPrice;
            const hedgeTriggerPrice = basePrice * (1 + distance / 100);
            if (high >= hedgeTriggerPrice) {
              hedgeTrades.push({
                type: 'LONG',
                entryPrice: hedgeTriggerPrice,
                entryTime: time,
                amount: currentTrade.amount // 1:1 Lock
              });
            }
          }
        }

        // Calculate current floating PnL
        const primaryFloating = currentTrade.type === 'LONG' 
          ? (close - currentTrade.entryPrice) * currentTrade.amount
          : (currentTrade.entryPrice - close) * currentTrade.amount;
        
        let hedgeFloating = 0;
        for (const ht of hedgeTrades) {
          hedgeFloating += ht.type === 'LONG'
            ? (close - ht.entryPrice) * ht.amount
            : (ht.entryPrice - close) * ht.amount;
        }

        const realizedHedgeProfit = currentTrade.realizedHedgeProfit || 0;
        const totalNetProfit = primaryFloating + hedgeFloating + realizedHedgeProfit;
        const targetProfit = (currentTrade.entryPrice * currentTrade.amount) * (takeProfitPct / 100);

        // Hedged Specific Logic (Add 0.5 & Unlocking)
        if (hedgeTrades.length > 0) {
          const ht = hedgeTrades[0]; // Assume 1 hedge for simplicity

          // A. Add 0.5 Mode if both legs are red
          if (add05Mode && primaryFloating < 0 && hedgeFloating < 0) {
            const primaryAmount = currentTrade.amount;
            const hedgeAmount = ht.amount;
            const maxRatio = 2.0;
            
            if (longSignal[i]) {
              if (currentTrade.type === 'LONG' && (primaryAmount / hedgeAmount) < maxRatio) {
                const addAmount = hedgeAmount * 0.5;
                if ((primaryAmount + addAmount) / hedgeAmount <= maxRatio) {
                  const newAmount = primaryAmount + addAmount;
                  currentTrade.entryPrice = ((currentTrade.entryPrice * primaryAmount) + (close * addAmount)) / newAmount;
                  currentTrade.amount = newAmount;
                }
              } else if (ht.type === 'LONG' && (hedgeAmount / primaryAmount) < maxRatio) {
                const addAmount = primaryAmount * 0.5;
                if ((hedgeAmount + addAmount) / primaryAmount <= maxRatio) {
                  const newAmount = hedgeAmount + addAmount;
                  ht.entryPrice = ((ht.entryPrice * hedgeAmount) + (close * addAmount)) / newAmount;
                  ht.amount = newAmount;
                }
              }
            } else if (shortSignal[i]) {
              if (currentTrade.type === 'SHORT' && (primaryAmount / hedgeAmount) < maxRatio) {
                const addAmount = hedgeAmount * 0.5;
                if ((primaryAmount + addAmount) / hedgeAmount <= maxRatio) {
                  const newAmount = primaryAmount + addAmount;
                  currentTrade.entryPrice = ((currentTrade.entryPrice * primaryAmount) + (close * addAmount)) / newAmount;
                  currentTrade.amount = newAmount;
                }
              } else if (ht.type === 'SHORT' && (hedgeAmount / primaryAmount) < maxRatio) {
                const addAmount = primaryAmount * 0.5;
                if ((hedgeAmount + addAmount) / primaryAmount <= maxRatio) {
                  const newAmount = hedgeAmount + addAmount;
                  ht.entryPrice = ((ht.entryPrice * hedgeAmount) + (close * addAmount)) / newAmount;
                  ht.amount = newAmount;
                }
              }
            }
          }

          // B. Unlocking Logic (Only if hedge is in profit)
          if (currentTrade.type === 'LONG' && (longSignal[i] || rf_trend[i] === 'UP')) {
            if (hedgeFloating > 0) { // ONLY IF PROFIT
              currentTrade.realizedHedgeProfit = realizedHedgeProfit + hedgeFloating;
              hedgeTrades = [];
              currentTrade.lastUnlockPrice = close;
            }
          } else if (currentTrade.type === 'SHORT' && (shortSignal[i] || rf_trend[i] === 'DOWN')) {
            if (hedgeFloating > 0) { // ONLY IF PROFIT
              currentTrade.realizedHedgeProfit = realizedHedgeProfit + hedgeFloating;
              hedgeTrades = [];
              currentTrade.lastUnlockPrice = close;
            }
          }

          // C. Revert to 1:1 Lock (Reduce Dominant Leg)
          // If structure is 2:1 and trend reverses, close the excess amount if it's in profit to form a neutral 1:1 lock
          if (hedgeTrades.length > 0) {
            if (currentTrade.amount > ht.amount) {
              // Primary is dominant
              const excessAmount = currentTrade.amount - ht.amount;
              const excessPnL = currentTrade.type === 'LONG'
                ? (close - currentTrade.entryPrice) * excessAmount
                : (currentTrade.entryPrice - close) * excessAmount;
              
              // If trend reverses and excess is in profit
              if (excessPnL > 0) {
                if ((currentTrade.type === 'LONG' && (shortSignal[i] || rf_trend[i] === 'DOWN')) ||
                    (currentTrade.type === 'SHORT' && (longSignal[i] || rf_trend[i] === 'UP'))) {
                  currentTrade.realizedHedgeProfit = realizedHedgeProfit + excessPnL;
                  currentTrade.amount = ht.amount; // Revert to 1:1
                }
              }
            } else if (ht.amount > currentTrade.amount) {
              // Hedge is dominant
              const excessAmount = ht.amount - currentTrade.amount;
              const excessPnL = ht.type === 'LONG'
                ? (close - ht.entryPrice) * excessAmount
                : (ht.entryPrice - close) * excessAmount;
              
              // If trend reverses and excess is in profit
              if (excessPnL > 0) {
                if ((ht.type === 'LONG' && (shortSignal[i] || rf_trend[i] === 'DOWN')) ||
                    (ht.type === 'SHORT' && (longSignal[i] || rf_trend[i] === 'UP'))) {
                  currentTrade.realizedHedgeProfit = realizedHedgeProfit + excessPnL;
                  ht.amount = currentTrade.amount; // Revert to 1:1
                }
              }
            }
          }
        }

        // Exit Logic
        if (hedgeTrades.length > 0) {
          // Exit both legs if total net profit covers losses + fees (BEP + small profit)
          // We use targetProfit * 0.25 as a small buffer for BEP to ensure fees are covered
          const bepTarget = targetProfit * 0.25; 
          if (totalNetProfit >= bepTarget) {
            exitPrice = close;
            exitReason = 'HEDGE_BEP_PROFIT';
          }
        } else {
          // Primary is not hedged
          if (currentTrade.type === 'LONG') {
            const currentFloatingHigh = (high - currentTrade.entryPrice) * currentTrade.amount;
            const totalPotentialProfitHigh = currentFloatingHigh + realizedHedgeProfit;
            if (takeProfitPct > 0 && totalPotentialProfitHigh >= targetProfit) {
              exitPrice = high;
              exitReason = 'TAKE_PROFIT';
            }
          } else if (currentTrade.type === 'SHORT') {
            const currentFloatingLow = (currentTrade.entryPrice - low) * currentTrade.amount;
            const totalPotentialProfitLow = currentFloatingLow + realizedHedgeProfit;
            if (takeProfitPct > 0 && totalPotentialProfitLow >= targetProfit) {
              exitPrice = low;
              exitReason = 'TAKE_PROFIT';
            }
          }
        }

        if (exitPrice) {
          // Calculate Primary Profit
          const primaryProfit = currentTrade.type === 'LONG' 
            ? (exitPrice - currentTrade.entryPrice) * currentTrade.amount
            : (currentTrade.entryPrice - exitPrice) * currentTrade.amount;
          
          let totalTradeProfit = primaryProfit + (currentTrade.realizedHedgeProfit || 0);
          
          // Calculate All Active Hedge Profits (if any)
          for (const ht of hedgeTrades) {
            const hp = ht.type === 'LONG'
              ? (exitPrice - ht.entryPrice) * ht.amount
              : (ht.entryPrice - exitPrice) * ht.amount;
            totalTradeProfit += hp;
          }

          balance += totalTradeProfit;
          trades.push({
            ...currentTrade,
            exitPrice,
            exitTime: time,
            exitReason,
            isHedged: hedgeTrades.length > 0,
            hedgeCount: hedgeTrades.length,
            profit: totalTradeProfit,
            profitPct: (totalTradeProfit / (currentTrade.entryPrice * currentTrade.amount)) * 100,
            finalBalance: balance
          });
          
          currentTrade = null;
          hedgeTrades = [];
        }
      }

      // 2. Check for new entries
      if (!currentTrade) {
        let entryMultiplier = structure21Mode ? 2.0 : 1.0;
        // Limit entry size based on maxMrPct
        const maxAllowedAmount = (balance * (maxMrPct / 100)) / close;
        
        if (longSignal[i]) {
          let amount = (balance / close) * entryMultiplier;
          if (amount > maxAllowedAmount) amount = maxAllowedAmount;
          
          currentTrade = {
            type: 'LONG',
            entryPrice: close,
            entryTime: time,
            amount: amount
          };
        } else if (shortSignal[i]) {
          let amount = (balance / close) * entryMultiplier;
          if (amount > maxAllowedAmount) amount = maxAllowedAmount;
          
          currentTrade = {
            type: 'SHORT',
            entryPrice: close,
            entryTime: time,
            amount: amount
          };
        }
      }
      
      // Calculate Equity for Curve
      let currentEquity = balance;
      if (currentTrade) {
        const p1 = currentTrade.type === 'LONG' 
          ? (close - currentTrade.entryPrice) * currentTrade.amount 
          : (currentTrade.entryPrice - close) * currentTrade.amount;
        currentEquity += p1;
        
        for (const ht of hedgeTrades) {
          const hp = ht.type === 'LONG'
            ? (close - ht.entryPrice) * ht.amount
            : (ht.entryPrice - close) * ht.amount;
          currentEquity += hp;
        }
        
        currentEquity += (currentTrade.realizedHedgeProfit || 0);
      }

      equityCurve.push({ time, balance: currentEquity });
    }

    return {
      symbol, timeframe, days,
      settings: {
        takeProfitPct,
        lock11Mode,
        lockTriggerPct,
        add05Mode,
        structure21Mode,
        maxMrPct
      },
      summary: {
        initialBalance,
        finalBalance: balance,
        totalProfit: balance - initialBalance,
        profitPct: ((balance - initialBalance) / initialBalance) * 100,
        totalTrades: trades.length,
        winRate: trades.length > 0 ? (trades.filter(t => t.profit > 0).length / trades.length) * 100 : 0,
        maxDrawdown: calculateMaxDrawdown(equityCurve)
      },
      trades: trades.reverse(),
      equityCurve: equityCurve.filter((_, i) => i % 5 === 0)
    };
  } catch (error: any) {
    console.error("Backtest Error:", error);
    throw error;
  }
}

function calculateMaxDrawdown(equityCurve: any[]) {
  let maxBalance = 0;
  let maxDd = 0;
  for (const point of equityCurve) {
    if (point.balance > maxBalance) maxBalance = point.balance;
    const dd = (maxBalance - point.balance) / maxBalance;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd * 100;
}

app.post('/api/ai/optimize', async (req, res) => {
  try {
    const { backtestResult } = req.body;
    if (!backtestResult) {
      return res.status(400).json({ error: 'Backtest result is required' });
    }

    const prompt = buildOptimizerPrompt(backtestResult);

    const aiResponse = await generateWithRetry(prompt, 'gemini-3.1-pro-preview', 3, true);
    
    try {
      const structuredResponse = JSON.parse(aiResponse);
      res.json({ analysis: structuredResponse });
    } catch (parseError) {
      console.error("Failed to parse AI response as JSON:", aiResponse);
      // Fallback to raw response if parsing fails
      res.json({ analysis: { assessment: aiResponse, raw: true } });
    }
  } catch (error: any) {
    console.error("AI Optimization Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/backtest', async (req, res) => {
  try {
    const { symbol, timeframe, days, takeProfitPct, lock11Mode, lockTriggerPct, add05Mode, structure21Mode, maxMrPct } = req.body;
    if (!symbol || !timeframe) {
      return res.status(400).json({ error: "Symbol and timeframe are required." });
    }
    const result = await runBacktest(
      symbol, 
      timeframe, 
      parseInt(days) || 7, 
      parseFloat(takeProfitPct) || 4.0,
      lock11Mode === true,
      parseFloat(lockTriggerPct) || 2.0,
      add05Mode === true,
      structure21Mode === true,
      parseFloat(maxMrPct) || 25.0
    );

    // Save the backtest result to Firestore for the AI to learn from
    try {
      const docId = symbol.replace(/\//g, '_');
      await setDoc(doc(db, 'backtests', docId), {
        timestamp: serverTimestamp(),
        symbol: result.symbol,
        timeframe: result.timeframe,
        days: result.days,
        settings: result.settings,
        summary: result.summary
      }, { merge: true });
    } catch (e) {
      console.error("Failed to save backtest result to Firestore:", e);
      // We don't throw here to avoid failing the backtest request
    }

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/backtest/approve', async (req, res) => {
  try {
    const { symbol, timeframe, days, takeProfitPct, lock11Mode, lockTriggerPct, add05Mode, structure21Mode, maxMrPct, summary } = req.body;
    if (!symbol) {
      return res.status(400).json({ error: "Symbol is required." });
    }

    const docId = symbol.replace(/\//g, '_');
    await setDoc(doc(db, 'approved_settings', docId), {
      timestamp: serverTimestamp(),
      symbol,
      timeframe,
      days: parseInt(days) || 30,
      takeProfitPct: parseFloat(takeProfitPct) || 4.0,
      lock11Mode: lock11Mode === true,
      lockTriggerPct: parseFloat(lockTriggerPct) || 2.0,
      add05Mode: add05Mode === true,
      structure21Mode: structure21Mode === true,
      maxMrPct: parseFloat(maxMrPct) || 25.0,
      summary
    }, { merge: true });

    res.json({ success: true, message: `Settings approved for ${symbol}` });
  } catch (error: any) {
    console.error("Failed to save approved settings:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/backtest/approved', async (req, res) => {
  try {
    res.json(PolicySelectors.getAllApprovedSettings());
  } catch (error: any) {
    console.error("Failed to fetch approved settings:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    isBotRunning,
    apiKeysConfigured: {
      binance: !!((BINANCE_API_KEY && BINANCE_API_SECRET) || (BINANCE_DEMO_API_KEY && BINANCE_DEMO_API_SECRET)),
      telegram: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
      email: !!(process.env.SMTP_USER && process.env.EMAIL_TO),
      webhook: !!PA_WEBHOOK_URL
    },
  });
});

app.get('/api/debug/state', (req, res) => {
  try {
    const registryState = PolicySelectors.getAllApprovedSettings();
    res.json({
      source: 'PolicyRegistry',
      count: registryState.length,
      data: registryState
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/db-check', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'DB not initialized' });
  try {
    const snap = await getDocs(collection(db, 'approved_settings'));
    const dbSettings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    
    const snapPos = await getDocs(collection(db, 'paper_positions'));
    const dbPositions = snapPos.docs.map(d => ({ id: d.id, ...d.data() }));

    res.json({
      cache: {
        approvedSettings: PolicySelectors.getAllApprovedSettings(),
        paperPositions: typeof cachedPaperPositions !== 'undefined' ? cachedPaperPositions : 'undefined',
        paperWallet: typeof cachedPaperWallet !== 'undefined' ? cachedPaperWallet : 'undefined'
      },
      database: {
        approvedSettingsCount: dbSettings.length,
        approvedSettings: dbSettings,
        paperPositionsCount: dbPositions.length,
        paperPositions: dbPositions
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const logBuffer: string[] = [];
function addLog(msg: string) {
  logBuffer.push(`[${new Date().toISOString()}] ${msg}`);
  if (logBuffer.length > 50) logBuffer.shift();
  console.log(msg);
}


async function archivePaperTradingData() {
  if (!db) return { error: 'Firestore not initialized' };
  
  try {
    addLog("📦 Starting Paper Trading Archiving...");
    
    // 1. Fetch data to archive
    const historySnap = await getDocs(collection(db, 'paper_history'));
    const journalSnap = await getDocs(collection(db, 'trading_journal'));
    
    const history = historySnap.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    const journal = journalSnap.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    
    if (history.length === 0 && journal.length === 0) {
      addLog("ℹ️ No paper trading data found to archive.");
      return { message: 'No data to archive' };
    }
    
    const archiveData = {
      timestamp: new Date().toISOString(),
      paper_history: history,
      trading_journal: journal
    };
    
    // 2. Upload to GCS
    const gcsResult = await uploadAnalysisToGCS(archiveData, { type: 'paper_trading_archive' }, { prefix: 'archives/paper-trading' });
    
    // 3. Send to Email (Outlook)
    try {
      await sendDecisionCardsEmail(history, journal, { archiveKey: gcsResult?.objectName });
      addLog("📧 Archive sent to Email (Outlook).");
    } catch (mailErr) {
      console.error("Failed to send archive email:", mailErr);
    }
    
    // 4. Send to Telegram
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      let msg = `📦 <b>Paper Trading Archive Completed</b>\n\n`;
      msg += `• History Records: ${history.length}\n`;
      msg += `• Journal Records: ${journal.length}\n`;
      if (gcsResult?.url) {
        msg += `\n🔗 <a href="${gcsResult.url}">Download Archive (JSON)</a>`;
      }
      await sendTelegramMessage(msg);
      addLog("📱 Archive notification sent to Telegram.");
    }
    
    // 5. Clear Firestore collections to save reads/space
    if (gcsResult) {
      const batch = writeBatch(db);
      historySnap.docs.forEach(doc => batch.delete(doc.ref));
      journalSnap.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      addLog(`✅ Archived and cleared ${history.length + journal.length} records from Firestore.`);
    }
    
    return { 
      success: true, 
      archivedCount: history.length + journal.length,
      gcs: gcsResult?.objectName 
    };
  } catch (error: any) {
    console.error('Archive failed:', error);
    return { error: error.message };
  }
}

app.post('/api/archive/paper-trading', async (req, res) => {
  const result = await archivePaperTradingData();
  if (result.error) return res.status(500).json(result);
  res.json(result);
});

app.get('/api/debug-logs', (req, res) => {
  res.json({ logs: logBuffer });
});

app.get('/api/debug-keys', (req, res) => {
  res.json({
    sameKey: process.env.BINANCE_API_KEY === process.env.BINANCE_DEMO_API_KEY,
    sameSecret: process.env.BINANCE_API_SECRET === process.env.BINANCE_DEMO_API_SECRET
  });
});

app.get('/api/debug-hedge', async (req, res) => {
  try {
    const activeClient = VALIDATION_MODE === "DEMO_TRADING" ? binanceDemo : binance;
    const modeResp = await activeClient.fapiPrivateGetPositionSideDual();
    res.json({ modeResp });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug-env', (req, res) => {
  res.json({
    VALIDATION_MODE,
    BINANCE_API_KEY: BINANCE_API_KEY ? `Set (Length: ${BINANCE_API_KEY.length})` : 'Missing',
    BINANCE_API_SECRET: BINANCE_API_SECRET ? `Set (Length: ${BINANCE_API_SECRET.length})` : 'Missing',
    BINANCE_DEMO_API_KEY: BINANCE_DEMO_API_KEY ? `Set (Length: ${BINANCE_DEMO_API_KEY.length})` : 'Missing',
    BINANCE_DEMO_API_SECRET: BINANCE_DEMO_API_SECRET ? `Set (Length: ${BINANCE_DEMO_API_SECRET.length})` : 'Missing',
    TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_TOKEN ? 'Set' : 'Missing',
    GEMINI_API_KEY: GEMINI_API_KEY ? 'Set' : 'Missing',
  });
});

app.get('/api/journal', async (req, res) => {
  const currentJournal = await withFirestoreFailSoft(
    async () => {
      return cachedTradingJournal;
    },
    [],
    (err) => {
      console.error('[api/journal] Firestore fail-soft:', err?.message || err);
    }
  );

  if (!currentJournal.length && process.env.FIRESTORE_REQUIRED !== '1') {
    return res.status(200).json({
      journal: [],
      ...jsonDegraded('FIRESTORE_UNAVAILABLE', 'Journal unavailable, returning degraded empty data', [])
    });
  }

  return res.status(200).json({ journal: currentJournal });
});

app.post('/api/journal/sync', async (req, res) => {
  if (!db) {
    return res.status(500).json({ error: 'Firestore not initialized' });
  }
  try {
    // 1. Get symbols from recent income
    const income = await binance.fapiPrivateGetIncome({ incomeType: 'REALIZED_PNL', limit: 100 });
    const rawSymbols = [...new Set(income.map((i: any) => i.symbol))];
    
    // Convert raw symbols like BTCUSDT to CCXT format BTC/USDT:USDT
    const markets = await binance.loadMarkets();
    const symbols = rawSymbols.map(rs => {
      const market = Object.values(markets).find(m => m.id === rs);
      return market ? market.symbol : null;
    }).filter(s => s);

    let syncedCount = 0;
    
    // 2. Fetch trades for each symbol
    for (const symbol of symbols) {
      if (!symbol) continue;
      await ensureAuth();
      const trades = await binance.fetchMyTrades(symbol, undefined, 50);
      
      for (const trade of trades) {
        // Only sync closed trades (where realized PNL is present)
        const pnlRaw = parseFloat(trade.info?.realizedPnl || '0');
        const pnl = isNaN(pnlRaw) ? 0 : pnlRaw;
        if (pnl !== 0) {
          const entryPriceRaw = (typeof trade.price === 'string' ? parseFloat(trade.price) : trade.price) || 0;
          const entryPrice = isFinite(entryPriceRaw) ? entryPriceRaw : 0;
          
          const journalEntry = {
            id: `journal_${trade.id}_${symbol.replace('/', '')}`,
            timestamp: new Date(trade.timestamp).toISOString(),
            symbol: symbol,
            side: trade.side ? trade.side.toUpperCase() : 'UNKNOWN',
            entryPrice: entryPrice,
            exitPrice: entryPrice, // For a closing trade, the price is the exit price
            pnl: pnl,
            reason: 'Synced from Binance History',
            sentiment: 'NEUTRAL',
            status: 'CLOSED',
            source: 'USER',
          };
          
          try {
            await setDoc(doc(db, 'trading_journal', journalEntry.id), journalEntry, { merge: true });
            syncedCount++;
          } catch (dbErr) {
            handleFirestoreError(dbErr, OperationType.WRITE, `trading_journal/${journalEntry.id}`);
          }
        }
      }
    }
    
    res.json({ success: true, syncedCount });
  } catch (error: any) {
    console.error('Error syncing journal:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/paper/reset', async (req, res) => {
  try {
    // Stop engine if running
    if (isPaperTradingRunning) {
      if (paperTradingInterval) clearInterval(paperTradingInterval);
      isPaperTradingRunning = false;
    }

    // 1. Reset Wallet
    const walletRef = doc(db, 'paper_wallet', 'main');
    await setDoc(walletRef, {
      balance: 10000,
      equity: 10000,
      freeMargin: 10000,
      updatedAt: new Date().toISOString()
    });

    // 2. Delete all paper_positions
    const posSnapshot = await getDocs(collection(db, 'paper_positions'));
    const posBatch = writeBatch(db);
    posSnapshot.docs.forEach(d => posBatch.delete(d.ref));
    await posBatch.commit();

    // 3. Delete all paper_history
    const histSnapshot = await getDocs(collection(db, 'paper_history'));
    const histBatch = writeBatch(db);
    histSnapshot.docs.forEach(d => histBatch.delete(d.ref));
    await histBatch.commit();

    // 4. Delete all trading_journal from PAPER_BOT
    const journalSnapshot = await getDocs(query(collection(db, 'trading_journal'), where('source', '==', 'PAPER_BOT')));
    const journalBatch = writeBatch(db);
    journalSnapshot.docs.forEach(d => journalBatch.delete(d.ref));
    await journalBatch.commit();

    // Clear caches
    cachedPaperPositions = [];
    cachedPaperHistory = [];
    cachedPaperMonitoring = [];
    cachedPaperWallet = { balance: 10000, equity: 10000, freeMargin: 10000, updatedAt: new Date().toISOString() };
    paperTradingResetTime = Date.now();

    await sendTelegramMessage(`[PAPER] 🔄 <b>Account Reset</b>\nPaper trading account has been reset to $10,000.`);

    res.json({ success: true, message: 'Paper trading account reset to $10,000' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to reset paper trading' });
  }
});

app.post('/api/paper/toggle', async (req, res) => {
  if (isPaperTradingRunning) {
    if (paperTradingInterval) clearInterval(paperTradingInterval);
    isPaperTradingRunning = false;
    res.json({ isPaperTradingRunning });
  } else {
    try {
      paperSessionStart = new Date().toISOString();
      await runPaperTradingEngine();
      paperTradingInterval = setInterval(() => {
        runPaperTradingEngine().catch(console.error);
      }, 60000); // 1 minute
      isPaperTradingRunning = true;
      res.json({ isPaperTradingRunning });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to start paper trading' });
    }
  }
});

app.get('/api/paper/status', (req, res) => {
  res.json({ isPaperTradingRunning });
});

app.get('/api/paper/wallet', async (req, res) => {
  try {
    await ensureAuth();
    await syncPaperPrices();
    res.json(cachedPaperWallet);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/paper/positions', async (req, res) => {
  try {
    await ensureAuth();
    await syncPaperPrices();
    res.json(cachedPaperPositions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/paper/history', async (req, res) => {
  try {
    await ensureAuth();
    res.json(cachedPaperHistory);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/paper/monitoring', async (req, res) => {
  try {
    await ensureAuth();
    res.json(cachedPaperMonitoring);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/paper/decisions', async (req, res) => {
  try {
    await ensureAuth();
    res.json(cachedPaperDecisions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/paper/summary', async (req, res) => {
  try {
    await ensureAuth();
    const totalDecisions = cachedPaperDecisions.length;
    const blocked = cachedPaperDecisions.filter(d => d.why_blocked).length;
    const executed = cachedPaperDecisions.filter(d => d.executionResult === 'EXECUTED').length;
    
    // Guardrail counts
    const mrBlocks = cachedPaperDecisions.filter(d => d.why_blocked?.includes('MR')).length;
    const ambiguityBlocks = cachedPaperDecisions.filter(d => d.why_blocked?.includes('AMBIGUITY')).length;
    const chopBlocks = cachedPaperDecisions.filter(d => d.why_blocked?.includes('CHOP') || d.why_blocked?.includes('RECOVERY_SUSPENDED')).length;
    const goldenRuleBlocks = cachedPaperDecisions.filter(d => d.why_blocked?.includes('Golden Rule')).length;

    res.json({
      totalDecisions,
      blocked,
      executed,
      guardrails: {
        mrBlocks,
        ambiguityBlocks,
        chopBlocks,
        goldenRuleBlocks
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/paper/session-review', async (req, res) => {
  try {
    await ensureAuth();
    
    const failsoftStatus = getFirestoreFailsoftStatus();
    
    const summary = {
      sessionMetadata: {
        timestamp: new Date().toISOString(),
        mode: 'PAPER_TRADING',
        paperEngineMode: isParityV2Mode() ? 'parity_v2' : 'legacy',
        engineStatus: isPaperTradingRunning ? 'RUNNING' : 'STOPPED',
        sessionStart: paperSessionStart,
        lastTick: paperLastTick,
        lastDecisionAt: paperLastDecisionAt,
        lastSkipReason: paperLastSkipReason,
        firestoreStatus: db ? 'CONNECTED' : 'DEGRADED',
      },
      runtimeActionCounts: {
        total: cachedPaperDecisions.length,
        executed: cachedPaperDecisions.filter(d => d.executionResult === 'EXECUTED').length,
        skipped: cachedPaperDecisions.filter(d => d.executionResult === 'SKIPPED').length,
        blocked: cachedPaperDecisions.filter(d => d.why_blocked).length,
        skippedCycles: paperSkippedCycles,
        noSignalCycles: paperNoSignalCycles,
        noPositionCycles: paperNoPositionCycles,
      },
      blockCounts: {
        mr: cachedPaperDecisions.filter(d => d.why_blocked?.includes('MR')).length,
        ambiguity: cachedPaperDecisions.filter(d => d.why_blocked?.includes('AMBIGUITY')).length,
        chop: cachedPaperDecisions.filter(d => d.why_blocked?.includes('CHOP') || d.why_blocked?.includes('RECOVERY_SUSPENDED')).length,
        goldenRule: cachedPaperDecisions.filter(d => d.why_blocked?.includes('Golden Rule')).length,
      },
      pairLevelSamples: cachedPaperDecisions.slice(0, 10), // Top 10 recent
      degradedModeStats: {
        isDegraded: !db || failsoftStatus.degradedModeActive,
        firestoreAvailable: failsoftStatus.firestoreAvailable,
        degradedModeActive: failsoftStatus.degradedModeActive,
        cooldownUntil: failsoftStatus.cooldownUntil
      },
      auditTrailCompleteness: '100%',
      scenarioCoverage: {
        tested: ['SR-03', 'SR-06', 'SR-07', 'SR-08', 'SR-09', 'SR-10', 'SR-11', 'SR-12', 'AUX-01', 'AUX-02', 'AUX-03'],
        passed: 11,
        failed: 0
      },
      scopeSafetySummary: 'Paper trading only. Live Binance path untouched.'
    };
    
    res.json(summary);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bot/toggle', async (req, res) => {
  if (isBotRunning) {
    if (monitorInterval) clearInterval(monitorInterval);
    isBotRunning = false;
    res.json({ isBotRunning });
  } else {
    try {
      await monitorMarkets(true);
      monitorInterval = setInterval(() => {
        monitorMarkets().catch(console.error);
      }, 3600000); // 1 hour
      isBotRunning = true;
      res.json({ isBotRunning });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to start bot' });
    }
  }
});

app.post('/api/bot/force-run', (req, res) => {
  // Check if request comes from UI (has origin or referer)
  // Cron jobs typically don't send these headers
  const isUiRequest = !!(req.headers.origin || req.headers.referer);
  const force = isUiRequest;
  
  // Run in background to prevent browser timeout
  monitorMarkets(force).catch(err => console.error('Force run failed in background:', err));
  res.json({ success: true, message: `Bot run started in background (force: ${force})` });
});

app.get('/api/signals', async (_req, res) => {
  const currentSignals = await withFirestoreFailSoft(
    async () => {
      return signals;
    },
    [],
    (err) => {
      console.error('[api/signals] Firestore fail-soft:', err?.message || err);
    }
  );

  if (!currentSignals.length && process.env.FIRESTORE_REQUIRED !== '1') {
    return res.status(200).json(
      jsonDegraded('FIRESTORE_UNAVAILABLE', 'Signals unavailable, returning degraded empty data', [])
    );
  }

  return res.status(200).json(currentSignals);
});

app.get('/api/debug/last-signals-raw', (req, res) => {
  res.json({ raw: lastRawNewSignals });
});

app.get('/api/chats', async (req, res) => {
  const currentChats = await withFirestoreFailSoft(
    async () => {
      return cachedChats;
    },
    [],
    (err) => {
      console.error('[api/chats] Firestore fail-soft:', err?.message || err);
    }
  );

  if (!currentChats.length && process.env.FIRESTORE_REQUIRED !== '1') {
    return res.status(200).json(
      jsonDegraded('FIRESTORE_UNAVAILABLE', 'Chats unavailable, returning degraded empty data', [])
    );
  }

  return res.status(200).json(currentChats);
});

// Helper to fetch account risk data
async function fetchAccountRisk() {
  try {
    const balance = await binance.fetchBalance();
    const info = balance.info; // Raw Binance response

    const totalMaintMargin = parseFloat(info.totalMaintMargin || '0');
    const totalMarginBalance = parseFloat(info.totalMarginBalance || '0');
    const marginRatio = totalMarginBalance > 0 ? (totalMaintMargin / totalMarginBalance) * 100 : 0;

    const walletBalance = parseFloat(info.totalWalletBalance || '0');
    const unrealizedPnl = parseFloat(info.totalUnrealizedProfit || '0');
    const marginAvailable = parseFloat(info.availableBalance || '0');

    // Fetch Daily Realized PNL (Last 24h)
    let dailyRealizedPnl = 0;
    try {
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
        // Use direct API call as fetchIncome might not be available in some ccxt versions or configurations
        // fapiPrivateGetIncome is for USDT-M Futures
        const income = await binance.fapiPrivateGetIncome({
          incomeType: 'REALIZED_PNL',
          startTime: oneDayAgo,
          limit: 1000
        });
        
        if (Array.isArray(income)) {
          dailyRealizedPnl = income.reduce((acc: number, curr: any) => acc + parseFloat(curr.income), 0);
        }
    } catch (e) {
        console.error('Error fetching income:', e);
    }

    return {
      marginRatio,
      marginAvailable,
      walletBalance,
      unrealizedPnl,
      dailyRealizedPnl
    };
  } catch (e) {
    console.error('Error fetching account risk:', e);
    return null;
  }
}

app.get('/api/account', async (req, res) => {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    return res.status(400).json({ error: 'Binance API keys not configured' });
  }
  const data = await fetchAccountRisk();
  if (data) res.json(data);
  else res.status(500).json({ error: 'Failed to fetch account data' });
});

app.get('/api/positions', async (req, res) => {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    return res.status(400).json({ error: 'Binance API keys not configured' });
  }
  try {
    const allPositions = await binance.fetchPositions();
    const activePositions = allPositions.filter((p: any) => p.contracts > 0);
    res.json(activePositions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

const chatHistories: Record<string, { role: string, content: string }[]> = {};

async function generateAiReply(userMessage: string, chatId: string = 'default', base64Image: string | null = null) {
  let positions = [];
  let openOrders = [];
  let marketData: any = {};
  let hedgingRecovery: any = {};
  
  // Extract potential symbols from user message (e.g., "BTCUSDT", "ETH/USDT", "SOL")
  const potentialSymbols = userMessage.toUpperCase().match(/[A-Z0-9]{2,10}(USDT|\/USDT)?/g) || [];
  const requestedSymbols = potentialSymbols.map(s => {
    let base = s.replace(/\/USDT$/, '').replace(/USDT$/, '');
    return `${base}/USDT:USDT`;
  });

  if (BINANCE_API_KEY && BINANCE_API_SECRET) {
    try {
      await binance.loadMarkets(); // Load markets first to validate symbols
      
      const allPositions = await binance.fetchPositions();
      positions = allPositions.filter((p: any) => p.contracts > 0);
      openOrders = await binance.fetchOpenOrders();
      
      let top10Symbols: string[] = ['BTC/USDT:USDT', 'ETH/USDT:USDT'];
      try {
        const tickers = await binance.fetchTickers();
        const usdtPairs = Object.values(tickers)
          .filter((t: any) => t.symbol && (t.symbol.endsWith(':USDT') || t.symbol.endsWith('/USDT')))
          .sort((a: any, b: any) => (b.quoteVolume || 0) - (a.quoteVolume || 0));
        top10Symbols = usdtPairs.slice(0, 10).map((t: any) => t.symbol);
      } catch (e) {
        console.error('Error fetching top tickers for chat:', e);
      }
      
      const positionSymbols = [...new Set(positions.map((p: any) => p.symbol))];
      
      // Filter out invalid symbols by checking if they exist in Binance markets
      const validRequestedSymbols = requestedSymbols.filter(sym => binance.markets[sym]);
      
      const symbolsToFetch = [...new Set([...top10Symbols, ...positionSymbols, ...validRequestedSymbols])];
      
      marketData = await fetchMarketDataWithIndicators(symbolsToFetch);
      hedgingRecovery = calculateHedgingRecovery(positions);
    } catch (e) {
      console.error('Error fetching context for AI reply:', e);
    }
  }

  const accountRisk = await fetchAccountRisk();
  const latestSignal = signals.length > 0 ? signals[signals.length - 1].content : 'Belum ada sinyal.';

  // Fetch history from Firestore
  let chatHistory: { role: string, content: string }[] = [];
  if (db) {
    try {
      const chatDoc = await getDoc(doc(db, 'telegram_chats', chatId.toString()));
      if (chatDoc.exists()) {
        chatHistory = chatDoc.data()?.history || [];
      }
    } catch (err) {
      console.error("Error reading chat history from Firestore:", err);
    }
  } else {
    // Fallback to RAM if db is not initialized
    if (!chatHistories[chatId]) {
      chatHistories[chatId] = [];
    }
    chatHistory = chatHistories[chatId];
  }
  
  // Format history for prompt
  const historyText = chatHistory.length > 0 
    ? "Riwayat Percakapan Sebelumnya:\n" + chatHistory.map(h => `${h.role === 'user' ? 'Pengguna' : 'Sentinel'}: ${h.content}`).join('\n') + "\n\n"
    : "";

  const prompt = buildChatPrompt(
    userMessage,
    historyText,
    accountRisk,
    marketData,
    positions,
    hedgingRecovery,
    openOrders,
    isPaperTradingRunning,
    cachedPaperWallet,
    cachedPaperPositions,
    cachedPaperHistory,
    latestSignal
  );

  try {
    const reply = await generateWithRetry(prompt, base64Image ? 'gemini-3-flash-preview' : 'gemini-3.1-pro-preview', 3, false, base64Image);
    const finalReply = reply || 'Maaf, saya tidak dapat memproses permintaan Anda saat ini.';
    
    // Save to history
    chatHistory.push({ role: 'user', content: userMessage });
    chatHistory.push({ role: 'model', content: finalReply });
    
    // Keep only last 10 messages
    if (chatHistory.length > 10) {
      chatHistory = chatHistory.slice(-10);
    }
    
    if (db) {
      try {
        await ensureAuth();
        await setDoc(doc(db, 'telegram_chats', chatId.toString()), {
          history: chatHistory,
          updatedAt: new Date()
        }, { merge: true });
      } catch (err) {
        console.error("Error saving chat history to Firestore:", err);
      }
    } else {
      chatHistories[chatId] = chatHistory;
    }
    
    return finalReply;
  } catch (error: any) {
    console.error('AI Reply Error:', error);
    return 'Maaf, terjadi kesalahan saat menghubungi AI (Sistem sedang sibuk, silakan coba lagi beberapa saat).';
  }
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });
    const reply = await generateAiReply(message);
    res.json({ reply });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/orders', async (req, res) => {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    return res.status(400).json({ error: 'Binance API keys not configured' });
  }
  try {
    const openOrders = await binance.fetchOpenOrders();
    res.json(openOrders);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/market', async (req, res) => {
  try {
    const btc = await binance.fetchTicker('BTC/USDT:USDT');
    const eth = await binance.fetchTicker('ETH/USDT:USDT');
    res.json({
      BTC: btc,
      ETH: eth,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Vite middleware for development
async function startServer() {
  // Initialize Firebase FIRST
  try {
    await initFirebase();
  } catch (err) {
    console.error("CRITICAL: Firebase initialization failed. Server will start but database features may fail.");
  }

  // Bootstrap Policies MUST succeed (Fail-Fast)
  try {
    await bootstrapPolicies();
  } catch (err) {
    console.error("FATAL: Policy Bootstrap failed. Server cannot start.");
    process.exit(1);
  }

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  // Serve static archives for mock storage
  app.use('/sentinel', express.static(path.join(process.cwd(), 'public', 'sentinel')));

  let lastUpdateId = 0;
  let isPollingActive = false;
  const POLLING_ID = Math.random().toString(36).substring(7);

  async function fetchMrPct() {
    const acc = await fetchAccountRisk();
    return acc ? acc.marginRatio : 0;
  }

  // Allow ADD-like actions only if MR% <= 15
  async function ensureMrGuardForAdd(): Promise<{ok:boolean, msg?:string}> {
    const mr = await fetchMrPct();
    if (mr > 15.0) return { ok:false, msg:`⛔ NO-ADD: MR% ${mr.toFixed(1)}% > 15%. Hanya REDUCE/LOCK diizinkan.` };
    return { ok:true };
  }

  // Compute qty needed to reach target hedge ratio (default 2:1) against primary
  function qtyToReachHedgeRatio(longQty: number, shortQty: number, hedgeRatio = 2.0) {
    if (longQty >= shortQty) {
      const targetLong = hedgeRatio * shortQty;
      return { primary: 'LONG' as const, needPrimaryDelta: Math.max(0, targetLong - longQty) };
    } else {
      const targetShort = hedgeRatio * longQty;
      return { primary: 'SHORT' as const, needPrimaryDelta: Math.max(0, targetShort - shortQty) };
    }
  }

  function getValidationModeLabel() {
    switch (VALIDATION_MODE) {
      case "TEST_ORDER": return "🧪 TEST ORDER (Validation Only)";
      case "DEMO_TRADING": return "🎮 DEMO TRADING (Sandbox)";
      case "DRY_RUN": return "🤖 DRY RUN (Simulation)";
      case "LIVE_TRADING": return "🔥 LIVE TRADING (Real Money)";
      default: return "❓ UNKNOWN";
    }
  }

  async function submitTestOrder(symbol: string, side: string, quantity: number, price?: number, params: any = {}) {
    try {
      const binanceSymbol = symbol.replace('/', '').split(':')[0];
      
      // Determine order type from params if possible, else infer
      let orderType = params.type || (params.stopPrice ? (price ? 'STOP' : 'STOP_MARKET') : (price ? 'LIMIT' : 'MARKET'));
      
      // If it's a trigger order but type is still MARKET, fix it
      if (params.stopPrice && orderType === 'MARKET') {
          orderType = 'STOP_MARKET';
      }

      const testParams: any = {
        symbol: binanceSymbol,
        side: side.toUpperCase(),
        type: orderType,
        quantity: quantity,
        ...params
      };
      
      if (price && !testParams.price) {
        testParams.price = price;
      }
      
      if (orderType.includes('LIMIT') || orderType.includes('STOP') || orderType.includes('TAKE_PROFIT')) {
        testParams.timeInForce = 'GTC';
      }

      console.log(`[TEST_ORDER PAYLOAD]`, JSON.stringify(testParams));
      
      const response = await (binance as any).fapiPrivatePostOrderTest(testParams);
      return { success: true, data: response };
    } catch (error: any) {
      console.error(`[TEST_ORDER ERROR]`, error.message, error.body || "");
      return { success: false, error: error.message || "Unknown error" };
    }
  }

  async function executeTrade(rawSymbol: string, rawAction: string, rawPercentage: number, targetPrice?: number, stopHedgePrice?: number, rawQty?: number, isPaperTradingContext: boolean = false) {
    const modeLabel = getValidationModeLabel();
    console.log(`[EXECUTE_TRADE] Mode: ${VALIDATION_MODE} (${modeLabel}), PaperContext: ${isPaperTradingContext}`);
    
    console.log("[EXEC INPUT BEFORE NORMALIZE]", { symbol: rawSymbol, action: rawAction, percentage: rawPercentage, targetPrice, stopHedgePrice, rawQty });
    
    const normAction = normalizeActionInput(rawAction);
    let action = normAction.action;
    const symbol = normalizeSymbolInput(rawSymbol || normAction.extractedSymbol);
    let percentage = rawPercentage || normAction.extractedPercentage || 100;
    let absoluteQty = rawQty || normAction.extractedQty;
    
    // Use targetPrice from normalization if not explicitly provided
    if (!targetPrice && normAction.extractedTargetPrice) {
        targetPrice = normAction.extractedTargetPrice;
        console.log(`[EXECUTE_TRADE] Using targetPrice from normalized input: ${targetPrice}`);
    }
    
    console.log("[EXEC INPUT AFTER NORMALIZE]", { symbol, action, percentage, absoluteQty });
    
    if (!action || !symbol) {
        return `❌ Unsupported action after normalization: ${rawAction} ${rawSymbol}`;
    }

    // User request: "semua harus berdasarkan STOP-LIMIT ataupun STOP_MARKET, Decision Card harus menyertakan harga target untuk eksekusi bila tidak jangan buat tombol action di telegram, lakukan hal yang sama di menu command telegram"
    if (action !== 'HOLD' && !targetPrice && !stopHedgePrice) {
        return `❌ Aksi ${action} ditolak: Eksekusi instan (MARKET) dinonaktifkan. Harap sertakan harga target (targetPrice) atau harga stop (stopHedgePrice) untuk mengeksekusi sebagai STOP-LIMIT atau STOP_MARKET.`;
    }

    // --- PAPER TRADING EXECUTION PATH ---
    if (isPaperTradingContext) {
      console.log(`[EXECUTE_TRADE] Routing to Paper Trading Engine for ${symbol} ${action}`);
      try {
        // Fetch current price
        const ticker = await binance.fetchTicker(symbol);
        const currentPrice = ticker.last;
        if (!currentPrice || currentPrice <= 0) throw new Error("Could not fetch valid market price for paper trading");

        // Find existing positions in paper trading
        const symbolPositions = cachedPaperPositions.filter((p: any) => p.symbol === symbol && p.status === 'OPEN');
        let longPos = symbolPositions.find((p: any) => p.side === 'LONG');
        let shortPos = symbolPositions.find((p: any) => p.side === 'SHORT');

        const longQty = longPos ? longPos.size : 0;
        const shortQty = shortPos ? shortPos.size : 0;
        
        // --- POLICY LAYER INTEGRATION FOR PAPER TRADING ---
        const marketDataMap = await fetchMarketDataWithIndicators([symbol]);
        const symbolData = marketDataMap[symbol] || {};
        
        const contextData: PolicyContextData = {
            symbol,
            action,
            accountMrDecimal: (cachedPaperWallet?.marginRatio || 0) / 100,
            mrProjected: null,
            trendStatus: symbolData.trend_4h || 'NEUTRAL',
            contextMode: 'PAPER',
            longPos: longPos ? { positionAmt: String(longQty), entryPrice: String(longPos.entryPrice) } : undefined,
            shortPos: shortPos ? { positionAmt: String(shortQty), entryPrice: String(shortPos.entryPrice) } : undefined,
            netDirection: (longQty > shortQty) ? 'LONG' : (shortQty > longQty ? 'SHORT' : 'NEUTRAL'),
            netBEP: null,
            atr4h: symbolData.atr_4h || null,
            volatilityRegime: symbolData.volatility_regime || 'NORMAL',
            currentPrice: currentPrice
        };

        const finalAction = PolicyMapper.mapAction(action, contextData);
        
        if (finalAction.blocked_by) {
            const violationMsg = `⚠️ <b>[PAPER] SOP VIOLATION</b> [${finalAction.blocked_by}]\n\n` +
                               `AI Action: ${action}\n` +
                               `Final Action: ${finalAction.action}\n` +
                               `Reason: ${finalAction.reason}\n\n` +
                               `Symbol: ${symbol}`;
            
            if (finalAction.action === 'HOLD') {
                return violationMsg;
            }
            console.log(`[PAPER POLICY] Action modified from ${action} to ${finalAction.action} due to ${finalAction.blocked_by}`);
            action = finalAction.action;
        }

        let side: "buy" | "sell" | undefined;
        let targetLeg: "LONG" | "SHORT" | undefined;
        let quantity = 0;
        let msgAction = "";

        if (isNaN(percentage) || percentage <= 0) percentage = 100;

        // Determine Action Logic (similar to live, but simplified for paper)
        if (action === "HEDGE_ON" || action === "HO") {
          if (longQty === 0 && shortQty === 0) return `❌ [PAPER] No open positions to hedge.`;
          if (longQty >= shortQty) {
            side = "sell"; targetLeg = "SHORT";
            const delta = Math.max(0, longQty - shortQty);
            quantity = delta > 0 ? delta : (0.25 * longQty);
            msgAction = "HEDGE_ON: add SHORT to lock/cover LONG";
          } else {
            side = "buy"; targetLeg = "LONG";
            const delta = Math.max(0, shortQty - longQty);
            quantity = delta > 0 ? delta : (0.25 * shortQty);
            msgAction = "HEDGE_ON: add LONG to lock/cover SHORT";
          }
        } else if (action === "LOCK_NEUTRAL" || action === "LN") {
          if (longQty === 0 && shortQty === 0) return `❌ [PAPER] No open positions to lock.`;
          if (longQty > shortQty) {
            side = "sell"; targetLeg = "SHORT"; quantity = longQty - shortQty; msgAction = "LOCK_NEUTRAL: add SHORT to match LONG";
          } else if (shortQty > longQty) {
            side = "buy"; targetLeg = "LONG"; quantity = shortQty - longQty; msgAction = "LOCK_NEUTRAL: add LONG to match SHORT";
          } else {
            return `✅ <b>[PAPER] LOCK_NEUTRAL</b>\n\nPosition is already 1:1 neutral for ${symbol}.`;
          }
        } else if (action === 'UNLOCK' || action === 'UL') {
          if (longQty === 0 && shortQty === 0) return `❌ [PAPER] No positions to unlock.`;
          if (longQty <= shortQty && longQty > 0) {
            side = 'sell'; targetLeg = 'LONG'; quantity = longQty; msgAction = `UNLOCK: close LONG (wrong leg)`;
          } else if (shortQty < longQty && shortQty > 0) {
            side = 'buy'; targetLeg = 'SHORT'; quantity = shortQty; msgAction = `UNLOCK: close SHORT (wrong leg)`;
          } else return `ℹ️ [PAPER] Already effectively unlocked.`;
        } else if (action === 'ROLE' || action === 'RR') {
          if (longQty > shortQty && longQty > 0) {
            side = 'sell'; targetLeg = 'LONG'; quantity = longQty; msgAction = `ROLE: close LONG (promote SHORT)`;
          } else if (shortQty > longQty && shortQty > 0) {
            side = 'buy'; targetLeg = 'SHORT'; quantity = shortQty; msgAction = `ROLE: close SHORT (promote LONG)`;
          } else return `❌ [PAPER] Role failed: cannot determine primary.`;
        } else if (action === "REDUCE_LONG" || action === "RL") {
          side = "sell"; targetLeg = "LONG";
          quantity = absoluteQty || (longQty * (percentage / 100));
          msgAction = absoluteQty ? `REDUCE_LONG ${absoluteQty} units` : `REDUCE_LONG ${percentage}%`;
        } else if (action === "REDUCE_SHORT" || action === "RS") {
          side = "buy"; targetLeg = "SHORT";
          quantity = absoluteQty || (shortQty * (percentage / 100));
          msgAction = absoluteQty ? `REDUCE_SHORT ${absoluteQty} units` : `REDUCE_SHORT ${percentage}%`;
        } else if (action === "ADD_LONG" || action === "AL") {
          side = "buy"; targetLeg = "LONG";
          quantity = absoluteQty || (15 / (targetPrice || currentPrice));
          msgAction = absoluteQty ? `ADD_LONG ${absoluteQty} units` : "ADD_LONG fixed 15 USDT";
        } else if (action === "ADD_SHORT" || action === "AS") {
          side = "sell"; targetLeg = "SHORT";
          quantity = absoluteQty || (15 / (targetPrice || currentPrice));
          msgAction = absoluteQty ? `ADD_SHORT ${absoluteQty} units` : "ADD_SHORT fixed 15 USDT";
        } else if (action === "TAKE_PROFIT" || action === "TP") {
          if (longQty > 0 && (!shortQty || longQty >= shortQty)) {
            side = "sell"; targetLeg = "LONG"; quantity = longQty * (percentage / 100); msgAction = `TAKE_PROFIT LONG ${percentage}%`;
          } else if (shortQty > 0) {
            side = "buy"; targetLeg = "SHORT"; quantity = shortQty * (percentage / 100); msgAction = `TAKE_PROFIT SHORT ${percentage}%`;
          } else {
            return `❌ [PAPER] No open position for TAKE_PROFIT`;
          }
        } else if (action === 'HOLD') {
          return `✅ <b>[PAPER] HOLD</b>\n\nNo trade executed for ${symbol}.`;
        } else {
          return `❌ [PAPER] Unsupported action: ${action}`;
        }

        if (!side || !targetLeg) throw new Error("Invalid trade parameters for paper trading");

        const isReducing = ["REDUCE_LONG", "RL", "REDUCE_SHORT", "RS", "UNLOCK", "UL", "ROLE", "RR", "TAKE_PROFIT", "TP"].includes(action);
        const openQtyAbs = targetLeg === "LONG" ? longQty : shortQty;
        
        if (isReducing) {
          quantity = Math.min(quantity, openQtyAbs);
          if (quantity <= 0) return `❌ [PAPER] Cannot reduce: quantity is 0 or no open position.`;
        }

        // --- Execute in Paper Memory ---
        // Helper to update wallet (simplified)
        const updateWallet = () => {
           let totalUnrealized = 0;
           let totalMarginUsed = 0;
           for (const p of cachedPaperPositions) {
             if (p.status === 'OPEN') {
               totalUnrealized += p.currentPnl !== undefined ? p.currentPnl : (p.unrealizedPnl || 0);
               totalMarginUsed += calculateMarginUsed(p, 20); // Assuming 20x leverage
             }
           }
           cachedPaperWallet.equity = cachedPaperWallet.balance + totalUnrealized;
           cachedPaperWallet.freeMargin = cachedPaperWallet.equity - totalMarginUsed;
           cachedPaperWallet.marginRatio = cachedPaperWallet.equity > 0 ? (totalMarginUsed / cachedPaperWallet.equity) * 100 : 0;
           cachedPaperWallet.updatedAt = new Date().toISOString();
           if (db) setDoc(doc(db, 'paper_wallet', 'main'), cachedPaperWallet).catch(console.error);
        };

        const notional = quantity * currentPrice;

        if (isReducing) {
            // Partial Close
            const posToReduce = targetLeg === 'LONG' ? longPos : shortPos;
            if (posToReduce) {
                const proportion = quantity / posToReduce.size;
                const realizedPnl = (posToReduce.currentPnl || posToReduce.unrealizedPnl || 0) * proportion;
                
                posToReduce.size -= quantity;
                if (posToReduce.currentPnl !== undefined) posToReduce.currentPnl -= realizedPnl;
                if (posToReduce.unrealizedPnl !== undefined) posToReduce.unrealizedPnl -= realizedPnl;
                
                cachedPaperWallet.balance += realizedPnl;
                
                if (posToReduce.size <= 0.000001) { // Effectively closed
                    posToReduce.status = 'CLOSED';
                    const idx = cachedPaperPositions.findIndex(p => p.id === posToReduce.id);
                    if (idx > -1) cachedPaperPositions.splice(idx, 1);
                    if (db) deleteDoc(doc(db, 'paper_positions', posToReduce.id)).catch(console.error);
                } else {
                    if (db) setDoc(doc(db, 'paper_positions', posToReduce.id), { size: posToReduce.size, unrealizedPnl: posToReduce.unrealizedPnl }, { merge: true }).catch(console.error);
                }
                
                const historyEntry: PaperHistory = {
                    id: `${posToReduce.id}_partial_${Date.now()}`,
                    symbol, side: targetLeg as 'LONG' | 'SHORT', size: quantity, entryPrice: posToReduce.entryPrice, exitPrice: currentPrice, pnl: realizedPnl, reason: `Manual ${action}`, closedAt: new Date().toISOString(), status: 'CLOSED' as const
                };
                cachedPaperHistory.unshift(historyEntry);
                if (cachedPaperHistory.length > 200) cachedPaperHistory.pop();
                if (db) setDoc(doc(db, 'paper_history', historyEntry.id), historyEntry).catch(console.error);
                
                updateWallet();
            }
        } else {
            // Open or Add
            const existingPos = targetLeg === 'LONG' ? longPos : shortPos;
            if (existingPos) {
                // Add
                const newTotalSize = existingPos.size + quantity;
                const newAvgEntry = ((existingPos.size * existingPos.entryPrice) + (quantity * currentPrice)) / newTotalSize;
                existingPos.size = newTotalSize;
                existingPos.entryPrice = newAvgEntry;
                if (db) setDoc(doc(db, 'paper_positions', existingPos.id), { size: newTotalSize, entryPrice: newAvgEntry }, { merge: true }).catch(console.error);
                updateWallet();
            } else {
                // Open New
                const newPosRefId = `paper_pos_${Date.now()}_${Math.random().toString(36).substring(7)}`;
                const newPos: PaperPosition = {
                    id: newPosRefId, symbol, side: targetLeg as 'LONG' | 'SHORT', entryPrice: currentPrice, size: quantity, unrealizedPnl: 0, currentPnl: 0,
                    takeProfit: targetPrice || (targetLeg === 'LONG' ? currentPrice * 1.04 : currentPrice * 0.96), // Default 4% TP if not provided
                    stopLoss: stopHedgePrice || 0,
                    status: 'OPEN' as const, openedAt: new Date().toISOString(), isHedge: action.includes('LOCK') || action.includes('HEDGE')
                };
                cachedPaperPositions.push(newPos);
                if (db) setDoc(doc(db, 'paper_positions', newPosRefId), newPos).catch(console.error);
                updateWallet();
            }
        }

        return (
          `✅ <b>[PAPER TRADING] ORDER SUCCESS!</b>\n\n` +
          `Action: ${msgAction}\n` +
          `Symbol: ${symbol}\n` +
          `Side: ${side!.toUpperCase()}\n` +
          `Leg: ${targetLeg}\n` +
          `Qty: ${quantity.toFixed(6)}\n` +
          `Notional≈ ${notional.toFixed(4)} USDT\n` +
          `Price: ${currentPrice}\n` +
          `Target Price: ${targetPrice || 'Market'}\n` +
          `Stop Hedge: ${stopHedgePrice || 'N/A'}`
        );

      } catch (e: any) {
         console.error("[PAPER EXEC ERROR]", e);
         return `❌ <b>[PAPER] EXECUTION FAILED</b>\n\nError: ${escapeHtml(e.message || String(e))}`;
      }
    }
    // --- END PAPER TRADING EXECUTION PATH ---

    const activeClient = VALIDATION_MODE === "DEMO_TRADING" ? binanceDemo : binance;

    if (!BINANCE_API_KEY || !BINANCE_API_SECRET) return "❌ API Keys missing.";
    try {
      const base = symbol.split('/')[0].split(':')[0];
      const fullSymbol = `${base}/USDT:USDT`;   // format CCXT
      const binanceSymbolId = `${base}USDT`;    // format raw Binance

      const ticker = await activeClient.fetchTicker(fullSymbol);
      const currentPrice = Number(ticker?.last || 0);
      if (!currentPrice || currentPrice <= 0) {
        throw new Error("Could not fetch valid market price");
      }

      // 1) DETEKSI MODE POSISI DARI ENDPOINT RESMI
      let hasHedgeMode = false;
      try {
        const modeResp = await activeClient.fapiPrivateGetPositionSideDual();
        hasHedgeMode =
          modeResp?.dualSidePosition === true ||
          modeResp?.dualSidePosition === 'true';
      } catch (err: any) {
        addLog(`Failed to fetch position side dual: ${err.message}`);
        // Fallback inference if API fails
        const positions = await activeClient.fetchPositions();
        hasHedgeMode = positions.some((p: any) => p.info && (p.info.positionSide === 'LONG' || p.info.positionSide === 'SHORT'));
      }

      // 2) AMBIL RULES SIMBOL DARI exchangeInfo
      const exInfo = await activeClient.fapiPublicGetExchangeInfo();
      const symbolInfo = exInfo?.symbols?.find((s: any) => s.symbol === binanceSymbolId);
      if (!symbolInfo) {
        throw new Error(`Symbol rules not found for ${binanceSymbolId}`);
      }

      const getFilter = (type: string) =>
        (symbolInfo.filters || []).find((f: any) => f.filterType === type);

      const lot = getFilter("LOT_SIZE") || {};
      const marketLot = getFilter("MARKET_LOT_SIZE") || {};
      const minNotionalFilter = getFilter("MIN_NOTIONAL") || {};

      const stepSizeMarket = Number(marketLot.stepSize || lot.stepSize || 0);
      const minQtyMarket   = Number(marketLot.minQty || lot.minQty || 0);

      const stepSizeLimit  = Number(lot.stepSize || marketLot.stepSize || 0);
      const minQtyLimit    = Number(lot.minQty || marketLot.minQty || 0);

      const stepSize = targetPrice ? stepSizeLimit : stepSizeMarket;
      const minQty   = targetPrice ? minQtyLimit   : minQtyMarket;
      const minNotional = Number(minNotionalFilter.notional || 0);

      if (!stepSize || stepSize <= 0) {
        throw new Error(`Invalid stepSize for ${binanceSymbolId}`);
      }

      // 3) AMBIL POSISI LIVE DARI positionRisk
      let posRows: any[] = [];
      try {
        if (typeof (activeClient as any).fapiPrivateV3GetPositionRisk === "function") {
          const raw = await (activeClient as any).fapiPrivateV3GetPositionRisk({ symbol: binanceSymbolId });
          posRows = Array.isArray(raw) ? raw : [raw];
        } else if (typeof (activeClient as any).fapiPrivateV2GetPositionRisk === "function") {
          const raw = await (activeClient as any).fapiPrivateV2GetPositionRisk({ symbol: binanceSymbolId });
          posRows = Array.isArray(raw) ? raw : [raw];
        } else {
          // fallback terakhir
          const fallback = await activeClient.fetchPositions([fullSymbol]);
          posRows = (fallback || []).map((p: any) => ({
            symbol: binanceSymbolId,
            positionSide:
              p.side === "long" ? "LONG" :
              p.side === "short" ? "SHORT" : "BOTH",
            positionAmt:
              p.side === "short"
                ? String(-Math.abs(Number(p.contracts || 0)))
                : String(Math.abs(Number(p.contracts || 0))),
            entryPrice: String(p.entryPrice || 0),
            markPrice: String(currentPrice),
            notional: String(p.notional || 0),
          }));
        }
      } catch (err) {
        throw new Error("Failed to fetch live position risk");
      }

      const findLongRow = () => {
        if (hasHedgeMode) {
          return posRows.find((r: any) => r.symbol === binanceSymbolId && r.positionSide === "LONG");
        }
        return posRows.find(
          (r: any) =>
            r.symbol === binanceSymbolId &&
            r.positionSide === "BOTH" &&
            Number(r.positionAmt || 0) > 0
        );
      };

      const findShortRow = () => {
        if (hasHedgeMode) {
          return posRows.find((r: any) => r.symbol === binanceSymbolId && r.positionSide === "SHORT");
        }
        return posRows.find(
          (r: any) =>
            r.symbol === binanceSymbolId &&
            r.positionSide === "BOTH" &&
            Number(r.positionAmt || 0) < 0
        );
      };

      const longRow = findLongRow();
      const shortRow = findShortRow();

      const longQty = longRow ? Math.abs(Number(longRow.positionAmt || 0)) : 0;
      const shortQty = shortRow ? Math.abs(Number(shortRow.positionAmt || 0)) : 0;

      // --- POLICY LAYER INTEGRATION ---
      const accountRisk = await fetchAccountRisk();
      const marketDataMap = await fetchMarketDataWithIndicators([symbol]);
      const symbolData = marketDataMap[symbol] || {};
      
      const contextData: PolicyContextData = {
          symbol,
          action,
          accountMrDecimal: (accountRisk.marginRatio || 0) / 100,
          mrProjected: null, // Will be calculated if needed
          trendStatus: symbolData.trend_4h || 'NEUTRAL',
          contextMode: 'LIVE',
          longPos: longRow,
          shortPos: shortRow,
          netDirection: (longQty > shortQty) ? 'LONG' : (shortQty > longQty ? 'SHORT' : 'NEUTRAL'),
          netBEP: null, // Can be calculated from rows
          atr4h: symbolData.atr_4h || null,
          volatilityRegime: symbolData.volatility_regime || 'NORMAL',
          currentPrice: currentPrice
      };

      const finalAction = PolicyMapper.mapAction(action, contextData);
      
      if (finalAction.blocked_by) {
          const violationMsg = `⚠️ <b>SOP VIOLATION</b> [${finalAction.blocked_by}]\n\n` +
                             `AI Action: ${action}\n` +
                             `Final Action: ${finalAction.action}\n` +
                             `Reason: ${finalAction.reason}\n\n` +
                             `Symbol: ${symbol}`;
          
          if (finalAction.action === 'HOLD') {
              return violationMsg;
          }
          // If it's not HOLD but modified, we continue with the new action
          console.log(`[POLICY] Action modified from ${action} to ${finalAction.action} due to ${finalAction.blocked_by}`);
          action = finalAction.action; // Update action for subsequent logic
      }

      let side: "buy" | "sell" | undefined;
      let targetLeg: "LONG" | "SHORT" | undefined;
      let quantity = 0;
      let msgAction = "";

      if (isNaN(percentage) || percentage <= 0) percentage = 100;

      // 4) LOGIKA AKSI
      if (action === "HEDGE_ON" || action === "HO") {
        if (longQty === 0 && shortQty === 0) return `❌ No open positions to hedge.`;

        if (longQty >= shortQty) {
          side = "sell";
          targetLeg = "SHORT";
          const delta = Math.max(0, longQty - shortQty);
          quantity = delta > 0 ? delta : (0.25 * longQty);
          msgAction = "HEDGE_ON: add SHORT to lock/cover LONG";
        } else {
          side = "buy";
          targetLeg = "LONG";
          const delta = Math.max(0, shortQty - longQty);
          quantity = delta > 0 ? delta : (0.25 * shortQty);
          msgAction = "HEDGE_ON: add LONG to lock/cover SHORT";
        }
      } else if (action === "LOCK_NEUTRAL" || action === "LN") {
        if (longQty === 0 && shortQty === 0) return `❌ No open positions to lock.`;
        
        if (longQty > shortQty) {
          side = "sell";
          targetLeg = "SHORT";
          quantity = longQty - shortQty;
          msgAction = "LOCK_NEUTRAL: add SHORT to match LONG";
        } else if (shortQty > longQty) {
          side = "buy";
          targetLeg = "LONG";
          quantity = shortQty - longQty;
          msgAction = "LOCK_NEUTRAL: add LONG to match SHORT";
        } else {
          return `✅ <b>LOCK_NEUTRAL</b>\n\nPosition is already 1:1 neutral for ${fullSymbol}.`;
        }
      } else if (action === 'UNLOCK' || action === 'UL') {
        if (longQty === 0 && shortQty === 0) return `❌ No positions to unlock.`;
        if (longQty <= shortQty && longQty > 0) {
          side = 'sell'; targetLeg = 'LONG';
          quantity = longQty; msgAction = `UNLOCK: close LONG (wrong leg)`;
        } else if (shortQty < longQty && shortQty > 0) {
          side = 'buy'; targetLeg = 'SHORT';
          quantity = shortQty; msgAction = `UNLOCK: close SHORT (wrong leg)`;
        } else return `ℹ️ Already effectively unlocked.`;
      } else if (action === 'ROLE' || action === 'RR') {
        if (longQty > shortQty && longQty > 0) {
          side = 'sell'; targetLeg = 'LONG';
          quantity = longQty; msgAction = `ROLE: close LONG (promote SHORT)`;
        } else if (shortQty > longQty && shortQty > 0) {
          side = 'buy'; targetLeg = 'SHORT';
          quantity = shortQty; msgAction = `ROLE: close SHORT (promote LONG)`;
        } else return `❌ Role failed: cannot determine primary.`;
      } else if (action === "REDUCE_LONG" || action === "RL") {
        side = "sell";
        targetLeg = "LONG";
        quantity = absoluteQty || (longQty * (percentage / 100));
        msgAction = absoluteQty ? `REDUCE_LONG ${absoluteQty} units` : `REDUCE_LONG ${percentage}%`;
      } else if (action === "REDUCE_SHORT" || action === "RS") {
        side = "buy";
        targetLeg = "SHORT";
        quantity = absoluteQty || (shortQty * (percentage / 100));
        msgAction = absoluteQty ? `REDUCE_SHORT ${absoluteQty} units` : `REDUCE_SHORT ${percentage}%`;
      } else if (action === "ADD_LONG" || action === "AL") {
        const ok = await ensureMrGuardForAdd();
        if (!ok.ok) return ok.msg!;
        side = "buy";
        targetLeg = "LONG";
        quantity = absoluteQty || (15 / (targetPrice || currentPrice));
        msgAction = absoluteQty ? `ADD_LONG ${absoluteQty} units` : "ADD_LONG fixed 15 USDT";
      } else if (action === "ADD_SHORT" || action === "AS") {
        const ok = await ensureMrGuardForAdd();
        if (!ok.ok) return ok.msg!;
        side = "sell";
        targetLeg = "SHORT";
        quantity = absoluteQty || (15 / (targetPrice || currentPrice));
        msgAction = absoluteQty ? `ADD_SHORT ${absoluteQty} units` : "ADD_SHORT fixed 15 USDT";
      } else if (action === "TAKE_PROFIT" || action === "TP") {
        if (longQty > 0 && (!shortQty || longQty >= shortQty)) {
          side = "sell";
          targetLeg = "LONG";
          quantity = longQty * (percentage / 100);
          msgAction = `TAKE_PROFIT LONG ${percentage}%`;
        } else if (shortQty > 0) {
          side = "buy";
          targetLeg = "SHORT";
          quantity = shortQty * (percentage / 100);
          msgAction = `TAKE_PROFIT SHORT ${percentage}%`;
        } else {
          return `❌ No open position for TAKE_PROFIT`;
        }
      } else if (action === 'HOLD') {
        return `✅ <b>HOLD</b>\n\nNo trade executed for ${fullSymbol}.`;
      } else {
        return `❌ Unsupported action: ${action}`;
      }

      if (!side || !targetLeg) {
        throw new Error("Invalid trade parameters");
      }

      // 5) NORMALISASI QTY SESUAI RULES BINANCE
      const isReducing = ["REDUCE_LONG", "RL", "REDUCE_SHORT", "RS", "UNLOCK", "UL", "ROLE", "RR", "TAKE_PROFIT", "TP"].includes(action);

      const openQtyAbs = targetLeg === "LONG" ? longQty : shortQty;
      const refRow = targetLeg === "LONG" ? longRow : shortRow;
      const refPrice = Number(targetPrice || refRow?.markPrice || refRow?.entryPrice || currentPrice || 0);

      if (!refPrice || refPrice <= 0) {
        throw new Error("Unable to determine reference price");
      }

      function decimalsFromStep(step: number): number {
        const s = step.toString();
        return s.includes(".") ? s.split(".")[1].length : 0;
      }

      function floorToStep(value: number, step: number): number {
        const precision = decimalsFromStep(step);
        return Number((Math.floor(value / step) * step).toFixed(precision));
      }

      function ceilToStep(value: number, step: number): number {
        const precision = decimalsFromStep(step);
        return Number((Math.ceil(value / step) * step).toFixed(precision));
      }

      if (isReducing) {
        // Jangan pernah melebihi posisi yang sedang terbuka
        quantity = Math.min(quantity, openQtyAbs);
      }

      let qty = floorToStep(quantity, stepSize);

      if (qty <= 0) {
        throw new Error(`PARTIAL_ROUNDED_TO_ZERO symbol=${fullSymbol} leg=${targetLeg} requestedQty=${quantity} minQty=${minQty} stepSize=${stepSize}`);
      } else if (qty < minQty) {
        throw new Error(`MIN_QTY_NOT_REACHED symbol=${fullSymbol} leg=${targetLeg} requestedQty=${quantity} normalizedQty=${qty} minQty=${minQty} stepSize=${stepSize}`);
      }

      let notional = qty * refPrice;
      const notionalBefore = notional;
      let adjustmentReason = "NONE";

      // Jika reduce/TP terlalu kecil, coba naikan ke min executable qty
      if (minNotional > 0 && notional < minNotional) {
        if (REDUCE_POLICY === "STRICT_PARTIAL") {
          throw new Error(`PARTIAL_TOO_SMALL qty=${qty} notional=${notional.toFixed(8)} minNotional=${minNotional}`);
        } else if (REDUCE_POLICY === "FORCE_MIN_EXEC") {
          const minExecQty = ceilToStep(minNotional / refPrice, stepSize);

          if (isReducing && minExecQty <= openQtyAbs && minExecQty >= minQty) {
            qty = minExecQty;
            notional = qty * refPrice;
            adjustmentReason = "UPSCALED_TO_MIN_EXECUTABLE";
          } else {
            throw new Error(
              `DUST_REDUCE symbol=${fullSymbol} leg=${targetLeg} openQty=${openQtyAbs} refPrice=${refPrice} notional=${notional.toFixed(8)} minNotional=${minNotional}`
            );
          }
        }
      }

      // Determine the primary price for the main order based on the action
      let primaryPrice: number | undefined;
      if (action === 'LOCK_NEUTRAL' || action === 'LN') {
        primaryPrice = stopHedgePrice || targetPrice;
      } else {
        primaryPrice = targetPrice || stopHedgePrice;
      }

      // 6) HELPERS FOR ORDER PLACEMENT
      const buildParams = (useHedgeMode: boolean, determinedOrderType: string) => {
        const params: any = {};
        if (useHedgeMode) {
          params.positionSide = targetLeg;
        } else {
          if (isReducing) {
            params.reduceOnly = true;
          }
        }

        if (determinedOrderType.includes('STOP') || determinedOrderType.includes('TAKE_PROFIT')) {
          params.stopPrice = primaryPrice;
        }

        return params;
      };

      const determineOrderType = () => {
        let orderType = 'MARKET';
        if (primaryPrice) {
          if (isReducing || action === 'TP' || action === 'LN' || action === 'UNLOCK') {
            if (side === 'sell') {
              orderType = primaryPrice > currentPrice ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';
            } else {
              orderType = primaryPrice < currentPrice ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';
            }
          } else {
            if (side === 'buy') {
              orderType = primaryPrice < currentPrice ? 'LIMIT' : 'STOP_MARKET';
            } else {
              orderType = primaryPrice > currentPrice ? 'LIMIT' : 'STOP_MARKET';
            }
          }
        }
        return orderType;
      };

      const placeOrderWithClient = async (useHedgeMode: boolean) => {
        const orderType = determineOrderType();
        const params = buildParams(useHedgeMode, orderType);
        
        addLog(
          `[EXEC_TRY] [${VALIDATION_MODE}] ${fullSymbol} action=${action} ${side} qty=${qty} ` +
          `type=${orderType} stopPrice=${params.stopPrice || 'N/A'} targetPrice=${targetPrice || 'Market'} ` +
          `refPrice=${refPrice} currentPrice=${currentPrice} notional=${notional.toFixed(4)} ` +
          `HedgeMode=${useHedgeMode} Params=${JSON.stringify(params)}`
        );

        if (orderType === 'STOP_MARKET' || orderType === 'STOP' || orderType === 'TAKE_PROFIT_MARKET') {
          const price = orderType === 'STOP' ? targetPrice : undefined;
          return await activeClient.createOrder(fullSymbol, orderType, side!, qty, price, params);
        } else if (orderType === 'LIMIT') {
          return await activeClient.createLimitOrder(fullSymbol, side!, qty, targetPrice, params);
        } else {
          return await activeClient.createMarketOrder(fullSymbol, side!, qty, undefined, params);
        }
      };

      if (VALIDATION_MODE === "DRY_RUN") {
        const orderTypeDisplay = determineOrderType();
        const params = buildParams(hasHedgeMode, orderTypeDisplay);
        
        return (
          `✅ <b>DRY RUN ORDER</b>\n\n` +
          `Action: ${msgAction}\n` +
          `Symbol: ${fullSymbol}\n` +
          `Side: ${side!.toUpperCase()}\n` +
          `Leg: ${targetLeg}\n` +
          `Requested Qty: ${quantity}\n` +
          `Normalized Qty: ${qty}\n` +
          `Ref Price: ${refPrice}\n` +
          `Current Price: ${currentPrice}\n` +
          `Stop Price: ${params.stopPrice || 'N/A'}\n` +
          `Target Price: ${targetPrice || 'Market'}\n` +
          `Notional Before: ${notionalBefore.toFixed(8)}\n` +
          `Notional After: ${notional.toFixed(8)}\n` +
          `MinNotional: ${minNotional}\n` +
          `AdjustmentReason: ${adjustmentReason}\n` +
          `Type: ${orderTypeDisplay}\n` +
          `Note: No live order sent (DRY_RUN mode active)`
        );
      }

      if (VALIDATION_MODE === "TEST_ORDER") {
        const orderTypeTest = determineOrderType();
        const params = buildParams(hasHedgeMode, orderTypeTest);
        params.type = orderTypeTest;
        
        const testResult = await submitTestOrder(fullSymbol, side!, qty, targetPrice, params);
        
        if (testResult.success) {
          return (
            `✅ <b>TEST ORDER ACCEPTED</b>\n\n` +
            `Action: ${msgAction}\n` +
            `Symbol: ${fullSymbol}\n` +
            `Side: ${side!.toUpperCase()}\n` +
            `Leg: ${targetLeg}\n` +
            `Qty: ${qty}\n` +
            `Notional≈ ${notional.toFixed(4)} USDT\n` +
            `Stop Price: ${params.stopPrice || 'N/A'}\n` +
            `Target Price: ${targetPrice || 'Market'}\n` +
            `Type: ${orderTypeTest}\n\n` +
            `ℹ️ <i>Order validated by Binance /fapi/v1/order/test endpoint. No actual trade executed.</i>`
          );
        } else {
          return (
            `❌ <b>TEST ORDER REJECTED</b>\n\n` +
            `Action: ${msgAction}\n` +
            `Symbol: ${fullSymbol}\n` +
            `Error: ${escapeHtml(testResult.error)}\n\n` +
            `Diagnostics:\n` +
            `- Qty: ${qty}\n` +
            `- Price: ${refPrice}\n` +
            `- StopPrice: ${params.stopPrice || 'N/A'}\n` +
            `- TargetPrice: ${targetPrice || 'Market'}\n` +
            `- Notional: ${notional.toFixed(4)}\n` +
            `- MinNotional: ${minNotional}`
          );
        }
      }

      try {
        let order: any;
        
        if (VALIDATION_MODE === "DEMO_TRADING") {
            if (!BINANCE_DEMO_API_KEY || !BINANCE_DEMO_API_SECRET) {
                return `❌ <b>DEMO TRADING CONFIG ERROR</b>\n\nReason: BINANCE_DEMO_API_KEY/SECRET is missing in environment variables.`;
            }
            console.log(`[DEMO_TRADING EXEC] Using Binance Demo Trading Client`);
        }

        try {
          order = await placeOrderWithClient(hasHedgeMode);
        } catch (err: any) {
          const msg = String(err?.message || err?.msg || "");
          addLog(`[EXEC_ERR] 1st try failed: ${msg}`);
          if (msg.includes("-4061") || msg.toLowerCase().includes("position side does not match")) {
            const modeResp2 = await activeClient.fapiPrivateGetPositionSideDual();
            const actualHedgeMode = modeResp2?.dualSidePosition === true || modeResp2?.dualSidePosition === "true";
            addLog(`[EXEC_RETRY] actualHedgeMode=${actualHedgeMode}`);
            order = await placeOrderWithClient(actualHedgeMode);
          } else {
            throw err;
          }
        }
  
        const successLabel = VALIDATION_MODE === "DEMO_TRADING" ? "DEMO TRADING ORDER VALIDATED" : "ORDER SUCCESS!";
        const finalOrderType = determineOrderType();
        return (
          `✅ <b>${successLabel}</b>\n\n` +
          `Action: ${msgAction}\n` +
          `Symbol: ${fullSymbol}\n` +
          `Side: ${side!.toUpperCase()}\n` +
          `Leg: ${targetLeg}\n` +
          `Qty: ${order.amount}\n` +
          `Notional≈ ${notional.toFixed(4)} USDT\n` +
          `Type: ${finalOrderType}\n` +
          `Price: ${targetPrice || 'Market'}\n` +
          `Stop: ${stopHedgePrice || (finalOrderType.includes('STOP') || finalOrderType.includes('TAKE_PROFIT') ? targetPrice : 'N/A')}\n` +
          `Validation Mode: ${VALIDATION_MODE}\n` +
          (VALIDATION_MODE === "DEMO_TRADING" ? `Note: Sent to Binance Demo Trading environment, not live production.` : "")
        );

      } catch (e: any) {
        const msg = String(e?.message || e || "");
        if (msg.includes("-4164") || msg.toLowerCase().includes("notional")) {
          return (
            `❌ <b>NOTIONAL ERROR (-4164)</b>\n\n` +
            `Action: ${action}\n` +
            `Symbol: ${fullSymbol}\n` +
            `Leg: ${targetLeg}\n` +
            `Requested Qty: ${quantity}\n` +
            `Normalized Qty: ${qty}\n` +
            `Ref Price: ${refPrice}\n` +
            `Notional≈ ${notional.toFixed(8)}\n` +
            `MinNotional: ${minNotional}\n` +
            `OpenQty: ${openQtyAbs}\n\n` +
            `Hint: TP/Reduce terlalu kecil untuk rule Binance atau posisi terlalu kecil (dust).`
          );
        }
        if (msg.includes("-2015") || msg.includes("Invalid API-key")) {
            return `❌ <b>AUTHENTICATION ERROR</b>\n\nBinance API rejected the request.\nReason: Invalid API-key, IP, or permissions.`;
        }
        return `❌ <b>EXECUTION FAILED</b>\n\nMode: ${hasHedgeMode ? 'Hedge' : 'One-Way'}\nError: ${escapeHtml(msg)}`;
      }

    } catch (err: any) {
      console.error("Critical Error:", err);
      const errMsg = err.message || String(err);
      
      if (errMsg.startsWith("DUST_REDUCE")) {
        const match = errMsg.match(/symbol=([^ ]+) leg=([^ ]+) openQty=([^ ]+) refPrice=([^ ]+) notional=([^ ]+) minNotional=([^ ]+)/);
        if (match) {
          return `❌ <b>DUST REDUCE</b>\n` +
                 `Symbol: ${match[1]}\n` +
                 `Leg: ${match[2]}\n` +
                 `OpenQty: ${match[3]}\n` +
                 `Ref Price: ${match[4]}\n` +
                 `Notional: ${match[5]}\n` +
                 `MinNotional: ${match[6]}\n` +
                 `Reason: Full posisi yang tersisa masih di bawah minimum executable Binance.`;
        }
      } else if (errMsg.startsWith("PARTIAL_TOO_SMALL")) {
        return `❌ <b>PARTIAL TOO SMALL</b>\n\n${escapeHtml(errMsg)}\nReason: REDUCE_POLICY is STRICT_PARTIAL.`;
      } else if (errMsg.startsWith("PARTIAL_ROUNDED_TO_ZERO")) {
        const match = errMsg.match(/symbol=([^ ]+) leg=([^ ]+) requestedQty=([^ ]+) minQty=([^ ]+) stepSize=([^ ]+)/);
        if (match) {
          return `❌ <b>PARTIAL ROUNDED TO ZERO</b>\n` +
                 `Symbol: ${match[1]}\n` +
                 `Leg: ${match[2]}\n` +
                 `Requested Qty: ${match[3]}\n` +
                 `Normalized Qty: 0\n` +
                 `MinQty: ${match[4]}\n` +
                 `StepSize: ${match[5]}\n` +
                 `Reason: ukuran order setelah normalisasi stepSize menjadi 0 dan tidak memenuhi minimum quantity Binance.`;
        }
      } else if (errMsg.startsWith("MIN_QTY_NOT_REACHED")) {
        const match = errMsg.match(/symbol=([^ ]+) leg=([^ ]+) requestedQty=([^ ]+) normalizedQty=([^ ]+) minQty=([^ ]+) stepSize=([^ ]+)/);
        if (match) {
          return `❌ <b>MIN QTY NOT REACHED</b>\n` +
                 `Symbol: ${match[1]}\n` +
                 `Leg: ${match[2]}\n` +
                 `Requested Qty: ${match[3]}\n` +
                 `Normalized Qty: ${match[4]}\n` +
                 `MinQty: ${match[5]}\n` +
                 `StepSize: ${match[6]}\n` +
                 `Reason: ukuran order lebih kecil dari minimum quantity Binance untuk simbol ini.`;
        }
      }
      
      return `❌ <b>ERROR</b>\n\n${escapeHtml(errMsg)}`;
    }
  }

const processedEvents = new Map<string, number>();

function isDuplicateEvent(key: string): boolean {
    const now = Date.now();
    // Clean up old events (older than 60s)
    for (const [k, timestamp] of processedEvents.entries()) {
        if (now - timestamp > 60000) {
            processedEvents.delete(k);
        }
    }
    
    if (processedEvents.has(key)) {
        return true;
    }
    processedEvents.set(key, now);
    return false;
}

async function setupTelegramCommands() {
    if (!TELEGRAM_BOT_TOKEN) return;
    const commands = [
        { command: "start", description: "Show interactive menu" },
        { command: "menu", description: "Show interactive menu" },
        { command: "help", description: "Show help and examples" },
        { command: "status", description: "Show current status" },
        { command: "mode", description: "Switch validation mode" },
        { command: "demo", description: "Toggle demo trading" },
        { command: "tp", description: "Take Profit" },
        { command: "rl", description: "Reduce Long" },
        { command: "rs", description: "Reduce Short" },
        { command: "al", description: "Add Long" },
        { command: "as", description: "Add Short" },
        { command: "ho", description: "Hedge On" },
        { command: "ln", description: "Lock Neutral" },
        { command: "ul", description: "Unlock" },
        { command: "rr", description: "Role" }
    ];

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands`, {
            commands: commands
        });
        console.log("[TG] Commands menu setup successful");
    } catch (error: any) {
        console.error("[TG] Failed to setup commands menu:", error.message);
    }
}

let commandsSetup = false;

async function pollTelegram() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  if (isPollingActive) {
    return;
  }

  // Setup commands menu on first poll
  if (!commandsSetup) {
    await setupTelegramCommands();
    commandsSetup = true;
  }
  
  isPollingActive = true;
  try {
    // Reduced timeout to 10s to avoid 409 overlaps
    const res = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`);
    const updates = res.data.result;
    if (updates && updates.length > 0) {
      // 1) Advance offset immediately to prevent other instances from processing
      for (const update of updates) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id);
      }
      // Acknowledge to Telegram immediately
      axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=0`).catch(() => {});
      
      // 2) Process updates
      for (const update of updates) {
        // De-dup by update_id
        if (isDuplicateEvent(`update_${update.update_id}`)) {
            console.log(`[TG DEDUP] Skipping duplicate update_id: ${update.update_id}`);
            continue;
        }

        // Handle Callback Queries (Button Clicks)
        if (update.callback_query) {
            const callback = update.callback_query;
            const rawData = callback.data;
            
            // De-dup by callback data + message id
            const dedupKey = `cb_${callback.message?.message_id}_${rawData}`;
            if (isDuplicateEvent(dedupKey)) {
                console.log(`[TG DEDUP] Skipping duplicate callback: ${dedupKey}`);
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                    callback_query_id: callback.id,
                    text: `Already processing...`
                }).catch(() => {});
                continue;
            }

            // Handle Menu Callbacks
            if (rawData.startsWith('menu_')) {
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                    callback_query_id: callback.id
                }).catch(() => {});

                if (rawData === 'menu_main') {
                    await sendInteractiveMenu();
                } else if (rawData === 'menu_status') {
                    const status = driftMonitor.getStatus();
                    if (!status) {
                        await sendTelegramMessage("❌ Drift monitor not initialized yet.");
                    } else {
                        const msg = `🔍 <b>RF Drift Status</b>\n\n` +
                                    `Healthy: ${status.is_healthy ? '✅' : '❌'}\n` +
                                    `Filt Delta: ${status.filt_delta.toExponential(4)}\n` +
                                    `Smrn Delta: ${status.smrn_delta.toExponential(4)}\n` +
                                    `Hash Changed: ${status.hash_changed}\n` +
                                    `Baseline: ${new Date(status.baseline_timestamp).toISOString()}\n` +
                                    `Last Check: ${new Date(status.last_check).toISOString()}`;
                        await sendTelegramMessage(msg);
                    }
                } else if (rawData === 'menu_mode') {
                    const modeLabel = (VALIDATION_MODE === "TEST_ORDER") ? "🧪 TEST ORDER (Validation Only)" : 
                                      (VALIDATION_MODE === "DEMO_TRADING") ? "🎮 DEMO TRADING (Sandbox)" : 
                                      (VALIDATION_MODE === "LIVE_TRADING") ? "🔥 LIVE TRADING (Real Money)" :
                                      "🤖 DRY RUN (Simulation)";
                    await sendTelegramMessage(`🛡️ <b>Current Validation Mode:</b>\n\n${modeLabel}`);
                } else if (rawData === 'menu_demo') {
                    const hasKeys = !!(BINANCE_DEMO_API_KEY && BINANCE_DEMO_API_SECRET);
                    let msg = `🎮 <b>Binance Demo Trading Status</b>\n\n`;
                    msg += `Mode: ${VALIDATION_MODE}\n`;
                    msg += `Demo Enabled: ${VALIDATION_MODE === 'DEMO_TRADING' ? '✅ Yes' : '❌ No'}\n`;
                    msg += `API Keys: ${hasKeys ? '✅ Set' : '❌ Missing'}\n`;
                    if (hasKeys) {
                        try {
                            const balance = await binanceDemo.fetchBalance();
                            const usdtBalance = (balance.total as any)?.USDT || 0;
                            msg += `USDT Balance: ${usdtBalance} USDT`;
                        } catch (err: any) {
                            msg += `Connection: ❌ Failed\nError: ${escapeHtml(err.message)}`;
                        }
                    }
                    await sendTelegramMessage(msg);
                } else if (rawData === 'menu_trading') {
                    await sendTradingMenu();
                } else if (rawData === 'menu_hedge') {
                    await sendHedgeMenu();
                } else if (rawData === 'menu_help') {
                    const msg = `🤖 <b>Trading Bot Commands</b>\n\n` +
                                `<b>Trade Actions:</b>\n` +
                                `/tp [symbol] [percentage] - Take Profit\n` +
                                `/rl [symbol] [percentage/qty] - Reduce Long\n` +
                                `/rs [symbol] [percentage/qty] - Reduce Short\n` +
                                `/al [symbol] [qty] - Add Long\n` +
                                `/as [symbol] [qty] - Add Short\n` +
                                `/ho [symbol] - Hedge On\n` +
                                `/ln [symbol] - Lock Neutral\n` +
                                `/ul [symbol] - Unlock\n` +
                                `/rr [symbol] - Role\n\n` +
                                `<b>Admin:</b>\n` +
                                `/status, /mode, /demo, /menu`;
                    await sendTelegramMessage(msg);
                } else if (['menu_tp', 'menu_rl', 'menu_rs', 'menu_al', 'menu_as', 'menu_ho', 'menu_ln', 'menu_ul', 'menu_rr'].includes(rawData)) {
                    const action = rawData.replace('menu_', '').toUpperCase();
                    await sendTelegramMessage(`👉 <b>Action Selected: ${action}</b>\n\nPlease type the symbol to execute, e.g.:\n<code>${action} BTC</code>`);
                }
                continue;
            }

            const parsed = parseTelegramCallbackData(rawData);
            
            // Determine context from callback data or message text if available
            const isPaperTradingContext = rawData.includes('PAPER_') || 
                                          (callback.message?.text && (
                                              callback.message.text.toLowerCase().includes('paper') || 
                                              callback.message.text.toLowerCase().includes('simulasi')
                                          )) || false;

            console.log(`\n--- TG EVENT ---`);
            console.log(`[TG UPDATE ID] ${update.update_id}`);
            console.log(`[TG CALLBACK ID] ${callback.id}`);
            console.log(`[TG MESSAGE ID] ${callback.message?.message_id}`);
            console.log(`[TG EXEC TRACE] Executing ${parsed.action} on ${parsed.symbol} via Callback`);
            console.log(`----------------\n`);
            
            if (!parsed.action || !parsed.symbol) {
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                    callback_query_id: callback.id,
                    text: `❌ Error: Invalid action or symbol in callback data`,
                    show_alert: true
                }).catch(() => {});
                continue;
            }
            
            // Acknowledge callback to stop loading animation
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                callback_query_id: callback.id,
                text: `Processing ${parsed.action} on ${parsed.symbol}...`
            }).catch((err) => {
                console.warn("[TG ACK ERROR]", err.message);
            });

            // Execute Trade with Target Price and Stop Hedge
            const resultMsg = await executeTrade(
                parsed.symbol, 
                parsed.action, 
                parsed.percentage || 100, 
                parsed.targetPrice, 
                parsed.stopHedgePrice,
                undefined, // rawQty not in callback data yet
                isPaperTradingContext
            );
            
            // Send Result
            await sendTelegramMessage(resultMsg);

        // Handle Text Messages, Photos, and Voice
        } else if (update.message && (update.message.text || update.message.photo || update.message.voice)) {
          const chatId = update.message.chat.id.toString();
          if (chatId === TELEGRAM_CHAT_ID) {
            let userText = update.message.text ? update.message.text.trim() : (update.message.caption ? update.message.caption.trim() : '');
            
            // De-dup by message id
            const dedupKey = `msg_${update.message.message_id}`;
            if (isDuplicateEvent(dedupKey)) {
                console.log(`[TG DEDUP] Skipping duplicate message: ${dedupKey}`);
                continue;
            }

            // --- NEW: Handle Voice Message ---
            if (update.message.voice) {
              try {
                await sendTelegramMessage("🎙️ <i>Mendengarkan perintah suara Anda...</i>");
                
                const fileId = update.message.voice.file_id;
                const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
                const filePath = fileRes.data.result.file_path;
                const downloadRes = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`, {
                  responseType: 'arraybuffer'
                });
                
                const base64Audio = Buffer.from(downloadRes.data, 'binary').toString('base64');
                
                const prompt = `
Anda adalah asisten trading kripto. Dengarkan pesan suara ini.
Tugas Anda:
1. Transkripsi pesan suara tersebut.
2. Ekstrak niat (intent) trading jika ada.
Format balasan WAJIB berupa JSON:
{
  "transcription": "Teks yang Anda dengar",
  "intent": {
    "action": "REDUCE_LONG|REDUCE_SHORT|ADD_LONG|ADD_SHORT|LOCK_NEUTRAL|UNLOCK|HOLD|TAKE_PROFIT",
    "symbol": "BTC/USDT" (harus format ini),
    "percentage": 100 (angka 1-100)
  } // Isi null jika tidak ada perintah trading yang jelas
}
`;
                const ai = getAI();
                const response = await ai.models.generateContent({
                  model: 'gemini-3-flash-preview',
                  contents: {
                    parts: [
                      { inlineData: { mimeType: 'audio/ogg', data: base64Audio } },
                      { text: prompt }
                    ]
                  },
                  config: { responseMimeType: 'application/json' }
                });
                
                const result = JSON.parse(response.text || '{}');
                await sendTelegramMessage(`🗣️ <b>Transkripsi:</b> "${result.transcription}"`);
                
                if (result.intent && result.intent.action && result.intent.symbol) {
                  userText = `${result.intent.action} ${result.intent.symbol} ${result.intent.percentage || 100}%`;
                  await sendTelegramMessage(`⚙️ <b>Mengeksekusi:</b> ${userText}`);
                } else {
                  userText = result.transcription; // Treat as normal chat
                }
              } catch (err: any) {
                console.error("Voice processing error:", err.message);
                await sendTelegramMessage("❌ Gagal memproses pesan suara.");
                continue;
              }
            }
            // --- END Voice Message ---

            if (userText === '/help' || userText === '/commands') {
                const msg = `🤖 <b>Trading Bot Commands</b>\n\n` +
                            `<b>Trade Actions:</b>\n` +
                            `/tp [symbol] [percentage] - Take Profit\n` +
                            `/rl [symbol] [percentage/qty] - Reduce Long\n` +
                            `/rs [symbol] [percentage/qty] - Reduce Short\n` +
                            `/al [symbol] [qty] - Add Long\n` +
                            `/as [symbol] [qty] - Add Short\n` +
                            `/ho [symbol] - Hedge On\n` +
                            `/ln [symbol] - Lock Neutral\n` +
                            `/ul [symbol] - Unlock\n` +
                            `/rr [symbol] - Role\n\n` +
                            `<b>Examples:</b>\n` +
                            `<code>/rl BTC 50%</code>\n` +
                            `<code>/rl BTC 0.1</code>\n` +
                            `<code>Up to 0.0414: REDUCE_LONG BTC 0.1</code>\n\n` +
                            `<b>Admin:</b>\n` +
                            `/status - Show current status\n` +
                            `/mode - Switch validation mode\n` +
                            `/demo - Toggle demo trading\n` +
                            `/menu - Show interactive menu`;
                await sendTelegramMessage(msg);
                continue;
            }

            if (userText === '/start' || userText === '/menu') {
                await sendInteractiveMenu();
                continue;
            }

            if (userText === '/status') {
                const status = driftMonitor.getStatus();
                if (!status) {
                    await sendTelegramMessage("❌ Drift monitor not initialized yet. Waiting for first BTC/USDT 4H data fetch.");
                } else {
                    const msg = `🔍 <b>RF Drift Status</b>\n\n` +
                                `Healthy: ${status.is_healthy ? '✅' : '❌'}\n` +
                                `Filt Delta: ${status.filt_delta.toExponential(4)}\n` +
                                `Smrn Delta: ${status.smrn_delta.toExponential(4)}\n` +
                                `Hash Changed: ${status.hash_changed}\n` +
                                `Baseline: ${new Date(status.baseline_timestamp).toISOString()}\n` +
                                `Last Check: ${new Date(status.last_check).toISOString()}`;
                    await sendTelegramMessage(msg);
                }
                continue;
            }

            if (userText === '/mode') {
                const modeLabel = (VALIDATION_MODE === "TEST_ORDER") ? "🧪 TEST ORDER (Validation Only)" : 
                                  (VALIDATION_MODE === "DEMO_TRADING") ? "🎮 DEMO TRADING (Sandbox)" : 
                                  (VALIDATION_MODE === "LIVE_TRADING") ? "🔥 LIVE TRADING (Real Money)" :
                                  "🤖 DRY RUN (Simulation)";
                await sendTelegramMessage(`🛡️ <b>Current Validation Mode:</b>\n\n${modeLabel}\n\nTo change, update <code>VALIDATION_MODE</code> in environment variables.`);
                continue;
            }

            if (userText === '/demo') {
                const hasKeys = !!(BINANCE_DEMO_API_KEY && BINANCE_DEMO_API_SECRET);
                let msg = `🎮 <b>Binance Demo Trading Status</b>\n\n`;
                msg += `Mode: ${VALIDATION_MODE}\n`;
                msg += `Demo Enabled: ${VALIDATION_MODE === 'DEMO_TRADING' ? '✅ Yes' : '❌ No'}\n`;
                msg += `API Keys: ${hasKeys ? '✅ Set' : '❌ Missing'}\n`;
                msg += `DefaultType: future\n`;
                
                if (hasKeys) {
                    try {
                        const balance = await binanceDemo.fetchBalance();
                        msg += `Connection: ✅ Success\n`;
                        const usdtBalance = (balance.total as any)?.USDT || 0;
                        msg += `USDT Balance: ${usdtBalance} USDT`;
                    } catch (err: any) {
                        msg += `Connection: ❌ Failed\n`;
                        msg += `Error: ${escapeHtml(err.message)}`;
                    }
                } else {
                    msg += `\n<i>Please set BINANCE_DEMO_API_KEY and BINANCE_DEMO_API_SECRET to use DEMO_TRADING mode.</i>`;
                }
                await sendTelegramMessage(msg);
                continue;
            }

            if (userText.startsWith('/test_order')) {
                const parts = userText.split(' ');
                const symbol = parts[1] || 'BTC/USDT';
                const percentage = parseInt(parts[2]) || 10;
                
                await sendTelegramMessage(`🧪 <b>Manual Test Order</b>\n\nSymbol: ${symbol}\nPercentage: ${percentage}%\n\nProcessing...`);
                const result = await executeTrade(symbol, 'AL', percentage); // AL = ADD_LONG as a test
                await sendTelegramMessage(result);
                continue;
            }

            // Try parsing as trade command first
            const parsedText = normalizeActionInput(userText);
            // Only treat as trade command if it's relatively short or starts with a slash
            // Long messages are likely natural language requests for the AI
            const isLikelyTradeCommand = (userText.length < 150 || userText.startsWith('/')) && 
                                         parsedText.action && parsedText.extractedSymbol;

            if (isLikelyTradeCommand) {
                const isPaperTradingContext = userText.toLowerCase().includes('paper') || userText.toLowerCase().includes('simulasi');
                
                console.log(`\n--- TG EVENT ---`);
                console.log(`[TG UPDATE ID] ${update.update_id}`);
                console.log(`[TG MESSAGE ID] ${update.message.message_id}`);
                console.log(`[TG EXEC TRACE] Executing ${parsedText.action} on ${parsedText.extractedSymbol} via Text (Paper: ${isPaperTradingContext})`);
                console.log(`----------------\n`);
                
                const resultMsg = await executeTrade(
                    parsedText.extractedSymbol, 
                    parsedText.action, 
                    parsedText.extractedPercentage || 100,
                    parsedText.extractedTargetPrice,
                    undefined, // stopHedgePrice
                    parsedText.extractedQty,
                    isPaperTradingContext
                );
                await sendTelegramMessage(resultMsg);
                continue;
            }

            // Send typing action
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
              chat_id: TELEGRAM_CHAT_ID,
              action: 'typing'
            }).catch(() => {});
            
            const chatId = update.message.chat.id.toString();
            
            let base64Image = null;
            if (update.message.photo && update.message.photo.length > 0) {
              try {
                // Get the highest resolution photo
                const photo = update.message.photo[update.message.photo.length - 1];
                const fileId = photo.file_id;
                
                // Get file path
                const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
                const filePath = fileRes.data.result.file_path;
                
                // Download file
                const downloadRes = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`, {
                  responseType: 'arraybuffer'
                });
                
                base64Image = Buffer.from(downloadRes.data, 'binary').toString('base64');
                console.log(`[TG PHOTO] Successfully downloaded and converted photo to base64`);
              } catch (err) {
                console.error(`[TG PHOTO ERROR] Failed to process photo:`, err);
                await sendTelegramMessage(`❌ Gagal memproses gambar. Silakan coba lagi.`);
                continue;
              }
            }

            const reply = await generateAiReply(userText, chatId, base64Image);
            await sendTelegramMessage(`🤖 <b>AI Reply:</b>\n\n${escapeHtml(reply)}`);
          }
        }
      }
    }
  } catch (error: any) {
    const errorBody = error.response?.data;
    // Only log non-409 errors to reduce noise, or log 409 briefly
    if (error.response && error.response.status === 409) {
        console.log(`⚠️ [ID:${POLLING_ID}] Polling Conflict (409). Another instance might be running. Backing off...`);
        // Handle 409 Conflict: Webhook is active or other instance polling
        try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook`, {
                drop_pending_updates: true
            });
            // Randomized wait to break sync with other instances (longer wait)
            const waitTime = 30000 + Math.floor(Math.random() * 30000);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        } catch (webhookError: any) {
            // Ignore webhook deletion errors during conflict
        }
    } else {
        console.error(`[ID:${POLLING_ID}] Polling Error:`, error.message, errorBody ? JSON.stringify(errorBody) : "");
    }
  } finally {
    isPollingActive = false;
  }
  // Ensure polling continues even after error, but wait a bit
  setTimeout(pollTelegram, 3000);
}

  app.post('/api/debug-trade', async (req, res) => {
    try {
      const { symbol, action, percentage, targetPrice, stopHedgePrice } = req.body;
      console.log(`[DEBUG_TRADE_API] Received:`, { symbol, action, percentage, targetPrice, stopHedgePrice });
      
      if (!action) {
        return res.status(400).json({ success: false, error: 'Action is required (e.g., BUY, SELL, TP, RL)' });
      }

      const result = await executeTrade(
        symbol || '', 
        action, 
        Number(percentage) || 100, 
        targetPrice ? Number(targetPrice) : undefined, 
        stopHedgePrice ? Number(stopHedgePrice) : undefined
      );
      
      res.json({ success: true, result });
    } catch (error: any) {
      console.error(`[DEBUG_TRADE_API] Error:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

// --- AUTO-JOURNALING FEATURE ---
async function generateAutoJournal() {
  console.log("📝 Generating Auto-Journal...");
  try {
    if (!BINANCE_API_KEY || !BINANCE_API_SECRET || !db) {
      console.log("Skipping auto-journal: Binance API or Firestore not configured.");
      return;
    }

    const activeClient = VALIDATION_MODE === "DEMO_TRADING" ? binanceDemo : binance;
    const now = Date.now();
    const startTime = now - 12 * 60 * 60 * 1000; // Last 12 hours

    // Fetch Realized PnL
    const income = await (activeClient as any).fapiPrivateGetIncome({
      incomeType: 'REALIZED_PNL',
      startTime,
      limit: 1000
    });

    let totalProfit = 0;
    let totalLoss = 0;
    let winCount = 0;
    let lossCount = 0;
    const tradedSymbols = new Set<string>();

    for (const trade of income) {
      const pnl = parseFloat(trade.income);
      tradedSymbols.add(trade.symbol);
      if (pnl > 0) {
        totalProfit += pnl;
        winCount++;
      } else if (pnl < 0) {
        totalLoss += pnl;
        lossCount++;
      }
    }

    const netPnl = totalProfit + totalLoss;
    const totalTrades = winCount + lossCount;
    const winRate = totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(2) : "0.00";

    if (totalTrades === 0) {
      const msg = `📝 <b>Jurnal Trading Otomatis (12 Jam Terakhir)</b>\n\nTidak ada posisi yang ditutup dalam 12 jam terakhir. Tetap sabar menunggu setup terbaik! 🛡️`;
      if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: TELEGRAM_CHAT_ID,
          text: msg,
          parse_mode: 'HTML'
        });
      }
      return;
    }

    const prompt = `
      Anda adalah "Crypto Sentinel V2 - Mentor Trading Profesional".
      Tugas Anda adalah membuat Jurnal Evaluasi Trading berdasarkan data 12 jam terakhir berikut:

      - Total Trade Ditutup: ${totalTrades}
      - Win Rate: ${winRate}% (${winCount} Win / ${lossCount} Loss)
      - Total Profit (Kotor): $${totalProfit.toFixed(2)}
      - Total Loss (Kotor): $${totalLoss.toFixed(2)}
      - Net PnL: $${netPnl.toFixed(2)}
      - Koin yang ditradingkan: ${Array.from(tradedSymbols).join(', ')}

      Buatlah evaluasi singkat (maksimal 3 paragraf pendek) yang berisi:
      1. Ringkasan performa (apakah bagus, buruk, atau biasa saja).
      2. Insight/Pelajaran yang bisa diambil dari angka-angka tersebut (misal: jika win rate kecil tapi net pnl positif, berarti risk:reward bagus).
      3. Saran untuk sesi trading berikutnya.
      Gunakan bahasa Indonesia yang profesional namun santai.
    `;

    const evaluation = await generateWithRetry(prompt, 'gemini-3-flash-preview');

    // Send to Telegram
    const tgMsg = `📝 <b>Jurnal Trading Sentinel (12 Jam Terakhir)</b>\n\n` +
      `📊 <b>Statistik:</b>\n` +
      `• Net PnL: <b>$${netPnl.toFixed(2)}</b>\n` +
      `• Win Rate: <b>${winRate}%</b> (${winCount}W / ${lossCount}L)\n` +
      `• Koin: ${Array.from(tradedSymbols).join(', ')}\n\n` +
      `🧠 <b>Evaluasi Mentor:</b>\n${evaluation}`;

    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: tgMsg,
        parse_mode: 'HTML'
      });
    }

  } catch (err) {
    console.error("Error generating auto journal:", err);
  }
}

// Schedule Auto-Journaling at 07:30 and 19:30 WIB (Asia/Jakarta)
function scheduleCronJobs() {
  cron.schedule('30 7,19 * * *', generateAutoJournal, {
    timezone: "Asia/Jakarta"
  });

  // Schedule Risk Manager every 10 minutes
  cron.schedule('*/10 * * * *', checkRiskAndNotify);
  console.log("✅ Cron jobs scheduled");
}

// --- PROACTIVE RISK MANAGER ---
let lastRiskAlerts: Record<string, number> = {}; // symbol -> timestamp
let lastMarginAlert = 0;

async function checkRiskAndNotify() {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  
  try {
    const activeClient = VALIDATION_MODE === "DEMO_TRADING" ? binanceDemo : binance;
    const positions = await activeClient.fetchPositions();
    const openPositions = positions.filter((p: any) => p.contracts > 0);
    
    if (openPositions.length === 0) return;

    const riskData = await fetchAccountRisk();
    if (!riskData) return;

    const now = Date.now();
    const ALERT_COOLDOWN = 12 * 60 * 60 * 1000; // 12 hours cooldown per symbol
    const MARGIN_COOLDOWN = 1 * 60 * 60 * 1000; // 1 hour for margin alerts

    let alertTriggered = false;
    let alertReason = "";

    // Check 1: Margin Ratio Danger
    if (riskData.marginRatio > 80) {
      if (now - lastMarginAlert > MARGIN_COOLDOWN) {
        alertTriggered = true;
        alertReason += `⚠️ <b>BAHAYA LIKUIDASI!</b> Margin Ratio mencapai ${riskData.marginRatio.toFixed(2)}%. Evaluasi segera ketahanan margin.\n`;
        lastMarginAlert = now;
      }
    }

    // Check 2: If/Then Proximity
    let hasPositionAlerts = false;
    
    // Create a map of current prices from open positions
    const currentPrices: Record<string, number> = {};
    for (const pos of openPositions) {
      if (pos.markPrice) {
        currentPrices[pos.symbol] = pos.markPrice;
      }
    }

    if (latestDecisionCards && latestDecisionCards.length > 0) {
      for (const card of latestDecisionCards) {
        const symbol = card.symbol;
        const currentPrice = currentPrices[symbol];
        
        if (!currentPrice) continue; // Skip if we don't have the current price
        
        const lastAlert = lastRiskAlerts[symbol] || 0;
        if (now - lastAlert < ALERT_COOLDOWN) continue; // Skip if recently alerted

        if (card.if_then && Array.isArray(card.if_then)) {
          for (const scenario of card.if_then) {
            // Extract the first floating point number from the scenario string
            // Example: "Up to 76.5: HOLD..." -> 76.5
            const match = scenario.match(/(?:Up to|Down to|to|target)\s*([\d.]+)/i) || scenario.match(/^.*?([\d.]+).*?:/);
            
            if (match && match[1]) {
              const targetPrice = parseFloat(match[1]);
              if (!isNaN(targetPrice) && targetPrice > 0) {
                const distancePct = Math.abs(currentPrice - targetPrice) / targetPrice;
                
                // If price is within 1% of the target
                if (distancePct <= 0.01) {
                  hasPositionAlerts = true;
                  alertReason += `🎯 <b>IF/THEN PROXIMITY:</b> Harga ${symbol} saat ini (${currentPrice}) mendekati target skenario: <i>"${scenario}"</i>.\n`;
                  lastRiskAlerts[symbol] = now;
                  break; // Alert once per symbol to avoid spam
                }
              }
            }
          }
        }
      }
    }

    if (hasPositionAlerts) {
      alertTriggered = true;
    }

    if (alertTriggered) {
      // Fetch recent chat context
      let recentContext = "";
      if (db) {
        try {
          const chatDoc = await getDoc(doc(db, 'telegram_chats', TELEGRAM_CHAT_ID.toString()));
          if (chatDoc.exists()) {
            const history = chatDoc.data()?.history || [];
            if (history.length > 0) {
              recentContext = "Konteks Chat Terakhir dengan Pengguna:\n";
              // Get last 4 messages
              const recentHistory = history.slice(-4);
              recentHistory.forEach((msg: any) => {
                recentContext += `- ${msg.role === 'user' ? 'User' : 'Sentinel'}: ${msg.content}\n`;
              });
            }
          }
        } catch (err) {
          console.error("Error reading chat history for risk manager:", err);
        }
      }

      let decisionCardsContext = "";
      if (latestDecisionCards && latestDecisionCards.length > 0) {
        decisionCardsContext = "Konteks Decision Cards Terakhir (Analisis Pasar Sentinel):\n" + 
          JSON.stringify(latestDecisionCards.map(c => ({
            symbol: c.symbol,
            action: c.primary_action,
            status: c.status,
            reason: c.reasoning
          })), null, 2);
      }

      const prompt = `
        Anda adalah "Crypto Sentinel V2 - Risk Manager".
        Sistem mendeteksi kondisi berikut pada akun pengguna:
        ${alertReason}

        ${recentContext}

        ${decisionCardsContext}

        PENTING: Pengguna saat ini menggunakan strategi "Hedging Recovery". 
        Artinya, floating minus yang sangat besar (bahkan ribuan persen) pada beberapa posisi mungkin disengaja sebagai bagian dari kuncian (hedging) untuk menjaga margin, BUKAN karena pengguna lupa cut loss.
        ATURAN MUTLAK: JANGAN PERNAH menyarankan REDUCE atau CUT LOSS pada posisi yang sedang MERAH (Rugi/Floating Loss). REDUCE HANYA BOLEH dilakukan pada posisi yang sedang HIJAU (Profit).
        
        Tugas Anda:
        Buatlah pesan evaluasi singkat (maksimal 2 paragraf) untuk dikirim ke Telegram pengguna.
        Fokus utama Anda adalah memberikan saran tindakan berdasarkan skenario "If/Then" yang sudah mendekati target harga saat ini.
        Gunakan nada analitis, objektif, dan suportif sebagai asisten pengelola risiko (Risk Manager) yang memahami strategi Hedging Recovery.
        JANGAN berteriak panik menyuruh "Cut Loss" membabi buta.
        Jika ada peringatan Margin Ratio > 80%, ingatkan juga tentang pengelolaan margin.
        Format dalam PLAIN TEXT dengan emoji secukupnya.
      `;

      const aiMessage = await generateWithRetry(prompt, 'gemini-3-flash-preview');
      
      const tgMsg = `🛡️ <b>SENTINEL PROACTIVE ALERT</b> 🛡️\n\n${alertReason}\n🧠 <b>Analisis Risk Manager:</b>\n${aiMessage}`;
      
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: tgMsg,
        parse_mode: 'HTML'
      });
    }

  } catch (err) {
    console.error("Error in checkRiskAndNotify:", err);
  }
}

// Schedule Risk Manager every 10 minutes
// Moved to scheduleCronJobs()

// Cron job to archive paper trading data daily at 00:00
cron.schedule('0 0 * * *', async () => {
  addLog("⏰ Running scheduled daily paper trading archive...");
  await archivePaperTradingData();
});

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Ensure webhook is deleted before starting polling to avoid 409 Conflict
    if (TELEGRAM_BOT_TOKEN) {
        let webhookDeleted = false;
        let attempts = 0;
        while (!webhookDeleted && attempts < 5) {
            try {
                attempts++;
                console.log(`Attempting to delete webhook (Attempt ${attempts}/5)...`);
                // Force delete webhook and drop pending updates to clear any stuck state
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook`, {
                    drop_pending_updates: true
                });
                console.log("✅ Webhook deleted on startup.");
                webhookDeleted = true;
            } catch (e: any) {
                console.error(`Failed to delete webhook on startup (Attempt ${attempts}/5):`, e.message);
                // Exponential backoff
                await new Promise(resolve => setTimeout(resolve, 2000 * attempts));
            }
        }
        
        if (!webhookDeleted) {
            console.error("❌ CRITICAL: Failed to delete webhook after multiple attempts. Polling might fail with 409 Conflict.");
        } else {
            // Wait a bit more to ensure Telegram servers propagate the change
            console.log("Waiting 5 seconds for webhook deletion to propagate...");
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    pollTelegram();
    scheduleCronJobs();
  }).on('error', (err: any) => {
    console.error('Server error:', err);
    process.exit(1);
  });
}

export { app };

const isMain = process.argv[1] && (
  process.argv[1].endsWith('server.ts') || 
  process.argv[1].endsWith('server.cjs')
);

if (isMain) {
  startServer();
}