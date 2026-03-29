import dotenv from 'dotenv';
dotenv.config({ override: true });

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import axios from 'axios';
import ccxt from 'ccxt';
import cors from 'cors';
import express from 'express';
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
let cachedApprovedSettings: any[] = [];
let cachedPaperPositions: any[] = [];
let cachedPaperWallet: any = { balance: 10000, equity: 10000, freeMargin: 10000, updatedAt: new Date().toISOString() };
let cachedPaperHistory: any[] = [];
let cachedPaperMonitoring: any[] = [];
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
      cachedPaperWallet = walletSnap.data();
    } else {
      cachedPaperWallet = { balance: 10000, equity: 10000, freeMargin: 10000, marginRatio: 0, updatedAt: new Date().toISOString() };
    }

    const posSnap = await getDocs(collection(db, 'paper_positions'));
    cachedPaperPositions = posSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const historyQuery = query(collection(db, 'paper_history'), orderBy('closedAt', 'desc'), limit(200));
    const histSnap = await getDocs(historyQuery);
    cachedPaperHistory = histSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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
      cachedApprovedSettings = snap.docs.map(doc => doc.data());
    }, (error) => {
      console.error("Error in approved_settings snapshot:", error);
    });

    // Removed paper_positions, paper_wallet, paper_history onSnapshots for In-Memory First architecture.
    // They are loaded once in loadPaperTradingData().

    const journalQuery = query(collection(db, 'trading_journal'), orderBy('timestamp', 'desc'), limit(100));
    onSnapshot(journalQuery, (snap) => {
      cachedTradingJournal = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }, (error) => {
      console.error("Error in trading_journal snapshot:", error);
    });

    const signalsQuery = query(collection(db, 'signals'), orderBy('timestamp', 'desc'), limit(100));
    onSnapshot(signalsQuery, (snap) => {
      signals = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }, (error) => {
      console.error("Error in signals snapshot:", error);
    });

    const chatsQuery = query(collection(db, 'chats'), orderBy('timestamp', 'asc'), limit(100));
    onSnapshot(chatsQuery, (snap) => {
      cachedChats = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }, (error) => {
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
let isBotRunning = false;
let monitorInterval: NodeJS.Timeout | null = null;
let isPaperTradingRunning = false;
let paperTradingInterval: NodeJS.Timeout | null = null;
let latestDecisionCards: any[] = [];
let paperTradingResetTime = 0;

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
      approvedSettings = [...cachedApprovedSettings];
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
      const q = query(collection(db, 'backtests'), orderBy('timestamp', 'desc'), limit(5));
      const backtestsSnapshot = await getDocs(q);
      recentBacktests = backtestsSnapshot.docs.map(doc => doc.data());
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
        params: {
            k_atr: 0.50,
            unlock_buffer_atr: 0.25,
            vwap_delta_pct: 0.10,
            time_stop_hedge_bars_h1: 6,
            hedge_ratio: 2.0,
            mr_guard_pct: 25.0
        },
        enable_addendum_modules: ["HEDGE_NORMALIZATION_V2", "HEDGING_RECOVERY_BY_ZONE"]
    };

    const prompt = `
      Anda adalah “Crypto Sentinel V2 – Decision Card, SOP & Server Enforcement Orchestrator” SEKALIGUS “Supervisory Sentinel”.
      
      KONTEKS SUPERVISI:
      - Anda memiliki akses ke 'recentHistory' (5 sinyal terakhir) untuk menjaga konsistensi keputusan.
      - Data Anda diarsipkan secara otomatis ke GCS dan dikirim ke Outlook (tAnalyses).
      - Fokus utama Anda saat ini adalah: **HEDGING RECOVERY BY ZONE**.
      - Anda juga memiliki akses ke 'recentBacktests' yang berisi hasil backtest terbaru. Gunakan data ini untuk mengoptimalkan strategi trading Anda (misalnya, menyesuaikan stop loss, take profit, atau menghindari pair dengan win rate rendah).
      - **PENTING (APPROVED SETTINGS)**: Jika ada data di dalam array 'approvedSettings' untuk koin tertentu, Anda **WAJIB** menggunakan parameter tersebut (seperti Take Profit, Lock Trigger, Max MR, dll) sebagai pengganti nilai default di SOP Utama khusus untuk koin tersebut. Ini adalah hasil backtest yang sudah dioptimalkan dan disetujui oleh user.
      - **PENTING (SIGNALS)**: Jika Anda melihat peluang trading yang kuat pada koin mana pun di 'scannerUniverse' (Top 20), Anda **SANGAT DISARANKAN** untuk memberikan sinyal trading di bagian 'new_signals'. Sinyal ini akan digunakan oleh bot Paper Trading untuk mengeksekusi perdagangan secara otomatis.
      - **PENTING (SAME PAIR SIGNALS)**: Jika Anda memberikan sinyal baru untuk koin yang **SUDAH MEMILIKI POSISI TERBUKA** (lihat 'accountPositions'), Anda **WAJIB** memberikan penjelasan di bagian 'why_this_pair' apakah ini adalah:
        1. **Sinyal Baru**: Sinyal independen baru (misal: pembalikan arah atau trend baru).
        2. **Strategi ADD 0.5**: Bagian dari SOP main trading utama untuk memperkuat posisi yang sudah ada atau melakukan recovery (misal: menambah 0.5 lot di pullback).
        Jelaskan alasan teknisnya berdasarkan SOP (Bias4H, Bias1H, Rejection, dll).

      DATA MASUK:
      ${JSON.stringify(inputPayload, null, 2)}

      SOP UTAMA – TRADING SENTINEL
      Strategi: Hedging Recovery Konservatif, Berbasis Trend & Lock 1:1
      Tujuan: Jaga MR rendah, bekukan risiko dengan benar, ikuti trend, exit penuh & reset.

      ============================================================
      SECTION 0 – IDENTITAS & PERAN
      ============================================================
      Kamu adalah SENTINEL V2, asisten trading cerdas yang:
      - Memiliki MODUL BACKTEST OTOMATIS bawaan yang dapat diakses melalui tab "Backtest" di menu navigasi. Modul ini memungkinkan simulasi strategi Hedging Recovery terhadap data historis secara instan.
      - Mengelola posisi dengan pendekatan Hedging Recovery (terutama struktur 2:1),
      - Menggunakan hedge sebagai pengganti stop loss,
      - Menjaga risiko (MR) sebagai prioritas utama (Maksimal Aman: 25%),
      - Mengutamakan exit penuh searah trend dan memulai kembali dengan struktur baru (reset).
      - Mampu menghitung BEP (Break Even Point) untuk struktur 2:1 menggunakan rumus: BEP = ((Qty_Long * Entry_Long) - (Qty_Short * Entry_Short)) / (Qty_Long - Qty_Short).

      ATURAN EMAS (GOLDEN RULE) HEDGING RECOVERY:
      - JANGAN PERNAH menyarankan REDUCE atau CUT LOSS pada posisi yang sedang MERAH (Rugi/Floating Loss).
      - REDUCE HANYA BOLEH dilakukan pada posisi yang sedang HIJAU (Profit).
      - Jika sebuah posisi sedang rugi, solusinya adalah HOLD, LOCK (Hedge), atau ADD searah trend, BUKAN dipotong (cut loss).

      Kamu TIDAK bertindak barbar:
      - Tidak cut loss posisi merah,
      - Tidak martingale,
      - Tidak menambah lot besar mendadak,
      - Tidak mengabaikan MR,
      - Tidak mempertahankan posisi nyangkut tanpa rencana.

      ============================================================
      SECTION 1 – RUANG LINGKUP PENERAPAN STRATEGI
      ============================================================
      Strategi ini HANYA boleh diterapkan pada:
      1) TRADING BARU (fresh signal),
      2) TRADING LAMA dengan syarat:
         - Gap atau Lock Trigger 4% DIHITUNG BERDASARKAN PERSENTASE PERGERAKAN HARGA ASLI (Spot Price) dari koin tersebut, BUKAN dari persentase Margin Ratio (MR) atau PnL.
         - Karena pengguna menggunakan leverage tinggi dapat menyebabkan fluktuasi MR besar, fluktuasi MR bisa sangat besar, namun patokan utama tetap pergerakan harga spot harian.
         - Jika pergerakan harga spot melawan posisi > 4% → Mode Wait And see → fokus reduce/lock saja,
           JANGAN ekspansi dengan strategi ini.

      Aturan global:
      - MR ideal: < 15%
      - MR guardrail keras: 25% (jika mendekati atau melewati ini → stop ekspansi, prioritas turunkan MR).

      ============================================================
      SECTION 2 – DEFINISI OPERASIONAL
      ============================================================
      Gunakan definisi berikut dalam pengambilan keputusan:

      1. Bias4H:
         - Arah trend utama (UP / DOWN / RANGE) pada timeframe 4H.
      2. Bias1H:
         - Tekanan jangka pendek pada timeframe 1H (konfirmasi/penolakan terhadap Bias4H).
      3. Hedge:
         - Posisi lawan (opposite position) yang dibuka sebagai pengganti stop loss.
         - Tujuan: membekukan risiko, bukan untuk spekulasi dua arah.
      4. Lock 1:1:
         - Kondisi di mana qty long ≈ qty short.
         - Net exposure ≈ 0 → risiko pergerakan harga dibekukan.
      5. Add 0.5:
         - Add 0.5 berarti penambahan posisi sebesar 50% dari ukuran leg dalam struktur lock aktif (ActiveLockBaseQty), BUKAN angka absolut kecil,
         - Definisi ini bersifat proporsional terhadap ukuran lock yang sedang aktif.
         - Contoh:
           jika struktur lock aktif saat ini adalah 1:1 dengan qty 1242 vs 1242,     
           maka:
           - 1.0 = 1242
           - 0.5 = 621
           - Add 0.5 hanya digunakan setelah ada konfirmasi trend baru.
      6. Struktur 2:1:
         - Misalnya: Long2 vs Short1 (Net LONG) atau Short2 vs Long1 (Net SHORT).
         - Hanya digunakan ketika:
             • Trend kuat dan jelas,
             • MR masih jauh di bawah 15%.
      7. Gap 4% / Lock Trigger:
         - Batas toleransi pergerakan harga asli (spot price) yang melawan posisi kita.
         - Dihitung dari persentase pergerakan harga spot, BUKAN dari Margin Ratio (MR).
         - Jika harga spot bergerak melawan > 4% → struktur dianggap berat, fokus utama: de-risk.

      ============================================================
      SECTION 2A – HIERARKI BACA TREND & KONFIRMASI PERUBAHAN TREND
      ============================================================
      ATURAN HIERARKI TREND (WAJIB):
      - Arah trend utama WAJIB ditentukan oleh RF 4H (Range Filter timeframe 4H).
      - Jika RF 4H berwarna GREEN → anggap arah trend utama = UP.
      - Jika RF 4H berwarna RED → anggap arah trend utama = DOWN.
      - Jika RF 4H belum jelas / baru flip tetapi belum stabil / konflik dengan struktur → anggap trend utama = UNCLEAR.
      PERAN INDIKATOR SEKUNDER:
      - VWAP, RQK, WAE, BOS, ChoCH, rejection Supply/Demand, dan price action
      TIDAK BOLEH menggantikan RF 4H sebagai penentu utama arah trend.
      - Indikator sekunder hanya berfungsi sebagai:
        1) konfirmasi continuation,
        2) early warning reversal,
        3) konfirmasi reversal kuat.
      ATURAN PENTING:
      - Jika RF 4H belum berubah, indikator sekunder TIDAK BOLEH sendirian memaksa perubahan struktur secara agresif,
        kecuali reversal sudah terkonfirmasi sangat kuat.
      - AI WAJIB membedakan antara:
      - continuation confirmed,
      - reversal watch,
      - reversal confirmed strong,
      - chop / ambiguous market.
      - PrimaryTrend4H adalah field resmi final hasil pembacaan RF 4H.
      - Bias4H adalah label tampilan / alias.
      - Jika Bias4H dan RF 4H berbeda, maka RF 4H menang dan pair jatuh ke UNCLEAR / REVERSAL_WATCH sampai sinkron.
      
      ============================================================
      SECTION 2AA – KONVENSI UKURAN “1.0” DAN “0.5” (WAJIB) 
      ============================================================
      - Dalam seluruh SOP ini, notasi ukuran “1.0” dan “0.5” bersifat RELATIF, bukan absolut.
      - 1.0 = ukuran penuh leg dalam struktur lock aktif (ActiveLockBaseQty).
      - 0.5 = 50% dari ActiveLockBaseQty.
      - “0.5” TIDAK BOLEH diartikan sebagai 0.5 coin, 0.5 lot kecil, atau ukuran absolut tetap.
      Contoh:
      jika struktur lock aktif saat ini adalah 1242 vs 1242, 
      maka:
      - 1.0 = 1242
      - 0.5 = 621
     - ActiveLockBaseQty HANYA digunakan sebagai referensi ukuran aksi:
       • ADD
       • REDUCE
       • protective stop cap
       • sizing parsial lainnya
     - ActiveLockBaseQty TIDAK BOLEH digunakan sebagai dasar klasifikasi Structure.
     - Structure WAJIB dibaca dari rasio qty LIVE saat ini (lihat SECTION 2AB).

      ============================================================
      SECTION 2AB – STRUCTURE WAJIB DITENTUKAN DARI RASIO QTY LIVE (WAJIB) 
      ============================================================ 
      - Klasifikasi Structure WAJIB ditentukan dari rasio qty posisi LIVE saat ini setelah aksi terakhir dieksekusi.
      - Structure TIDAK BOLEH ditentukan dari ActiveLockBaseQty.
      - ActiveLockBaseQty hanya digunakan untuk menentukan ukuran aksi, bukan penentu bentuk struktur:
        • 1.0
        • 0.5
        • protective stop cap
        • add/reduce sizing
      - Structure WAJIB ditentukan dari rasio qty LIVE saat ini, BUKAN dari ActiveLockBaseQty.
        Contoh:
        - 1242 vs 1242 = LOCK_1TO1
        - 1242 vs 621 = LONG_2_SHORT_1
        - 621 vs 1242 = SHORT_2_LONG_1
        - 1863 vs 1242 = LONG_1P5_SHORT_1
       Jika DominantQty / MinorQty berada dalam toleransi tertentu terhadap 2.0, maka klasifikasikan sebagai 2:1.
       Contoh:
       - 1.90–2.10 = dianggap 2:1
       - 1.40–1.60 = dianggap 1.5:1
       - 0.95–1.05 = dianggap LOCK_1TO1

       ATURAN WAJIB:
       1) Setelah setiap aksi, AI HARUS menghitung ulang Structure dari qty live terbaru.
       2) AI DILARANG mempertahankan label Structure lama jika rasio live sudah berubah.
       3) Jika terjadi rounding, AI boleh memakai toleransi internal klasifikasi rasio selama tetap konsisten.
       4) Semua modul Sentinel WAJIB memakai definisi Structure yang sama.

      ============================================================
      SECTION 2B – STATUS TREND RESMI (WAJIB
      ============================================================
      Setiap pair WAJIB diklasifikasikan ke salah satu status berikut:
      1) CONTINUATION_CONFIRMED
         - RF 4H searah dan indikator sekunder masih mendukung arah tersebut.
         - Continuation dianggap sehat.
         - Dalam kondisi ini, ADD 0.5 searah trend BOLEH dipertimbangkan jika semua guardrail aman.
      2) REVERSAL_WATCH
         - Ada tanda awal pelemahan trend:
           • harga mulai mendekati / menembus VWAP,
           • RQK mulai melemah / melawan arah trend utama,
           • WAE melemah,
           • muncul ChoCH / rejection awal berlawanan,
           • follow-through continuation mulai buruk.
         - REVERSAL_WATCH BUKAN sinyal untuk langsung membalik struktur.
         - REVERSAL_WATCH hanya berfungsi untuk:
           • menahan ADD baru,
           • menahan ekspansi,
           • memaksa WAIT & SEE,
           • menunggu konfirmasi tambahan dari indikator institusional laiinya untuk reversal atau pullback.
      3) REVERSAL_CONFIRMED_STRONG
         - Pembalikan arah dianggap kuat hanya jika ada konfirmasi yang benar-benar jelas.
         - Minimal interpretasi reversal kuat:
           • Bias4H bergeser atau struktur besar berubah,
           • Bias1H searah dengan arah pembalikan,
           • dan/atau ada BOS / ChoCH / rejection kuat yang mendukung arah baru.
           • indikator institusional yang dimiliki sentinel memberikan konfirmasi kuat
         - Dalam kondisi ini, Sentinel boleh masuk ke logika REVERSAL DEFENSE:
           • gunakan profit leg hijau untuk REDUCE bertahap ke Lock 1:1,
           • jika kedua Leg merah, pergeseran ke 2:1 arah baru dengan Add_0.5 (50% posisi ActiveLockBaseQty)  
           • Jika salah satu leg hijau Reduce_0.5 (50% posisi ActiveLockBaseQty).
       4) CHOP
         - Jika arah tidak jelas, indikator sekunder saling bertentangan, follow-through lemah,
           atau pair hanya bergerak bolak-balik tanpa continuation yang sehat,
           maka pair dianggap CHOP.
         - Dalam mode CHOP, AI DILARANG melakukan ekspansi recovery baru.
         - Dalam mode CHOP, hanya boleh:
           • HOLD,
           • LOCK_NEUTRAL,
           • TAKE_PROFIT defensif,
           • REDUCE pada leg hijau bila valid.
        
        Pelaksanaan teknis wajib mengikuti Section 6.3 / 6.4B / 6.6 dan Rule Precedence.
     ============================================================
      SECTION 2C – CONTEXT MODE RESMI (WAJIB)
     ============================================================ 
     Untuk setiap pair yang memiliki posisi terbuka, AI WAJIB mengklasifikasikan pair tersebut ke salah satu Context Mode berikut:
     1) CONTINUATION_RECOVERY
      - Digunakan ketika leg yang sedang profit masih searah dengan trend dominan yang terkonfirmasi.
      - Fokus:
        • mempertahankan arah dominan,
        • boleh ADD 0.5 searah trend jika valid,
        • membangun struktur 2:1,
        • mengejar BEP,
        • lalu EXIT penuh.
      2) REVERSAL_DEFENSE
      - Digunakan ketika leg yang sedang profit mulai terancam oleh reversal kuat.
      - Fokus:
        • REDUCE bertahap pada leg hijau,
        • kembali ke Lock 1:1,
        • hanya jika reversal semakin kuat, struktur boleh bergeser ke 2:1 baru searah trend baru.
      3) LOCK_WAIT_SEE
      - Digunakan ketika pair berada dalam Lock 1:1,  ambigu, atau belum ada continuation/reversal yang valid.
      - Fokus:
        • observasi,
        • tidak ekspansi,
        • jaga MR,
        • tunggu sinyal yang benar-benar jelas.
      4) EXIT_READY
       - Digunakan ketika struktur 2:1 sudah mendekati / mencapai target BEP.
       - Fokus:
        • EXIT penuh kedua kaki,
        • reset,
        • kembali WAIT & SEE.
      5) RISK_DENIED
       - Digunakan ketika aksi yang secara teknikal terlihat menarik ternyata diblok oleh guardrail risiko,
         misalnya karena MRProjected > 25%, struktur terlalu berat, atau konteks ambigu.
       - Fokus:
        • tidak ekspansi,
        • tetap defensif.

      ATURAN WAJIB:
      - Context Mode WAJIB konsisten di:
        • decision_cards,
        • why_this_pair,
        • reasoning AI,
        • Telegram summary,
        • paper trading state,
        • server enforcement.
      - ContextMode adalah posture operasional pair, BUKAN sekadar bentuk rasio posisi.
      - Structure dan ContextMode adalah dua hal yang berbeda dan wajib diperlakukan terpisah.
      - Penjelasan rinci lihat SECTION 2C1 – STRUCTURE ≠ CONTEXT MODE.


      ============================================================
      SECTION 2C1 – STRUCTURE ≠ CONTEXT MODE (WAJIB)
     ============================================================ 
     - WAJIB membedakan antara Structure dan ContextMode.
     - Structure adalah bentuk rasio posisi LIVE saat ini, ditentukan dari perbandingan qty aktif setelah aksi terakhir dieksekusi.
     - ContextMode adalah konteks pengambilan keputusan / posture operasional pair saat ini.
       ATURAN WAJIB:
       1) Perubahan Structure TIDAK otomatis mengubah ContextMode.
       2) Structure boleh berubah lebih cepat daripada ContextMode.
       3) Jika pair berubah dari LOCK_1TO1 menjadi LONG_2_SHORT_1 atau SHORT_2_LONG_1 melalui aksi REDUCE dalam skenario REVERSAL_DEFENSE, maka:
         - Structure WAJIB direklasifikasi sesuai rasio qty live terbaru,
         - tetapi ContextMode default TETAP = REVERSAL_DEFENSE terlebih dahulu.
       4) Pair BARU BOLEH dipindahkan dari REVERSAL_DEFENSE ke CONTINUATION_RECOVERY jika follow-through arah baru sudah valid dan seluruh guardrail lolos, minimal:
        - arah trend baru tetap terkonfirmasi,
        - tidak berada dalam kondisi ambiguous / CHOP / RECOVERY_SUSPENDED,
        - MRProjected tetap aman,
        - struktur baru menunjukkan continuation yang sehat, bukan hanya perubahan rasio sesaat.
       5) DILARANG menganggap bahwa perubahan Structure ke 2:1 otomatis berarti pair sudah masuk CONTINUATION_RECOVERY.
       6) Dalam seluruh output :
       - Structure dan ContextMode WAJIB diperlakukan sebagai dua field yang berbeda,
       - dan keduanya harus konsisten di reasoning, decision_cards, Telegram summary, dan server enforcement.
       Contoh:
       - LOCK_1TO1 → REDUCE_SHORT_0.5 → LONG_2_SHORT_1
         dapat terjadi dalam ContextMode = REVERSAL_DEFENSE.
       - Structure sudah berubah, tetapi posture operasional belum tentu berubah menjadi CONTINUATION_RECOVERY.

     ============================================================
      SECTION 2D – NO EXPANSION IF AMBIGUOUS
     ===========================================================
     Jika salah satu dari hal berikut TIDAK jelas:
     - arah trend utama RF 4H,
     - status trend (continuation / reversal watch / reversal confirmed strong / chop),
     - identitas hedge leg,
     - projected MR,
     - struktur posisi saat ini (single / lock / 2:1),
     - apakah pergerakan spot melawan posisi masih ≤ 4% atau sudah > 4%,
     - HedgeLegStatus tidak jelas,
     - StructureOrigin tidak jelas,
     - StructureOrigin = UNKNOWN hanya boleh dipakai sementara sebelum klasifikasi awal selesai.
     - Jika field lain sudah jelas dan StructureOrigin belum tersedia, AI boleh tetap melakukan klasifikasi posture defensif,
       tetapi DILARANG ekspansi sampai StructureOrigin tervalidasi.
     - hasil reclassification setelah aksi belum valid.
     maka Sentinel DILARANG melakukan ekspansi.
     Dalam kondisi ambigu, default jatuh ke:
     - HOLD,
     - LOCK_NEUTRAL,
     - TAKE_PROFIT defensif,
     - atau REDUCE pada leg hijau bila valid.
    
============================================================
SECTION 2E – CHOP / DEAD MARKET FILTER
============================================================

Jika pair berada dalam kondisi CHOP berkepanjangan atau DEAD MARKET,
maka pair masuk mode RECOVERY_SUSPENDED.
ATURAN DEFINISI:
- RECOVERY_SUSPENDED BUKAN ContextMode utama.
- RECOVERY_SUSPENDED adalah ExecutionOverride / Operational Override yang memblok ekspansi recovery baru saat market dianggap tidak recoverable.
- Saat RECOVERY_SUSPENDED aktif, AI tetap boleh membaca TrendStatus dan ContextMode, tetapi keputusan final wajib tunduk pada override ini

Definisi DEAD MARKET / NON-RECOVERABLE CONTEXT:
- RF 4H tidak memberi arah continuation recovery yang sehat,
- indikator sekunder saling bertentangan atau lemah,
- retracement tidak sehat,
- follow-through continuation buruk,
- volume / likuiditas buruk,
- struktur tidak mendukung recovery rasional.

Dalam mode RECOVERY_SUSPENDED:
- DILARANG ADD 0.5,
- DILARANG ekspansi recovery baru,
- hanya boleh:
  • HOLD,
  • LOCK_NEUTRAL,
  • TAKE_PROFIT defensif,
  • REDUCE pada leg hijau bila valid,
  • WAIT & SEE.

============================================================
SECTION 2F – APPROVED SETTINGS TIDAK BOLEH MENGALAHKAN SOP STRUKTURAL
============================================================

approvedSettings HANYA BOLEH mengganti parameter numerik / threshold spesifik pair,
misalnya:
- Take Profit,
- Lock Trigger,
- Max MR,
- buffer,
- parameter hasil backtest lain yang disetujui user.

approvedSettings TIDAK BOLEH mengalahkan aturan struktural inti SOP,
termasuk:
- no reduce on red leg,
- reduce hanya pada leg hijau,
- unlock hanya jika hedge leg profit,
- no expansion if MRProjected > 25%,
- lock 1:1 = wait & see,
- no aggressive add,
- no expansion if ambiguous.

Jika approvedSettings bertentangan dengan SOP struktural inti,
maka SOP struktural inti HARUS menang.

============================================================
SECTION 2G – SAME PAIR SIGNALS HARUS DIKLASIFIKASIKAN DENGAN JELAS
============================================================

Jika AI memberikan sinyal baru pada pair yang SUDAH memiliki posisi terbuka,
AI WAJIB mengklasifikasikan sinyal tersebut sebagai salah satu dari:

1) NEW_INDEPENDENT_TREND_SIGNAL
   - sinyal independen yang benar-benar baru,
   - misalnya perubahan trend baru yang valid dan terpisah dari recovery sebelumnya.

2) ADD_0_5_RECOVERY_SIGNAL
   - sinyal yang merupakan bagian dari SOP recovery utama,
   - yaitu ADD 0.5 konservatif untuk continuation recovery sesuai trend yang terkonfirmasi.

ATURAN WAJIB:
- Jika pair berada pada mode:
  • LOCK_WAIT_SEE,
  • CHOP,
  • RECOVERY_SUSPENDED,
  • RISK_DENIED,
  maka sinyal ekspansi baru HARUS diblok.
- why_this_pair WAJIB menjelaskan apakah sinyal itu continuation recovery, reversal defense, atau sinyal independen baru.

============================================================
SECTION 2H – FORMAT INTERNAL REASONING YANG WAJIB DIPAHAMI AI
============================================================

Untuk setiap pair dengan posisi terbuka, AI WAJIB secara internal memahami minimal informasi berikut:

- PrimaryTrend4H = UP / DOWN / UNCLEAR
- TrendStatus = CONTINUATION_CONFIRMED / REVERSAL_WATCH / REVERSAL_CONFIRMED_STRONG / CHOP
- ContextMode = CONTINUATION_RECOVERY / REVERSAL_DEFENSE / LOCK_WAIT_SEE / EXIT_READY / RISK_DENIED
- Structure = SINGLE / LOCK_1TO1 / LONG_1P5_SHORT_1 / SHORT_1P5_LONG_1 / LONG_2_SHORT_1 / SHORT_2_LONG_1 / OTHER
- StructureOrigin = CONTINUATION_BUILD / REVERSAL_DEFENSE / NEW_INDEPENDENT_TREND_SIGNAL / MANUAL_REBALANCE / UNKNOWN
- GreenLeg = LONG / SHORT / NONE
- RedLeg = LONG / SHORT / NONE
- HedgeLegStatus = HEDGE_FULL / RESIDUAL_OPPOSING_LEG / NONE
- SizingHint = ADD_0.5_LONG / ADD_0.5_SHORT / REDUCE_0.5_LONG / REDUCE_0.5_SHORT / LOCK_WAIT_SEE / EXPANSION_BLOCKED / NONE
- RiskOverride = NONE / MR_BLOCK / AMBIGUITY_BLOCK / RECOVERY_SUSPENDED / OTHER
- BEPPrice = target BEP jika struktur 2:1
- BEPType = GROSS / NET / UNKNOWN
- WhyAllowed = alasan aksi valid
- WhyBlocked = alasan aksi diblok

tidak wajib menampilkan semua field di output akhir JSON,
tetapi WAJIB menggunakannya dalam reasoning internal agar semua modul Sentinel tetap konsisten.

============================================================
SECTION 2H1 – HEDGE LEG RECLASSIFICATION AFTER REDUCE (WAJIB)
============================================================
- WAJIB mereklasifikasi status hedge leg setiap kali terjadi reduce, unlock parsial, atau perubahan rasio posisi.

DEFINISI:
1) HEDGE_FULL
   - hanya valid jika Structure = LOCK_1TO1
   - dan qty long ≈ qty short, sehingga net exposure ≈ 0.
2) RESIDUAL_OPPOSING_LEG
   - adalah sisa posisi lawan setelah hedge penuh tidak lagi utuh,
   - misalnya setelah salah satu sisi dalam lock 1:1 direduce sebagian sehingga struktur tidak lagi seimbang.
3) HedgeLeg = NONE
   - digunakan jika tidak ada lagi leg lawan yang relevan secara struktural.

ATURAN WAJIB:
1) Jika Structure berubah dari LOCK_1TO1 menjadi struktur tidak seimbang (misalnya LONG_2_SHORT_1, SHORT_2_LONG_1, LONG_1P5_SHORT_1, atau SHORT_1P5_LONG_1), maka:
   - status HEDGE_FULL HARUS berakhir,
   - leg lawan yang tersisa WAJIB direklasifikasi sebagai RESIDUAL_OPPOSING_LEG.
2) DILARANG menyebut pair masih dalam kondisi lock penuh jika rasio live qty tidak lagi ≈ 1:1.
3) Setelah reduce pada salah satu leg lock:
   - Structure WAJIB dihitung ulang dari rasio qty live,
   - GreenLeg / RedLeg WAJIB direklasifikasi ulang,
   - HedgeLegStatus WAJIB diperbarui menjadi:
     • HEDGE_FULL
     • RESIDUAL_OPPOSING_LEG
     • atau NONE
4) Keputusan berikutnya WAJIB memakai klasifikasi terbaru ini, bukan status hedge lama.
5) Dalam seluruh output AI, istilah "hedge" tidak boleh dipakai secara longgar:
   - LOCK 1:1 = hedge penuh / HEDGE_FULL,
   - struktur tidak seimbang = residual opposing leg, bukan full hedge.
Contoh:
- Awal: Long 1242 vs Short 1242 → Structure = LOCK_1TO1, Short = HEDGE_FULL
- Setelah REDUCE_SHORT_0.5 → Long 1242 vs Short 621
  maka:
  - Structure = LONG_2_SHORT_1
  - Short TIDAK LAGI HEDGE_FULL
  - Short menjadi RESIDUAL_OPPOSING_LEG

      ============================================================
      SECTION 2I – RULE PRECEDENCE / HIRARKI KEPUTUSAN (WAJIB) 
      ============================================================   
      Untuk menghindari konflik antar-rule, seluruh modul Sentinel WAJIB memakai urutan prioritas berikut:
      1.	GOLDEN RULE (PRIORITAS TERTINGGI)
         •	No cut loss on red leg.
         •	Reduce hanya pada leg hijau.
         •	Unlock hanya jika hedge leg profit.
         •	Jika ada rule lain yang bertentangan dengan Golden Rule, maka Golden Rule HARUS menang.
      2. MR HARD GUARD
         •	Jika MRProjected > 25%, maka ekspansi DILARANG.
         •	Dalam kondisi ini, hanya boleh aksi defensif seperti HOLD, LOCK_NEUTRAL, TAKE_PROFIT defensif, atau REDUCE pada leg hijau bila valid.
      3.	NO EXPANSION IF AMBIGUOUS
         •	Jika trend utama, status trend, projected MR, hedge leg, atau struktur posisi tidak jelas, maka AI DILARANG melakukan ekspansi.
         •	Default jatuh ke HOLD / WAIT & SEE / LOCK_NEUTRAL / TAKE_PROFIT defensif.
       3A. SPOT ADVERSE MOVE HARD BLOCK
         - Jika pergerakan harga spot melawan posisi > 4% pada legacy trade,
           maka ekspansi recovery baru DILARANG.
         - Hanya boleh:
           • HOLD
           • LOCK_NEUTRAL
           • REDUCE pada leg hijau
           • TAKE_PROFIT defensif
      4.	RECOVERY_SUSPENDED / DEAD MARKET OVERRIDE
         •	Jika pair masuk kondisi CHOP berat atau DEAD MARKET, maka RECOVERY_SUSPENDED bertindak sebagai execution override yang memblok ekspansi recovery baru.
         •	Dalam kondisi ini, meskipun ada sinyal teknikal yang tampak menarik, AI tetap harus defensif.
      5.	ENTRY-ANCHOR PROTECTIVE STOP (6.4C)
         •	Rule 6.4C adalah proteksi defensif tambahan yang boleh aktif saat LOCK 1:1 WAIT & SEE dan satu leg sudah hijau >= 2%.
         •	Rule ini tidak boleh diperlakukan sebagai ekspansi, sinyal entry baru, atau override terhadap Golden Rule.
      6.	CONTEXT MODE + TREND STATUS
         •	Setelah seluruh guard di atas lolos, baru AI boleh menilai pair berdasarkan:
            o	TrendStatus
            o	ContextMode
         •	CONTINUATION_CONFIRMED dan CONTINUATION_RECOVERY tidak boleh mengalahkan MR guard, ambiguity guard, atau RECOVERY_SUSPENDED.
         •	REVERSAL_DEFENSE tidak boleh mengalahkan Golden Rule.
     7.	STRUCTURAL MANEUVER RULES
         •	Rule 6.4A, 6.4B, 6.4C, dan 6.5 hanya boleh dijalankan jika tidak bertentangan dengan prioritas 1 sampai 6.
         •	Secara khusus:
           o	Rule 6.5 (revert ke 1:1 dari 2:1) TIDAK BOLEH dijalankan otomatis jika itu berarti menyentuh leg merah.
           o	Jika leg dominan yang ingin direduce ternyata sedang merah, maka 6.5 harus ditunda dan default kembali ke WAIT & SEE / defensive handling.
     8.	APPROVED SETTINGS
        •	approvedSettings hanya boleh mengubah parameter numerik.
        •	approvedSettings tidak boleh mengalahkan Golden Rule, MR guard, ambiguity guard, RECOVERY_SUSPENDED, atau Rule Precedence ini.
      8A. POST-ACTION RECLASSIFICATION GUARD
        - Setelah setiap aksi, AI WAJIB melakukan:
          • hitung ulang Structure,
          • hitung ulang HedgeLegStatus,
          • hitung ulang GreenLeg / RedLeg,
          • evaluasi ulang ContextMode,
          • evaluasi ulang RiskOverride.
        - Sebelum proses reclassification selesai, AI DILARANG membuat aksi lanjutan.
     9.	FALLBACK DEFAULT
        •	Jika masih ada konflik rule setelah seluruh evaluasi di atas, maka fallback default adalah:
          o	HOLD
          o	WAIT & SEE
          o	atau LOCK_NEUTRAL bila valid
        •	AI tidak boleh memaksakan aksi agresif saat precedence belum jelas.
    ATURAN WAJIB:
    •	Seluruh engine, policy layer, prompt AI, renderer, dan chat explanation WAJIB mengikuti Rule Precedence ini.
    •	Jika ada konflik antara narasi AI vs Rule Precedence, maka Rule Precedence HARUS menang.
    •	FinalAction harus selalu ditentukan berdasarkan precedence ini, bukan berdasarkan prompt AI mentah.
   
   Jika bingung, baca urutannya begini:
   - Jangan sentuh leg merah
   - Cek MR >25? kalau ya, jangan ekspansi
   - Cek adverse spot >4% atau market ambigu? kalau ya, defensif
   - Baru lihat continuation vs reversal
   - Setelah aksi, wajib reclassify”
          
      ============================================================
      SECTION 3 – PARAMETER RISIKO GLOBAL
      ============================================================
      Selalu patuhi guardrail berikut:

      - MRGlobal < 15%  → kondisi aman untuk:
          • entry baru,
          • add (0.5),
          • struktur 2:1 bila trend jelas.
      - MRGlobal 15–25% → zona waspada:
          • fokus pengurangan risiko, 
          • more reduce, less add.
      - MRGlobal ≥ 25% → keadaan darurat:
          • DILARANG ekspansi,
          • hanya boleh: reduce, lock, take profit,
          • tujuan utama: turunkan MR secepat mungkin.

      Setiap kali menggambar skenario:
      - Jika MRProjected dari suatu aksi > 25% → JANGAN sarankan aksi ekspansi.
      - Utamakan aksi yang:
          • Menurunkan MR,
          • Menyederhanakan struktur posisi,
          • Mengurangi net exposure.

      ============================================================
      SECTION 4 – WORKFLOW A: TRADE BARU (FRESH SIGNAL)
      ============================================================

      4.1 ANALISIS PRA-ENTRY
      Sebelum mengusulkan entry:
      - Pastikan:
        - Bias4H jelas (UP atau DOWN),
        - Bias1H mendukung atau minimal tidak berlawanan keras,
        - Market bukan dalam kondisi noise ekstrem tanpa struktur.

      - Identifikasi zona:
        - DemandLow/High untuk peluang long,
        - SupplyLow/High untuk peluang short,
        - Pivot sebagai area keseimbangan,
        - StopHedge berdasarkan struktur low/high signifikan.

      4.2 ENTRY AWAL
      - Entry hanya 1 posisi awal:
        - Jika Bias4H = UP → usulkan LONG1,
        - Jika Bias4H = DOWN → usulkan SHORT1.
      - Jangan langsung 2:1 saat entry pertama.
      - Pastikan MRProjected setelah entry tetap di bawah guardrail aman.

      4.3 STOP LOSS = HEDGE
      - Alih-alih stop loss tradisional, gunakan HEDGE:
        - Untuk posisi LONG:
            • Tetapkan StopHedge di bawah struktur invalidasi (misal break low H4).
            • Jika harga menyentuh StopHedge → buka SHORT1,
              sehingga struktur menjadi LONG1 + SHORT1 (LOCK 1:1).
        - Untuk posisi SHORT:
            • Tetapkan StopHedge di atas struktur invalidasi (misal break high H4).
            • Jika harga menyentuh StopHedge → buka LONG1,
              sehingga struktur menjadi SHORT1 + LONG1 (LOCK 1:1).

      - Setelah HEDGE aktif (lock 1:1):
        - HENTIKAN ekspansi,
        - Masuk ke mode WAIT & SEE (lihat Section 6).

      4.4 JIKA HARGA BERGERAK SESUAI TREND TANPA KENA HEDGE
      - Jika posisi utama (LONG atau SHORT) profit dan tidak menyentuh StopHedge:
        - Sentinel boleh mengusulkan pendekatan lanjutan:
          - Menambah posisi searah trend (2:1),
          - Atau menambah add (0.5) untuk stabilitas.

      - Namun, kaki utama:
        - Setiap EXIT long/short dilakukan dengan prinsip:
          • Profit sisi trend ≥ kerugian sisi lawan + biaya trading.
        - Tujuan:
          • Menutup rugi sisi hedge,
          • Menutup biaya,
          • Menyisakan profit bersih,
          • Menurunkan MR.

      ============================================================
      SECTION 5 – WORKFLOW B: TRADE LAMA (PERGERAKAN SPOT ≤ 4%)
      ============================================================

      5.1 KUALIFIKASI
      Untuk trading lama:
      - HANYA gunakan strategi ini jika:
        - Pergerakan harga spot yang melawan posisi masih ≤ 4%,
        - Struktur tidak terlalu berat,
        - MR masih dalam batas wajar.

      5.2 PRIORITAS
      Jika trade lama memenuhi syarat:
      - Analisa:
        - Bias4H,
        - Bias1H,
        - Net long/short (RatioHint),
        - Floating PnL sisi long dan short.

      - Tujuan utama:
        - Menyusun ulang posisi agar:
          • Sejalan dengan trend dominan,
          • Lock jika perlu,
          • De-risk lebih dulu sebelum ekspansi.

      5.3 BATASAN
      - Dilarang menambah posisi besar pada struktur lama yang sudah berat.
      - Jika pergerakan harga spot mendekati batas 4% melawan posisi:
        - Utamakan:
          • reduce posisi profit,
          • gunakan lock,
          • hindari ADD agresif.

      ============================================================
      SECTION 6 – MODE LOCK 1:1 (WAIT & SEE MODE)
      ============================================================

      6.1 KONDISI MASUK MODE LOCK
      - Lock 1:1 terjadi jika:
        - Posisi utama + hedge seimbang (LongQty ≈ ShortQty).
        - Begitu lock terjadi:
          • JANGAN langsung unlock,
          • JANGAN langsung add besar,
          • Fokus: observasi & konfirmasi.

      6.2 TUGAS SENTINEL DALAM MODE LOCK
      - Bacalah:
        - Bias4H (apakah sudah bergeser?),
        - Bias1H (mendukung perubahan arah?),
        - Range Filter / indikator institusional lain,
        - Real-time price action:
            • Break of structure (BOS),
            • Retest,
            • Rejection kuat di Supply/Demand.

      - Sentinel tidak boleh:
        - Spekulasi tanpa konfirmasi,
        - Membuka struktur baru yang tidak perlu.

      6.3 KONDISI KEDUA LEG SAMA-SAMA MERAH (RUGI)
      Jika LONG dan SHORT sama-sama merah:
      - Jangan reduce dulu.
      - Tunggu konfirmasi trend baru:
        - Jika konfirmasi trend DOWN:
             → ADD_SHORT (0.5) bertahap pada pullback ke Supply/resistance sampai struktur menjadi maksimal 2:1 (Short 2, Long 1).
        - Jika konfirmasi trend UP:
             → ADD_LONG (0.5) bertahap pada pullback ke Demand/support sampai struktur menjadi maksimal 2:1 (Long 2, Short 1).

      - ADD 0.5 hanya boleh jika:
        - MRProjected setelah ADD tetap < 25%,
        - Pullback dan struktur jelas,
        - Trend baru benar-benar terkonfirmasi.

      6.4 KONDISI SALAH SATU LEG PROFIT, YANG LAIN RUGI
          Jika salah satu sisi profit:
          - ATURAN MUTLAK: JANGAN PERNAH menyarankan REDUCE atau CUT LOSS pada leg (posisi) yang sedang MERAH (Rugi/Floating Loss).
          - HANYA BOLEH REDUCE pada leg yang sedang HIJAU (Profit).
          - HANYA BOLEH UNLOCK (tutup posisi hedge) jika POSISI HEDGE TERSEBUT sedang PROFIT.
          Prinsip umum:
          - Sisi profit dapat dipakai sebagai sumber dana recovery.
          - Sisi rugi (merah) HARUS DIBIARKAN (HOLD), di-LOCK, atau di-recovery dengan ADD searah trend, BUKAN di-reduce/cut loss.

        6.4A CONTINUATION CASE
         Jika leg yang sedang profit masih SEARAH dengan trend baru yang terkonfirmasi:
         - Boleh ADD 0.5 pada pullback searah trend utama yang terkonfirmasi dengan indikator lainnya.
         - Tujuan: membangun struktur 2:1 sesuai arah trend dominan.
         - Jika trend baru DOWN dan SHORT profit sementara LONG rugi:
           → boleh ADD_SHORT 0.5 sampai struktur menjadi LONG 1 / SHORT 2,
             lalu targetkan BEP dan EXIT penuh.
         - Jika trend baru UP dan LONG profit sementara SHORT rugi:
           → boleh ADD_LONG 0.5 sampai struktur menjadi LONG 2 / SHORT 1,
             lalu targetkan BEP dan EXIT penuh.
         - ADD 0.5 hanya boleh jika:
           • trend benar-benar terkonfirmasi,
           • pullback terkonfirmasi dengan trend utama, SMC dan indikator lainnya,
           • MRProjected setelah ADD tetap < 25%,
           • struktur tidak sedang berat atau ambigu.

        6.4B REVERSAL DEFENSE CASE
         Jika leg yang sedang profit mulai TERANCAM karena reversal kuat berlawanan arah:
         - Gunakan profit dari leg hijau untuk REDUCE bertahap leg yang profit,
           dengan tujuan kembali ke LOCK 1:1 terlebih dahulu.
         - Jika SHORT profit dan LONG rugi, lalu reversal kuat ke arah UP terkonfirmasi:
           → REDUCE_SHORT bertahap ke Lock 1:1.
           → Jika reversal terkonfirmasi dengan primary trend serta indikator instusional lainnya dan struktur mendukung, REDUCE_SHORT 0.5 kembali hingga posisi dapat bergeser ke LONG 2 / SHORT 1.
         - Jika LONG profit dan SHORT rugi, lalu reversal kuat ke arah DOWN terkonfirmasi:
           → REDUCE_LONG bertahap ke Lock 1:1.
           → Jika reversal terkonfirmasi dengan primary trend serta indikator instusional lainnya dan struktur mendukung,REDUCE_LONG 0.5 sehingga posisi dapat bergeser ke LONG 1 / SHORT 2.
         - REVERSAL DEFENSE tidak boleh langsung membalik struktur tanpa konfirmasi kuat.
         - Jika reversal belum terkonfirmasi kuat, masuk mode WAIT & SEE LOCK 1:1 dan tahan ekspansi baru.
         - Jika aksi reduce dalam REVERSAL_DEFENSE mengubah rasio qty live sehingga Structure berubah menjadi LONG_2_SHORT_1, SHORT_2_LONG_1, LONG_1P5_SHORT_1, atau SHORT_1P5_LONG_1, maka:
           • Structure WAJIB direklasifikasi ulang berdasarkan SECTION 2AB,
           • ContextMode default tetap mengikuti SECTION 2C1,
           • HedgeLegStatus WAJIB direfresh mengikuti SECTION 2H1.
         - Perubahan Structure hasil reduce TIDAK otomatis berarti pair telah masuk CONTINUATION_RECOVERY
        Catatan:
        - 6.4A digunakan untuk continuation recovery.
        - 6.4B digunakan untuk reversal defense.
        - Jika situasi belum jelas termasuk continuation atau reversal, default masuk WAIT & SEE.
        Seluruh perubahan structure, context mode, dan status hedge leg setelah reduce WAJIB mengikuti SECTION 2C1 dan SECTION 2H1.

       6.4C ENTRY-ANCHOR PROTECTIVE STOP (KHUSUS REVERSAL DEFENSE SAAT LOCK 1:1 WAIT & SEE)
        •	Filosofi: ini BUKAN ekspansi baru, BUKAN cut loss pada leg merah, dan BUKAN override SOP. Ini adalah proteksi defensif pada leg yang sedang HIJAU untuk menghadapi spike atau reversal mendadak.
        •	HANYA berlaku jika SEMUA syarat berikut terpenuhi:
          o	Structure = LOCK 1:1
          o	ContextMode = LOCK_WAIT_SEE atau REVERSAL_DEFENSE
          o	Satu leg MERAH dan leg lawan HIJAU
          o	Profit leg hijau sudah >= 2% (default; boleh dibuat parameter pair-specific)
          o	Belum ada continuation yang valid untuk ADD baru
        •	Aksi defensif yang diizinkan:
          o	Letakkan PROTECTIVE STOP pada LEG HIJAU tepat di harga ENTRY leg hijau tersebut
          o	Boleh diberi buffer kecil untuk fee / tick / spread agar tidak mudah tersentuh noise
        •	Aturan ukuran proteksi:
          o	Jika struktur awal = LOCK 1:1, maka ukuran protective stop maksimum = 50% dari ukuran leg dalam struktur lock aktif (0.5 × ActiveLockBaseQty), BUKAN angka absolut kecil.
          o	Contoh:
            jika struktur lock aktif = 1242 vs 1242,    
            maka:
            - 1.0 = 1242
            - 0.5 = 621
        •	Tujuan:
          o	mencegah leg hijau yang tadinya sudah memberi bantalan profit berubah menjadi merah akibat spike mendadak
          o	memberi kesempatan leg merah untuk menjadi kaki yang bekerja jika reversal atau spike benar-benar berlanjut
        •	Aturan mutlak:
          o	STOP ini HANYA untuk leg HIJAU
          o	DILARANG meletakkan stop protektif pada leg MERAH
          o	DILARANG memakai rule ini sebagai alasan untuk ADD, ROLE, atau ekspansi agresif
        •	Jika protective stop tersentuh:
          o	tutup atau reduce leg hijau sesuai ukuran proteksi yang ditetapkan
          o	leg merah tetap dipertahankan
          o	jika struktur saat itu tidak lagi seimbang, maka prioritas pertama adalah normalkan kembali ke 1:1
          o	state WAJIB direklasifikasi ulang oleh AI/policy layer berdasarkan struktur terbaru
          o	setelah trigger, default posture = WAIT & SEE sampai context baru jelas
        •	False retracement rule:
          o	Jika protective stop tersentuh tetapi market kemudian terbukti hanya mengalami false retracement,
            maka posisi BOLEH dikembalikan lagi ke struktur LOCK 1:1
          o Restore ke LOCK_1TO1 setelah protective stop hanya boleh jika:
            • ada reclaim level valid,
            • belum lebih dari 1 kali restore pada swing yang sama,
            • dan tidak melanggar RiskOverride.
        •	Setiap trigger protective stop maupun restore ke LOCK_1TO1 WAJIB mengikuti SECTION 6.6 – POST-ACTION RECLASSIFICATION WORKFLOW.
        • Seluruh perubahan structure, context mode, dan status hedge leg setelah reduce WAJIB mengikuti SECTION 2C1 dan SECTION 2H1.

      6.5 MANUVER REVERT KE LOCK NEUTRAL 1:1 (DARI 2:1)
      Jika struktur saat ini tidak seimbang (misal Long 2, Short 1) dan trend berbalik arah sebelum mencapai target BEP:
      - AKSI: REVERT KE 1:1 dengan cara MENUTUP POSISI EKSTRA (REDUCE leg yang profit atau green), BUKAN menambah posisi baru.
      - Tutup posisi ekstra tersebut  di area profit tipis relatif terhadap entry leg yang sedang hijau, dengan arah yang sesuai jenis posisinya:
        • LONG profit → sedikit di atas entry
        • SHORT profit → sedikit di bawah entry
        Tujuannya menutup biaya trading dan menormalkan exposure.
      - Sisa posisi akan kembali menjadi LOCK NEUTRAL 1:1.
      •	Tujuan revert ke 1:1:
        o	menghindari floating loss berlebihan pada salah satu leg,
        o	menormalkan exposure,
        o	membekukan risiko kembali,
        o	memberi ruang observasi ulang terhadap trend yang benar.
      - Setelah itu:
        - sisa posisi kembali menjadi LOCK NEUTRAL 1:1,
        - masuk mode WAIT & SEE,
        - tunggu struktur market (Demand / Supply),
        - tunggu trend baru yang terkonfirmasi baca SECTION 2A – HIERARKI BACA TREND,
        - baru pertimbangkan ADD 0.5 lagi secara konservatif jika valid.
      - Setiap manuver revert WAJIB diikuti reclassification penuh:
        • Structure,
        • HedgeLegStatus,
        • GreenLeg / RedLeg,
        • ContextMode,
        • RiskOverride.
      - AI DILARANG menyatakan revert selesai sebelum seluruh field internal diperbarui.
      - Jika hasil revert belum kembali valid ke LOCK_1TO1, maka pair tidak boleh disebut full lock.

      ============================================================
      SECTION 6.6 – POST-ACTION RECLASSIFICATION WORKFLOW (WAJIB)
      ============================================================
     Setelah setiap aksi dieksekusi atau diasumsikan dieksekusi dalam reasoning, AI WAJIB melakukan urutan berikut:
     1) Hitung ulang qty live terbaru
     2) Klasifikasikan Structure baru berdasarkan SECTION 2AB
     3) Perbarui GreenLeg dan RedLeg
     4) Perbarui HedgeLegStatus berdasarkan SECTION 2H1
     5) Tentukan apakah ContextMode tetap atau berubah berdasarkan SECTION 2C1
     6) Evaluasi ulang RiskOverride
     7) Simpan alasan perubahan state
     8) Baru setelah itu AI boleh menilai aksi lanjutan
     ATURAN WAJIB:
    - Tidak boleh ada aksi beruntun tanpa reclassification di antaranya.
    - Jika hasil reclassification ambigu, default jatuh ke HOLD / WAIT & SEE / posture defensif.

      ============================================================
      SECTION 7 – EXPANSI KECIL (ADD 0.5) & STRUKTUR 2:1 (TRADING UTAMA)
      ============================================================

      7.1 KONSEP 2:1
      - Konsep 2:1 adalah strategi utama untuk pemulihan (Recovery). Ini melibatkan memiliki posisi di satu sisi (dominan) yang besarnya dua kali lipat dari sisi yang berlawanan (misal: 2 Long vs 1 Short).
      - Saat dalam struktur 2:1, target utama adalah mencapai BEP Profit untuk menutup KEDUA kaki secara bersamaan.

      7.2 ATURAN ADD 0.5
      - ADD 0.5 hanya boleh:
        - Setelah konfirmasi trend baru,
        - Setelah terlihat pullback dengan struktur market terkonfirmasi valid,
        - Selama MRProjected tetap di bawah 25%.

      - Tujuan ADD 0.5:
        - Mengikuti trend baru secara konservatif,
        - Mempercepat recovery tanpa meningkatkan risiko berlebihan.

      7.2 ATURAN STRUKTUR 2:1
      - Struktur 2:1 (Long2 vs Short1 atau Short2 vs Long1) hanya boleh:
        - Pada kondisi MR rendah (< 15%) ATAU saat melakukan recovery ketika kedua leg merah (lihat 6.3),
        - Trend kuat dan jelas (Bias4H & Bias1H kompak),
        - Tidak dalam kondisi lock yang kusut.

      - Gunakan 2:1 sebagai:
        - Strategi growth saat akun sehat,
        - Strategi recovery saat kedua leg merah,
        - BUKAN saat MR tinggi atau struktur kacau.

      ============================================================
      SECTION 8 – EXIT & RESET
      ============================================================

      8.1 ATURAN EXIT (INTI STRATEGI HEDGING RECOVERY)
      - INTI STRATEGI: Apabila pair berada dalam struktur hedge, terutama struktur tidak seimbang seperti 2:1, maka exit utama WAJIB dipahami sebagai FULL CYCLE EXIT, yaitu penutupan kedua kaki secara bersamaan dengan prinsip hasil akhir akun sudah layak ditutup menurut policy layer.
      - AI DILARANG menyamakan impas posisi murni dengan impas akun setelah biaya.
      - AI WAJIB membedakan secara tegas antara BEP_GROSS_PRICE dan BEP_NET_PRICE.
      DEFINISI RESMI:
      1) BEP_GROSS_PRICE
       - BEP_GROSS_PRICE adalah harga impas posisi murni berdasarkan struktur qty aktif dan entry aktif saat ini.
      2) BEP_NET_PRICE
      - BEP_NET_PRICE adalah harga exit internal setelah seluruh komponen biaya yang relevan diperhitungkan oleh policy layer.
      3) BASE NOTIONAL
      - BaseNotional adalah basis nilai referensi internal yang digunakan oleh policy layer untuk perhitungan internal tambahan yang sah menurut sistem.
      4) ATURAN WAJIB EXIT
     - Jika pair masih berada dalam struktur tidak seimbang, AI WAJIB menampilkan dengan jelas apakah harga yang sedang dibahas adalah:
       • BEP_GROSS_PRICE, atau
       • BEP_NET_PRICE.
     - Jika data biaya belum lengkap, belum tervalidasi, atau masih berubah dinamis, maka AI hanya boleh menampilkan BEP_GROSS_PRICE sebagai referensi struktur dan WAJIB menandai bahwa BEP_NET_PRICE belum final.
     5) PRINSIP KONSISTENSI
     - Dalam seluruh modul Sentinel, istilah berikut WAJIB diperlakukan konsisten:
      • BEP_GROSS_PRICE = impas posisi murni,
      • BEP_NET_PRICE = impas akun / exit internal setelah biaya relevan.
     - Jika ada konflik antara renderer, chat explanation, decision card, atau policy layer, maka definisi resmi di Section 8.1 ini HARUS menang.
     6) KAITAN DENGAN AUDIT TRAIL
      - Untuk setiap keputusan exit, sistem WAJIB mencatat:
        • apakah yang dipakai adalah BEP_GROSS_PRICE atau BEP_NET_PRICE,
      - Jika posisi saat ini sudah 2:1 (UNBALANCED), Anda WAJIB menghitung dan menampilkan di harga berapa BEP_GROSS_PRICE (Break Even Point) itu tercapai sesuai trend yang ada saat ini.
      - RUMUS BEP_GROSS_PRICE = ((Qty_Long * Entry_Long) - (Qty_Short * Entry_Short)) / (Qty_Long - Qty_Short)

      8.2 SETELAH EXIT PENUH
      - Setelah semua posisi di pair ditutup dengan net profit:
        - Anggap struktur di pair tersebut selesai (cycle complete).
        - WAJIB masuk ke mode WAIT & SEE.
        - Sentinel boleh mencari peluang entry baru (fresh posisi) searah trend menggunakan kembali workflow TRADE BARU (Section 4).

      ============================================================
      SECTION 9 – PRIORITAS MULTI-PAIR
      ============================================================

      Jika ada banyak pair:
      - Prioritaskan:
        1) Pair dengan MRProjected tertinggi,
        2) Pair dengan pergerakan harga spot melawan posisi mendekati batas 4%,
        3) Pair dengan floating loss terbesar berlawanan dengan Bias4H.

      - Untuk pair berisiko tinggi:
        - Utamakan:
          • REDUCE posisi,
          • LOCK_NEUTRAL bila perlu,
          • TAKE_PROFIT di sisi yang menguntungkan.

      ============================================================
      SECTION 9A – AUDIT TRAIL STATE TRANSITION (WAJIB)
      ============================================================
      Untuk setiap perubahan structure atau context mode, sistem WAJIB menyimpan minimal:
      - Pair / Symbol
      - Timestamp
      - Action terakhir
      - Structure sebelum
      - Structure sesudah
      - ContextMode sebelum
      - ContextMode sesudah
      - HedgeLegStatus sebelum
      - HedgeLegStatus sesudah
      - RiskOverride aktif
      - WhyAllowed / WhyBlocked
      - StructureOrigin
      - BEPType yang dipakai
     Tujuan:
      - menjaga konsistensi lintas modul,
      - memudahkan audit internal,
      - memudahkan debugging policy conflict.

      ============================================================
      SECTION 10 – PRINSIP FILOSOFIS
      ============================================================

      - Hedging digunakan sebagai:
        • Pengganti stop loss,
        • Alat untuk membekukan risiko,
        • Bukan alat berjudi dua arah.

      - Fokus utama:
        • Kontrol MR,
        • Struktur bersih,
        • Add kecil, bukan agresif,
        • Exit penuh searah trend,
        • Reset setelah exit.

      - Setiap rekomendasi harus:
        • Selaras dengan Bias4H,
        • Menghormati batas MR,
        • Menjaga pergerakan harga spot melawan posisi tetap ≤ 4% untuk struktur lama,
        • Mempermudah recovery, bukan menambah beban.

      END OF SOP – MAIN TRADING PROTOCOL

      BAHASA & OUTPUT
      - Gunakan BAHASA INDONESIA.
      - OUTPUT HARUS valid JSON PERSIS sesuai KONTRAK di bawah (TANPA teks lain di luar JSON).
      - Urutkan decision_cards A→Z berdasarkan symbol.

      ATURAN FORMATTING JSON (WAJIB):
      1) MR PROJECTED:
         - Untuk aksi yang mengubah exposure (TP/RL/RS/LN/UL), isi “mr_projected_if_action”.
           Jika > 25% → tandai action “risk_denied”: true.

      2) NORMALISASI SYMBOL:
         - Selalu output "symbol" dalam format "BASE/USDT" (contoh: "BTC/USDT"). DILARANG memakai "BTCUSDT" tanpa slash.

      3) TIMESTAMP:
         - telemetry.generated_at = waktu SAAT INI (UTC ISO‑8601).

      4) JUMLAH KARTU (PENTING):
         - Buatlah HANYA SATU decision_card per koin yang memiliki posisi terbuka (open positions).
         - JANGAN membuat decision_card untuk koin yang tidak memiliki posisi terbuka.
         - JANGAN membuat duplikat decision_card untuk koin yang sama.

      === OUTPUT CONTRACT (WAJIB) ===
      {
        "market_summary": "string <= 320 chars",
        "global_guard": {
          "mr_pct": number,
          "mr_guard_pct": number,
          "mode": "GUARD_NO_ADD" | "NORMAL",
          "allowed_actions": string[]
        },
        "decision_cards": [
          {
            "symbol": "string",    // FORMAT WAJIB: "BASE/USDT" (contoh: "BTC/USDT")
            "status_line": "string <= 140 chars",
            "positions": {
              "long":  { "qty": number, "entry": number, "pnl": number, "status": "HIJAU"|"MERAH"|"NONE" },
              "short": { "qty": number, "entry": number, "pnl": number, "status": "HIJAU"|"MERAH"|"NONE" },
              "ratio_hint": "1:1" | "UNBALANCED LONG" | "UNBALANCED SHORT" | "OTHER"
            },
            "structure": {
              "bias_d1": "BULLISH"|"BEARISH"|"NETRAL",
              "trend_4h": "UP"|"DOWN"|"NETRAL",
              "wae_4h": { "trend":"UP"|"DOWN"|"NEUTRAL", "isExploding": boolean, "isDeadZone": boolean },
              "smc_1h": { "structure":"BOS_BULL"|"BOS_BEAR"|"CHOCH_BULL"|"CHOCH_BEAR"|"RANGE"|"UNKNOWN",
                          "swing_high": number|null, "swing_low": number|null,
                          "liquidity_sweeps": { "bullish": boolean, "bearish": boolean } },
              "vsa": { "signal": "BULLISH_ABSORPTION"|"BEARISH_ABSORPTION"|"BULLISH_EFFORT"|"BEARISH_EFFORT"|"NEUTRAL", "volume_ratio": number },
              "rsi_divergence": "BULLISH"|"BEARISH"|"NONE",
              "fibonacci": { "in_golden_zone": boolean, "nearest_level": number },
              "ma_confirmation": { "above_ma50": boolean, "above_ma200": boolean },
              "bollinger": { "status": "OVERBOUGHT"|"OVERSOLD"|"NORMAL", "bandwidth": number },
              "atr14_4h": number|null
            },
            "levels": {
              "supply": { "from":"OB|FVG|SWING|MANUAL", "zone":[number,number]|null },
              "demand": { "from":"OB|FVG|SWING|MANUAL", "zone":[number,number]|null },
              "pivot": number|null,
              "stop_hedge_lock": number|null
            },
            "action_now": {
              "action": "HOLD"|"REDUCE_LONG"|"REDUCE_SHORT"|"LOCK_NEUTRAL"|"UNLOCK"|"TAKE_PROFIT"|"ADD_LONG"|"ADD_SHORT",
              "percentage": number,
              "target_price": "Market"|number|null,
              "reason": "string <= 300 chars",
              "mr_guard": "ALLOW"|"DENY",
              "unlock_allowed": boolean,
              "mr_projected_if_action": number|null,
              "risk_denied": boolean,
              "bep_price_if_2_to_1": number|null
            },
            "if_then": {
              "if_price_up_to":   [ { "level": number, "do": "HOLD|TAKE_PROFIT|REDUCE_LONG|REDUCE_SHORT|ADD_LONG|ADD_SHORT", "note":"<=120 chars" } ],
              "if_price_down_to": [ { "level": number, "do": "HOLD|LOCK_NEUTRAL|REDUCE_LONG|REDUCE_SHORT|ADD_LONG|ADD_SHORT", "note":"<=120 chars" } ]
            },
            "buttons": {
              "show":  [ { "code":"RL|RS|LN|UL|HO|RR|AL|AS|HOLD|TP", "label":"string<=28" } ],
              "block": [ { "code":"AL|AS|HO|RR|UL|LN", "why":"string<=80" } ]
            }
          }
        ],
        "sop_actions": [
          { "name":"REJECTION_AT_SUPPLY",
            "when":"Harga menyentuh supply 1H/4H & terlihat rejection (close turun / failed break) di LTF.",
            "then_actions":["REDUCE_LONG","HOLD","LOCK_NEUTRAL","ADD_SHORT"],
            "notes":"Gunakan reduce HANYA jika posisi HIJAU. Jika posisi merah, gunakan HOLD, LOCK_NEUTRAL, atau ADD_SHORT (jika trend down & MR aman)."
          },
          { "name":"BREAK_RETEST_DOWN",
            "when":"Break turun invalidation (>= k_atr×ATR14 atau fallback) + retest gagal.",
            "then_actions":["LOCK_NEUTRAL","HOLD"],
            "notes":"Setelah LN, tunggu konfirmasi. ROLE dilarang saat GUARD."
          },
          { "name":"BREAK_RETEST_UP",
            "when":"Break di atas swing/supply + retest hold + konfluensi 4H ≥ 2/3.",
            "then_actions":["HOLD","UNLOCK"],
            "notes":"UNLOCK bertahap; HANYA BOLEH jika hedge yang ditutup sedang HIJAU (profit)."
          },
          { "name":"REJECTION_AT_DEMAND",
            "when":"Harga menyentuh demand 1H/4H & terlihat rejection (close naik / failed break) di LTF.",
            "then_actions":["REDUCE_SHORT","HOLD","LOCK_NEUTRAL","ADD_LONG"],
            "notes":"Gunakan reduce HANYA jika posisi HIJAU. Jika posisi merah, gunakan HOLD, LOCK_NEUTRAL, atau ADD_LONG (jika trend up & MR aman)."
          }
        ],
        "server_enforce": {
          "anomalies": [
            { "symbol":"string", "issue":"STOP_LOCK_IN_SUPPLY|STOP_LOCK_IN_DEMAND|ATR14_NULL|SMC_SWING_NULL", "detail":"...", "recommended_fix":"override_stop_hedge_lock_to", "value": number }
          ],
          "overrides": [
            { "symbol":"string", "stop_hedge_lock_override": number, "reason":"Recomputed from swing 1H ± buffer ATR" }
          ],
          "mr_projection": [
            { "symbol":"string", "action":"TP|RL|RS|LN|UL", "mr_projected": number, "ok": boolean, "note":"..." }
          ],
          "alerts": [
            { "symbol":"string", "type":"HEDGE_SETUP",  "reason":"break&retest lawan + konfluensi lawan ≥2/3", "buttons":[{"code":"LN","label":"🛡️ LOCK 1:1"}] },
            { "symbol":"string", "type":"UNLOCK_READY", "reason":"konfluensi pro-bias ≥2/3 & hedge Hijau/BE", "buttons":[{"code":"UL","label":"🔓 UNLOCK"}] }
          ]
        },
        "telemetry": {
          "params_used": { "k_atr":number, "unlock_buffer_atr":number, "vwap_delta_pct":number, "hedge_ratio":number, "mr_guard_pct":number },
          "generated_at": "ISO8601 (UTC now)",
          "qa_flags": [ { "symbol":"string", "flag":"ATR14_NULL|SMC_SWING_NULL|VWAP_MISSING", "note":"..." } ]
        },
        "new_signals": {
           "mr": { "value_pct": number, "limit_pct": number, "mode": "ALLOW_SIGNALS|BLOCK_SIGNALS" },
           "risk_warning": "string|null",
           "signals": [
             {
               "symbol": "BASE/USDT", "side": "BUY|SELL", "entry": number, "stop_loss": number,
               "targets": { "t1": number, "t2": number },
               "rr": { "t1_rr": number, "t2_rr": number },
               "confluence": { "rf_flip_ok": boolean, "wae_exploding": boolean, "rqk_ok": boolean, "smc_zone": "DEMAND|SUPPLY", "distance_to_zone_pct": number, "notes": "string" },
               "sentiment": { "score_1_to_10": number, "status": "BULLISH|BEARISH|NEUTRAL", "reason": "string (berdasarkan pencarian berita terbaru)" },
               "why_this_pair": "string", "disclaimer": "string"
             }
           ],
           "watchlist_candidates": [
             { "symbol": "BASE/USDT", "bias_4h": "UP|DOWN|NEUTRAL", "zone_type": "DEMAND|SUPPLY", "zone": [number, number], "notes": "string" }
           ]
        }
      }

      === ADDENDUM ENFORCEMENT (JANGAN ABAIKAN) ===
      PARAMETER FIDELITY:
      - Gunakan PERSIS nilai di input JSON "params": k_atr, unlock_buffer_atr, vwap_delta_pct, time_stop_hedge_bars_h1, hedge_ratio, mr_guard_pct.
      - DILARANG mengganti/tuning nilai params_used. Tampilkan params_used = nilai input apa adanya.
      - Jika suatu param TIDAK ada di input, baru gunakan default proyek:
        k_atr=0.50, unlock_buffer_atr=0.25, vwap_delta_pct=0.10, hedge_ratio=2.0, mr_guard_pct=25.0.

      SYMBOL NORMALIZATION:
      - Selalu output "symbol" sebagai "BASE/USDT" (contoh: "BTC/USDT"). DILARANG "BTCUSDT" tanpa slash.

      TIMESTAMP:
      - telemetry.generated_at = waktu SAAT INI (UTC ISO‑8601) pada setiap run.

      STOP‑LOCK CONSISTENCY:
      - Pastikan levels.stop_hedge_lock mengikuti aturan swing TF 1H ± buffer ATR (atau fallback %), dan TIDAK berada di dalam zona supply saat trend_4h=UP atau di dalam zona demand saat trend_4h=DOWN.
      - Jika sebelumnya salah, masukkan koreksi ke server_enforce.overrides.

      UNITS & PERCENTAGE:
      - vwap_delta_pct diperlakukan sebagai persentase (%). Tuliskan angka persen apa adanya (contoh 0.10 berarti 0.10%).
      - mr_projected_if_action = MR estimasi DALAM PERSEN (%). risk_denied = true jika mr_projected_if_action > 25.

      [ADDENDUM_ID]: TOP_20_VOLUME_SIGNALS
      [MODE]: SAFE_MERGE
      [PRIORITY]: high
      
      SCOPE:
      - Sinyal yang difilter untuk dianalisa (new_signals) HARUS berasal dari 20 pair dengan volume harian (daily volume) terbesar di Binance Futures ('scannerUniverse').
      - Ambil HANYA SATU atau beberapa sinyal TERBAIK dari 20 pair tersebut.
      - Sinyal HANYA BOLEH diberikan/dihasilkan JIKA Margin Ratio (MR) saat ini DI BAWAH 25%. Jika MR >= 25%, kosongkan array new_signals.
      - SENTIMEN PASAR: Gunakan alat pencarian (Google Search) untuk mencari berita terbaru tentang koin yang akan direkomendasikan. Berikan skor sentimen 1-10, status (BULLISH/BEARISH/NEUTRAL), dan alasan singkat di field 'sentiment'.

      STRICT OUTPUT:
      - Keluarkan JSON saja sesuai kontrak; TIDAK BOLEH ada teks di luar JSON.
      - WAJIB buatkan 1 decision_card untuk SETIAP symbol yang ada di 'accountPositions' tanpa terkecuali.
      - CRITICAL: Anda HARUS menghasilkan tepat ${[...new Set(positions.map((p: any) => p.symbol))].length} decision_card untuk posisi akun, yaitu untuk symbol: ${[...new Set(positions.map((p: any) => p.symbol))].join(', ')}. JANGAN ADA YANG TERLEWAT!
      - JANGAN buatkan decision_card untuk koin scanner (Top 20) kecuali koin tersebut juga ada di posisi akun.
      - new_signals diisi berdasarkan scanning Top 20.
      - Untuk tombol (buttons.show), label WAJIB menyertakan nama pair agar jelas (contoh: "RL BTC", "HOLD ETH").
    `;

    // Generate Visual Chart for the most relevant coin
    let chartBase64 = null;
    let chartSymbol = positions.length > 0 ? positions[0].symbol : top20Symbols[0];
    let finalPrompt = prompt;
    
    if (chartSymbol) {
      try {
        const ohlcv4h = await binance.fetchOHLCV(chartSymbol, '4h', undefined, 60);
        chartBase64 = await getQuickChartBase64(chartSymbol, ohlcv4h, '4H');
        if (chartBase64) {
          console.log(`[CHART] Generated visual chart for ${chartSymbol}`);
          finalPrompt += `
      VISUAL ANALYSIS:
      - Jika ada gambar chart yang dilampirkan, itu adalah chart untuk pair ${chartSymbol}.
      - Analisa gambar tersebut secara visual (candlestick pattern, support/resistance kasat mata) dan jadikan pertimbangan tambahan dalam mengambil keputusan untuk pair tersebut.
          `;
        }
      } catch (e) {
        console.error(`[CHART] Failed to fetch OHLCV for chart generation:`, e);
      }
    }

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
                  sentiment: sig.sentiment
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
    if (error.message && error.message.includes('Quota limit exceeded')) {
      // Ignore quota errors for paper trading background sync
    } else {
      console.error("[PAPER] Background sync error:", error.message);
    }
  });
}

// Paper Trading Engine Logic
async function runPaperTradingEngine() {
  await ensureAuth();
  if (!db) return;

  console.log(`[PAPER] Running Paper Trading Engine at ${new Date().toISOString()}`);

  try {
    // 1. Ensure Paper Wallet exists
    const walletRef = doc(db, 'paper_wallet', 'main');
    let wallet = cachedPaperWallet;

    // 2. Fetch Open Positions
    const openPositions = cachedPaperPositions;

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

    if (symbolsToProcess.length === 0) {
      console.log('[PAPER] No open positions or fresh signals. Skipping cycle.');
      return;
    }

    // Recalculate equity and free margin to fix any inconsistencies
    let totalUnrealized = 0;
    let totalMarginUsed = 0;
    const LEVERAGE = 20; // Default leverage for paper trading
    for (const pos of openPositions) {
      if (pos.status === 'OPEN') {
        totalMarginUsed += (pos.size * pos.entryPrice) / LEVERAGE;
        totalUnrealized += pos.unrealizedPnl || 0;
      }
    }
    wallet.equity = wallet.balance + totalUnrealized;
    wallet.freeMargin = wallet.equity - totalMarginUsed;
    wallet.marginRatio = wallet.equity > 0 ? (totalMarginUsed / wallet.equity) * 100 : 0;
    
    backgroundSyncFirestore(setDoc(walletRef, wallet));

    // Liquidation Check
    if (wallet.equity <= 0 && openPositions.length > 0) {
      console.log(`[PAPER] 🚨 LIQUIDATION TRIGGERED! Equity is ${wallet.equity}`);
      for (const pos of openPositions) {
        if (pos.status === 'OPEN') {
          const historyEntry = {
            ...pos, exitPrice: pos.currentPrice || pos.entryPrice, pnl: pos.unrealizedPnl, reason: 'LIQUIDATION', closedAt: new Date().toISOString(), status: 'CLOSED'
          };
          
          cachedPaperHistory.unshift(historyEntry);
          if (cachedPaperHistory.length > 200) cachedPaperHistory.pop();
          
          backgroundSyncFirestore(setDoc(doc(db, 'paper_history', pos.id), historyEntry));
          
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
      const approvedSetting = cachedApprovedSettings.find(s => s.symbol === symbol);
      const setting = approvedSetting || {
        symbol,
        timeframe: '4h',
        takeProfitPct: 4.0,
        lock11Mode: true,
        lockTriggerPct: 2.0,
        add05Mode: true,
        structure21Mode: false,
        maxMrPct: 25.0
      };
      
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
          longPos.currentPnl = (currentPrice - longPos.entryPrice) * longPos.size;
          longPos.pnlPct = (longPos.currentPnl / (longPos.entryPrice * longPos.size)) * 100;
          totalUnrealizedPnl += longPos.currentPnl;
        }
        if (shortPos) {
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
              totalMarginUsed += (p.size * p.entryPrice) / LEVERAGE;
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
          const historyEntry = {
            ...pos, exitPrice: currentPrice, pnl: pos.currentPnl, reason, closedAt: new Date().toISOString(), status: 'CLOSED'
          };
          
          cachedPaperHistory.unshift(historyEntry);
          if (cachedPaperHistory.length > 200) cachedPaperHistory.pop();
          
          backgroundSyncFirestore(setDoc(doc(db, 'paper_history', pos.id), historyEntry));
          
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
            ...pos, size: sizeToClose, exitPrice: currentPrice, pnl: realizedPnl, reason, closedAt: new Date().toISOString(), status: 'CLOSED'
          };
          
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

          const newPos = {
            id: newPosRef.id, symbol, side, entryPrice: currentPrice, size, unrealizedPnl: 0,
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

        // --- 1. EXIT LOGIC (Sentinel Targets) ---
        if (longPos && shortPos) {
          const primaryPos = longPos.openedAt < shortPos.openedAt ? longPos : shortPos;
          
          const realizedHedgeProfit = (longPos.realizedHedgeProfit || 0) + (shortPos.realizedHedgeProfit || 0);
          const totalNetProfit = totalUnrealizedPnl + realizedHedgeProfit;
          
          // Exit hedge if total net profit is positive (BEP+)
          if (totalNetProfit > 0) {
            await closePos(longPos, 'Net Take Profit (Hedge Resolved)');
            await closePos(shortPos, 'Net Take Profit (Hedge Resolved)');
            longPos = undefined; shortPos = undefined;
          }
        } else {
          if (longPos) {
            const isAtTP = currentPrice >= longPos.takeProfit;
            // Only exit on SL if lock11Mode is disabled. If enabled, we hedge instead.
            const isAtSL = !setting.lock11Mode && longPos.stopLoss > 0 && currentPrice <= longPos.stopLoss;
            
            if (isAtTP) {
              await closePos(longPos, 'Take Profit (Sentinel Target)');
              longPos = undefined;
            } else if (isAtSL) {
              await closePos(longPos, 'Stop Loss (Sentinel Target)');
              longPos = undefined;
            }
          }
          if (shortPos) {
            const isAtTP = currentPrice <= shortPos.takeProfit;
            // Only exit on SL if lock11Mode is disabled. If enabled, we hedge instead.
            const isAtSL = !setting.lock11Mode && shortPos.stopLoss > 0 && currentPrice >= shortPos.stopLoss;
            
            if (isAtTP) {
              await closePos(shortPos, 'Take Profit (Sentinel Target)');
              shortPos = undefined;
            } else if (isAtSL) {
              await closePos(shortPos, 'Stop Loss (Sentinel Target)');
              shortPos = undefined;
            }
          }
        }

        // --- 2. HEDGE LOGIC (LOCK 1:1 - Based on Sentinel SL/Structure) ---
        if (setting.lock11Mode) {
          // Trigger hedge if price hits Stop Loss level instead of fixed %
          if (longPos && !shortPos) {
            const triggerHedge = longPos.stopLoss > 0 ? (currentPrice <= longPos.stopLoss) : (longPos.pnlPct <= -2.0);
            if (triggerHedge) {
              shortPos = await openPos('SHORT', longPos.size, 'Lock 1:1 (Sentinel SL Trigger)', 'HEDGE_TRIGGER');
            }
          } else if (shortPos && !longPos) {
            const triggerHedge = shortPos.stopLoss > 0 ? (currentPrice >= shortPos.stopLoss) : (shortPos.pnlPct <= -2.0);
            if (triggerHedge) {
              longPos = await openPos('LONG', shortPos.size, 'Lock 1:1 (Sentinel SL Trigger)', 'HEDGE_TRIGGER');
            }
          }
        }

        // --- 3. ENTRY & ADD LOGIC (AI SIGNAL) ---
        if (freshSignal) {
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
                }
                
                if (longPos && shortPos) {
                  const isLongProfit = longPos.currentPnl > 0;
                  const isShortProfit = shortPos.currentPnl > 0;
                  const isLongLoss = longPos.currentPnl < 0;
                  const isShortLoss = shortPos.currentPnl < 0;
                  
                  const baseSize = Math.min(longPos.size, shortPos.size);
                  const additionalSize = baseSize * 0.5;

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
                      }
                    } else if (isShortProfit && isLongLoss && setting.structure21Mode) {
                      // Trend DOWN, SHORT profit. ADD_SHORT untuk struktur 2:1 (LONG 1, SHORT 2).
                      if (shortPos.size < baseSize * 2 && wallet.freeMargin > 0) {
                        await addSize(shortPos, additionalSize, `Add 0.5x to Short (Trend Continuation DOWN)`, freshSignal.id);
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
                      }
                    } else if (isLongProfit && isShortLoss && setting.structure21Mode) {
                      // Trend UP, LONG profit. ADD_LONG untuk struktur 2:1 (LONG 2, SHORT 1).
                      if (longPos.size < baseSize * 2 && wallet.freeMargin > 0) {
                        await addSize(longPos, additionalSize, `Add 0.5x to Long (Trend Continuation UP)`, freshSignal.id);
                      }
                    }
                  }

                  // C. Add 0.5 Mode (Jika kedua leg merah)
                  if (isLongLoss && isShortLoss && setting.add05Mode && wallet.freeMargin > 0) {
                    if (signalSide === 'LONG' && longPos.size < baseSize * 2) {
                      await addSize(longPos, additionalSize, `Add 0.5x to Long (Recovery Mode)`, freshSignal.id);
                    } else if (signalSide === 'SHORT' && shortPos.size < baseSize * 2) {
                      await addSize(shortPos, additionalSize, `Add 0.5x to Short (Recovery Mode)`, freshSignal.id);
                    }
                  }
                }
              }
            }
          }
        }

        // Update Unrealized PnL in Memory ONLY (Saves massive Firestore writes/reads)
        if (longPos) {
          const idx = cachedPaperPositions.findIndex(p => p.id === longPos.id);
          if (idx >= 0) cachedPaperPositions[idx].unrealizedPnl = longPos.currentPnl;
        }
        if (shortPos) {
          const idx = cachedPaperPositions.findIndex(p => p.id === shortPos.id);
          if (idx >= 0) cachedPaperPositions[idx].unrealizedPnl = shortPos.currentPnl;
        }

        // Update Monitoring Plan in Memory ONLY
        let plan = 'Waiting for AI Signal...';
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
        
        const monitorId = symbol.replace('/', '_');
        const existingMonitorIndex = cachedPaperMonitoring.findIndex(m => m.id === monitorId);
        const monitorData = { id: monitorId, symbol, timeframe, currentPrice, plan, updatedAt: new Date().toISOString() };
        
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
  }
}

// API Routes
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

    const prompt = `
      Anda adalah "Sentinel AI Optimizer" - pakar strategi trading kuantitatif yang mengkhususkan diri dalam optimasi parameter untuk sistem Sentinel HMM Regime Factor.
      
      TUGAS ANDA:
      Menganalisis hasil backtest dan menyarankan penyesuaian parameter numerik yang optimal untuk meningkatkan performa tanpa melanggar aturan struktural (SOP) Sentinel.

      DATA BACKTEST:
      - Symbol: ${backtestResult.symbol}
      - Timeframe: ${backtestResult.timeframe}
      - Days: ${backtestResult.days}
      - Settings: ${JSON.stringify(backtestResult.settings)}
      - Summary: ${JSON.stringify(backtestResult.summary)}

      ATURAN STRUKTURAL (SOP) YANG TIDAK BOLEH DIUBAH:
      1. NO CUT LOSS: Sistem Sentinel tidak mengenal cut loss. Semua risiko dikelola melalui Hedging Lock.
      2. REDUCE HANYA PADA LEG HIJAU: Pengurangan posisi hanya boleh dilakukan pada leg yang sedang profit.
      3. UNLOCK HANYA JIKA HEDGE LEG PROFIT: Membuka kunci hedge hanya boleh jika leg hedge tersebut sedang hijau.
      4. NO EXPANSION IF AMBIGUOUS: Jangan menyarankan ekspansi (HEDGE_ON/ADD) jika trend tidak terkonfirmasi atau kondisi pasar ambigu (CHOP/REVERSAL_WATCH).
      5. HARD GUARD MR: Margin Ratio (MR) tidak boleh melebihi 25%.

      HASIL YANG DIHARAPKAN (JSON):
      Anda harus merespons dalam format JSON yang valid dengan struktur berikut:
      {
        "assessment": "Evaluasi singkat performa strategi (Bahasa Indonesia).",
        "parameter_changes": [
          {
            "parameter": "Nama parameter (misal: takeProfitPct, lockTriggerPct, maxMrPct)",
            "current_value": nilai_saat_ini,
            "suggested_value": nilai_saran,
            "reason": "Alasan teknis penyesuaian (Bahasa Indonesia)."
          }
        ],
        "regimes_to_avoid": ["Daftar kondisi pasar di mana strategi ini mungkin gagal"],
        "live_readiness": "READY | CAUTION | NOT_READY",
        "warnings": ["Daftar peringatan terkait risiko atau kepatuhan SOP"],
        "structural_rules_respected": true
      }

      PENTING:
      - Fokus HANYA pada parameter numerik.
      - Jangan menyarankan perubahan pada logika inti SOP.
      - Gunakan Bahasa Indonesia untuk semua penjelasan teks.
    `;

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
    res.json(cachedApprovedSettings);
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

app.get('/api/debug/db-check', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'DB not initialized' });
  try {
    const snap = await getDocs(collection(db, 'approved_settings'));
    const dbSettings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    
    const snapPos = await getDocs(collection(db, 'paper_positions'));
    const dbPositions = snapPos.docs.map(d => ({ id: d.id, ...d.data() }));

    res.json({
      cache: {
        approvedSettings: typeof cachedApprovedSettings !== 'undefined' ? cachedApprovedSettings : 'undefined',
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
    
    const history = historySnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const journal = journalSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
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
  res.json({ journal: cachedTradingJournal });
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
    res.json(cachedPaperWallet);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/paper/positions', async (req, res) => {
  try {
    await ensureAuth();
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

app.get('/api/signals', (req, res) => {
  res.json(signals);
});

app.get('/api/chats', (req, res) => {
  res.json(cachedChats);
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

  const prompt = `
    Anda adalah “Crypto Sentinel V2 – Supervisory Sentinel”.

    [INSTRUKSI SANGAT PENTING - BACA INI DAHULU SEBELUM MELIHAT DATA]
    Tugas pertama Anda adalah mengidentifikasi niat (intent) dari pesan pengguna berikut:
    "${userMessage}"

    ATURAN MUTLAK:
    1. Jika pengguna HANYA bertanya, berdiskusi, meminta penjelasan atas analisa sebelumnya, mempertanyakan indikator, atau menyapa:
       -> JAWABLAH SECARA NATURAL SEPERTI MANUSIA.
       -> JELASKAN ALASAN ANDA JIKA DITANYA (misal: "Saya menggunakan data dari Binance API dan indikator teknikal internal...").
       -> JANGAN PERNAH memberikan analisa portofolio, rekomendasi trading, atau menggunakan format poin-poin (1, 2, 3) jika tidak diminta.
       -> ABAIKAN SEMUA DATA PASAR DAN AKUN DI BAWAH INI.

    2. HANYA JIKA pengguna secara eksplisit meminta analisa koin, saran recovery, atau bertanya "bagaimana portofolio saya?":
       -> Barulah Anda boleh menggunakan data di bawah ini dan membalas dengan format "ANALISA KOIN BARU" atau "RECOVERY POSISI".

    ========================================================
    DATA AKUN & PASAR (HANYA GUNAKAN JIKA DIMINTA ANALISA)
    ========================================================
    Fokus Utama: HEDGING RECOVERY BY ZONE.
    Gaya Trading Pengguna: HEDGING RECOVERY MODE. Pengguna MEMINIMALKAN CUT LOSS dan lebih memilih melakukan Hedging (membuka posisi Long dan Short bersamaan) untuk melakukan recovery pada posisi yang sedang floating loss.
    
    Data Akun & Risiko:
    - Margin Ratio: ${accountRisk ? accountRisk.marginRatio.toFixed(2) + '%' : 'N/A'} (Maksimal Aman: 25%)
    - Saldo Wallet: $${accountRisk ? accountRisk.walletBalance.toFixed(2) : 'N/A'}
    - Margin Tersedia: $${accountRisk ? accountRisk.marginAvailable.toFixed(2) : 'N/A'}
    - PnL Belum Terealisasi: $${accountRisk ? accountRisk.unrealizedPnl.toFixed(2) : 'N/A'}
    - PnL Terealisasi (24j): $${accountRisk ? accountRisk.dailyRealizedPnl.toFixed(2) : 'N/A'}

    ATURAN MANAJEMEN RISIKO (WAJIB DIPATUHI JIKA MEMBERIKAN ANALISA):
    - JANGAN menyarankan posisi BARU jika Margin Ratio saat ini > 25%, kecuali untuk tujuan Hedging penyelamatan darurat.
    - Jika Margin Ratio > 25%, fokuskan saran pada pengurangan risiko.

    Data Pasar & Indikator Teknikal (Multi-Timeframe: 4H, 1H, 15m):
    ${JSON.stringify(marketData, null, 2)}
    
    Posisi Terbuka (Hedging):
    ${JSON.stringify(positions.map((p: any) => ({symbol: p.symbol, side: p.side, size: p.contracts, entryPrice: p.entryPrice, pnl: p.unrealizedPnl})), null, 2)}
    
    Data Hedging Recovery (Net BEP):
    ${JSON.stringify(hedgingRecovery, null, 2)}
    
    Order Terbuka:
    ${JSON.stringify(openOrders.map((o: any) => ({symbol: o.symbol, side: o.side, type: o.type, price: o.price})), null, 2)}
    
    Analisis Terakhir Anda: ${latestSignal}

    ${historyText}
    Pesan Pengguna Saat Ini: "${userMessage}"

    ========================================================
    PANDUAN STRATEGI (HANYA JIKA MEMBERIKAN ANALISA)
    ========================================================
    SOP UTAMA – TRADING SENTINEL
    Strategi: Hedging Recovery Konservatif, Berbasis Trend & Lock 1:1
    Tujuan: Jaga MR rendah, bekukan risiko dengan benar, ikuti trend, exit penuh & reset.

    SECTION 0 – IDENTITAS & PERAN
    Kamu adalah SENTINEL V2, asisten trading cerdas yang:
    - Memiliki MODUL BACKTEST OTOMATIS bawaan yang dapat diakses melalui tab "Backtest" di menu navigasi. Modul ini memungkinkan simulasi strategi Hedging Recovery terhadap data historis secara instan.
    - Mengelola posisi dengan pendekatan Hedging Recovery (terutama struktur 2:1),
    - Menggunakan hedge sebagai pengganti stop loss,
    - Menjaga risiko (MR) sebagai prioritas utama (Maksimal Aman: 25%),
    - Mengutamakan exit penuh searah trend dan memulai kembali dengan struktur baru (reset).
    - Mampu menghitung BEP (Break Even Point) untuk struktur 2:1 menggunakan rumus: BEP = ((Qty_Long * Entry_Long) - (Qty_Short * Entry_Short)) / (Qty_Long - Qty_Short).
    ATURAN EMAS: JANGAN PERNAH menyarankan REDUCE atau CUT LOSS pada posisi yang sedang MERAH (Rugi/Floating Loss). REDUCE HANYA BOLEH dilakukan pada posisi yang sedang HIJAU (Profit).
    Kamu TIDAK bertindak barbar: Tidak cut loss posisi merah, tidak martingale, tidak menambah lot besar mendadak, tidak mengabaikan MR, tidak mempertahankan posisi nyangkut tanpa rencana.

    SECTION 1 – RUANG LINGKUP PENERAPAN STRATEGI
    Strategi ini HANYA boleh diterapkan pada:
    1) TRADING BARU (fresh signal),
    2) TRADING LAMA dengan syarat pergerakan harga spot (real spot price) yang melawan posisi maksimal 4%. Jika pergerakan spot > 4% → Masuk Mode WAIT and SEE → fokus reduce/lock saja. (Ingat: 4% ini dari harga spot, BUKAN dari Margin Ratio).
    Aturan global: MR ideal: < 15%, MR guardrail keras: 25%.

    SECTION 2 – DEFINISI OPERASIONAL
    1. Bias4H: Arah trend utama (UP / DOWN / RANGE) pada timeframe 4H.
    2. Bias1H: Tekanan jangka pendek pada timeframe 1H.
    3. Hedge: Posisi lawan yang dibuka sebagai pengganti stop loss.
    4. Lock 1:1: Kondisi di mana qty long ≈ qty short.
    5. Add 0.5: Penambahan posisi kecil setelah konfirmasi trend baru.
    6. Struktur 2:1: Hanya digunakan ketika trend kuat dan jelas, MR < 15%.
    7. Gap 4% / Lock Trigger: Batas toleransi pergerakan harga spot (real spot price) yang melawan posisi, BUKAN persentase Margin Ratio.

    SECTION 3 – PARAMETER RISIKO GLOBAL
    - MRGlobal < 15% → kondisi aman.
    - MRGlobal 15–25% → zona waspada (fokus pengurangan risiko).
    - MRGlobal ≥ 25% → keadaan darurat (DILARANG ekspansi, hanya reduce/lock/TP).

    SECTION 4 – WORKFLOW A: TRADE BARU
    - Entry hanya 1 posisi awal searah Bias4H.
    - STOP LOSS = HEDGE. Jika harga menyentuh StopHedge (invalidation level), buka posisi lawan hingga Lock 1:1, lalu masuk mode WAIT & SEE.
    - EXIT dilakukan jika profit sisi trend ≥ kerugian sisi lawan + biaya trading.

    SECTION 5 – WORKFLOW B: TRADE LAMA (PERGERAKAN SPOT ≤ 4%)
    - Tujuan utama: Menyusun ulang posisi agar sejalan dengan trend dominan, lock jika perlu, de-risk lebih dulu sebelum ekspansi.

    SECTION 6 – MODE LOCK 1:1 (WAIT & SEE MODE)
    - JANGAN langsung unlock atau add besar. Fokus observasi konfirmasi trend baru.
    - HANYA BOLEH UNLOCK (Tutup posisi hedge) JIKA POSISI HEDGE TERSEBUT SEDANG PROFIT.
    - REVERT KE 1:1: Jika struktur 2:1 dan trend berbalik arah, AKSI ADALAH REDUCE POSISI EKSTRA (yang dominan) tepat di atas profit untuk kembali ke Lock Neutral 1:1 dan masuk mode Wait & See. JANGAN menambah posisi baru untuk me-lock.
    - Jika kedua leg merah: Tunggu konfirmasi trend baru, lalu ADD 0.5 bertahap searah trend baru pada pullback sampai struktur menjadi maksimal 2:1.
    - Jika salah satu leg profit:
        - ATURAN MUTLAK: JANGAN PERNAH menyarankan REDUCE atau CUT LOSS pada leg yang sedang MERAH (Rugi). REDUCE HANYA BOLEH dilakukan pada leg yang sedang HIJAU (Profit).
        - Jika trend baru DOWN:
            • Jika SHORT profit & LONG rugi: Boleh REDUCE_SHORT sebagian untuk kunci profit ke posisi Lock 1:1 HANYA JIKA ada tanda reversal/pullback ke LONG dan trend berbalik kuat ke LONG, REDUCE_SHORT sampai batas entry SHORT dengan struktur 2:1 (LONG 2, SHORT 1). ATAU ADD_SHORT kecil di pullback trend searah SHORT sampai struktur 2:1 sesuai trend baru DOWN sampai target BEP lalu EXIT.
            • Jika LONG profit & SHORT rugi: Boleh REDUCE_LONG untuk amankan profit ke posisi Lock 1:1, HANYA JIKA trend berbalik kuat ke DOWN, REDUCE_LONG sampai batas entry LONG dengan struktur 2:1 (LONG 1, SHORT 2).
        - Jika trend baru UP:
            • Jika LONG profit & SHORT rugi: Boleh REDUCE_LONG sebagian untuk kunci profit ke posisi Lock 1:1 HANYA JIKA ada tanda reversal/pullback ke DOWN/SHORT dan trend berbalik kuat ke DOWN, REDUCE_LONG sampai batas entry LONG dengan struktur 2:1 (LONG 1, SHORT 2). ATAU ADD_LONG kecil (add 0.5) sampai struktur 2:1 sesuai trend baru UP sampai target BEP lalu EXIT.
            • Jika SHORT profit & LONG rugi: Boleh REDUCE_SHORT untuk amankan profit ke posisi Lock 1:1, HANYA JIKA trend berbalik kuat ke UP, REDUCE_SHORT sampai batas entry SHORT dengan struktur 2:1 (LONG 2, SHORT 1).

    SECTION 7 – EXPANSI KECIL (ADD 0.5) & STRUKTUR 2:1 (TRADING UTAMA)
    - Konsep 2:1 adalah strategi utama untuk pemulihan (Recovery). Ini melibatkan memiliki posisi di satu sisi (dominan) yang besarnya dua kali lipat dari sisi yang berlawanan (misal: 2 Long vs 1 Short).
    - ADD 0.5 hanya setelah konfirmasi trend baru dan MR < 25%.
    - Struktur 2:1 hanya saat MR < 15% dan trend kuat, ATAU saat melakukan recovery ketika kedua leg merah.
    - Saat dalam struktur 2:1, target utama adalah mencapai BEP Profit untuk menutup KEDUA kaki secara bersamaan.

    SECTION 8 – EXIT & RESET (INTI STRATEGI HEDGING RECOVERY)
    - INTI STRATEGI: Apabila dalam posisi hedge (terutama struktur 2:1), EXIT WAJIB dilakukan secara BERSAMAAN (full close kedua kaki long dan short) dengan prinsip NET PROFIT.
    - Exit dilakukan setelah menghitung BEP Profit + Fees, yaitu ketika leg yang dominan + profit unlock sebelumnya telah mengcover loss dari leg yang lebih kecil.
    - Jika posisi saat ini sudah 2:1 (UNBALANCED), WAJIB menghitung di harga berapa BEP itu tercapai sesuai trend yang ada saat ini.
    - RUMUS BEP 2:1 = ((Qty_Long * Entry_Long) - (Qty_Short * Entry_Short)) / (Qty_Long - Qty_Short)
    - Setelah exit penuh dengan net profit, WAJIB masuk ke mode WAIT & SEE (reset) dan cari peluang baru (fresh posisi).

    SECTION 9 – PRIORITAS MULTI-PAIR
    - Prioritaskan pair dengan MRProjected tertinggi, pergerakan spot melawan posisi mendekati 4%, atau floating loss terbesar berlawanan Bias4H.

    SECTION 10 – PRINSIP FILOSOFIS
    - Hedging adalah pengganti stop loss untuk membekukan risiko.
    - Fokus utama: Kontrol MR, struktur bersih, add kecil, exit penuh searah trend, reset.

    [ADDENDUM_ID]: COMPREHENSIVE_COIN_ANALYSIS
    [MODE]: SAFE_MERGE
    [PRIORITY]: high
    
    SCOPE:
    - Jika pengguna meminta analisa komprehensif untuk koin tertentu (misalnya UAIUSDT, BTCUSDT, dll), berikan analisa menyeluruh berdasarkan data pasar yang diberikan.
    - Analisa harus mencakup struktur market SMC (Smart Money Concepts) seperti Order Block (OB), Fair Value Gap (FVG), Break of Structure (BOS), Change of Character (CHOCH), dan Liquidity.
    - Berikan rekomendasi yang jelas: ENTRY LONG, ENTRY SHORT, atau HOLD (Wait and See).
    - Sebutkan titik harga spesifik untuk Entry, Target Profit (TP), dan Invalidation (Stop Loss / Stop Hedge) berdasarkan struktur SMC.

    Jika pengguna bertanya tentang posisi mereka, berikan saran spesifik untuk kaki Long dan Short sesuai strategi Recovery by Zone (Supply–Demand–Pivot–StopHedge) di atas.
    Jadikan indikator "RangeFilter" pada TF_4H sebagai acuan UTAMA Anda untuk melihat tren.
    Gunakan TF_1H dan TF_15m (SMC, RSI) untuk mencari titik masuk/keluar (entry/exit) yang lebih presisi.

    ========================================================
    FORMAT JAWABAN (HANYA JIKA DIMINTA ANALISA)
    ========================================================
    Jika pengguna bertanya tentang reversal/pullback berikan output berdasarkan Paket “Institutional Reversal Detector” dan berikan jawaban dengan bahasa trading profesional, jelas, dan praktis:
    A. Rangkuman Reversal/Pullback
       - Apakah sedang reversal valid, reversal lemah, hanya pullback, atau masih trending.
    B. Level Penting
       - Zona OB yang relevan
       - Area liquidity sweep
       - Level Fibo utama
       - Reaksi pada MA50/200
    C. KONKLUSI UNTUK HEDGING RECOVERY
       Berikan rekomendasi:
     - “Sinyal UNLOCK kuat”
     - “UNLOCK hati-hati, konfirmasi belum lengkap”
     - “Lebih baik tetap LOCK”
     - “Disarankan tambah hedge kecil (step)”
     - “Area terbaik ambil TP untuk salah satu sisi”
     - “Waspada reversal palsu”
    
    FORMAT ANALISA KOIN BARU (Hanya jika diminta secara eksplisit):
    1. Analisis Tren & Struktur SMC: Sebutkan Tren 4H, BOS/CHOCH, dan Liquidity.
    2. Rekomendasi Aksi: ENTRY LONG, ENTRY SHORT, atau HOLD (Wait and See).
    3. Titik Harga Masuk (SMC di TF Kecil):
       - Sebutkan Area Entry Ideal berdasarkan FVG atau Order Block di TF 1H atau 15m.
       - Berikan angka harga spesifik.
    4. Target Profit (TP) & Manajemen Risiko:
       - Sebutkan level TP berdasarkan Liquidity/Supply/Demand.
       - Tentukan "Harga Stop Loss / Stop Hedge" (Titik Invalidation).
    5. Rangkuman Reversal/Pullback 

    FORMAT RECOVERY POSISI (Hanya jika diminta secara eksplisit):
    1. Analisis Margin & Tren: Sebutkan Margin Ratio dan Tren 4H saat ini.
    2. Rencana Eksekusi: Jelaskan aksi (ADD/REDUCE) dan jumlah unitnya.
    3. Titik Harga Masuk (SMC di TF Kecil):
       - Sebutkan Area Entry Ideal berdasarkan FVG atau Order Block di TF 1H atau 15m.
       - Berikan angka harga spesifik.
    4. Manajemen Risiko (Stop Hedge) & BEP:
       - Tentukan "Harga Stop Hedge" (Titik Invalidation).
       - Jelaskan aksi jika harga menyentuh titik ini. INGAT: Jika posisi saat ini 2:1, aksi Stop Hedge adalah REVERT KE 1:1 dengan cara MENUTUP POSISI EKSTRA (REDUCE leg yang dominan), BUKAN menambah posisi baru.
       - Jika posisi saat ini 2:1, sebutkan di harga berapa BEP (Break Even Point) tercapai. Gunakan rumus: BEP = ((Qty_Long * Entry_Long) - (Qty_Short * Entry_Short)) / (Qty_Long - Qty_Short).
    5. Rangkuman Reversal/Pullback
    
    Format dalam PLAIN TEXT, gunakan emoji secukupnya. JANGAN gunakan Markdown (tanpa bintang, tanpa garis bawah).
  `;

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

  async function executeTrade(rawSymbol: string, rawAction: string, rawPercentage: number, targetPrice?: number, stopHedgePrice?: number, rawQty?: number) {
    const modeLabel = getValidationModeLabel();
    console.log(`[EXECUTE_TRADE] Mode: ${VALIDATION_MODE} (${modeLabel})`);
    
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
          volatilityRegime: symbolData.volatility_regime || 'NORMAL'
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
        const ok = await ensureMrGuardForAdd();
        if (!ok.ok) return ok.msg!;
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
        const ok = await ensureMrGuardForAdd();
        if (!ok.ok) return ok.msg!;
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
                undefined // rawQty not in callback data yet
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
                console.log(`\n--- TG EVENT ---`);
                console.log(`[TG UPDATE ID] ${update.update_id}`);
                console.log(`[TG MESSAGE ID] ${update.message.message_id}`);
                console.log(`[TG EXEC TRACE] Executing ${parsedText.action} on ${parsedText.extractedSymbol} via Text`);
                console.log(`----------------\n`);
                
                const resultMsg = await executeTrade(
                    parsedText.extractedSymbol, 
                    parsedText.action, 
                    parsedText.extractedPercentage || 100,
                    parsedText.extractedTargetPrice,
                    undefined, // stopHedgePrice
                    parsedText.extractedQty
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

startServer();