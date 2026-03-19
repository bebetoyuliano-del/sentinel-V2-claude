import dotenv from 'dotenv';
dotenv.config({ override: true });

import { GoogleGenAI } from '@google/genai';
import axios from 'axios';
import ccxt from 'ccxt';
import cors from 'cors';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { RSI, MACD, EMA } from 'technicalindicators';
import { Storage } from '@google-cloud/storage';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';
import path from 'path';

// Initialize Firebase Admin
let db: any = null;
try {
  const firebaseConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf8'));
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: firebaseConfig.projectId,
  });
  db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
} catch (e) {
  console.error("Failed to initialize Firebase Admin:", e);
}

import { sendDecisionCardsEmail } from './mailer';

import { rangeFilterPineExact, RFParams } from './range_filter_pine';
import { mapTfToMs, stripUnclosed, runTfAlignmentUnitTest } from './tf_alignment_guard';
import * as driftMonitor from './rf_drift_monitor';

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

// Smart Money Concepts (SMC) Simplified Calculation
function calculateSMC(ohlcv: any[]) {
  if (!Array.isArray(ohlcv) || ohlcv.length < 50) return null; // Need more data for structure
  
  const fvgs = { bullish: [] as any[], bearish: [] as any[] };
  const orderBlocks = { bullish: [] as any[], bearish: [] as any[] };
  const structure = { 
    trend: 'NEUTRAL', 
    lastBreak: null as string | null, // 'BOS_BULL', 'BOS_BEAR', 'CHOCH_BULL', 'CHOCH_BEAR'
    swingHighs: [] as number[],
    swingLows: [] as number[]
  };
  
  // 1. Calculate Fair Value Gaps (FVG)
  for (let i = 2; i < ohlcv.length; i++) {
    const high_prev2 = ohlcv[i-2][2];
    const low_prev2 = ohlcv[i-2][3];
    const high_curr = ohlcv[i][2];
    const low_curr = ohlcv[i][3];
    
    if (low_curr > high_prev2) fvgs.bullish.push({ top: low_curr, bottom: high_prev2, index: i });
    if (high_curr < low_prev2) fvgs.bearish.push({ top: low_prev2, bottom: high_curr, index: i });
  }
  fvgs.bullish = fvgs.bullish.slice(-2);
  fvgs.bearish = fvgs.bearish.slice(-2);
  
  // 2. Calculate Swing Points (Fractals)
  const swings = []; // { type: 'HIGH'|'LOW', price: number, index: number }
  
  for (let i = 2; i < ohlcv.length - 2; i++) {
    const h = ohlcv[i][2];
    const l = ohlcv[i][3];
    const isSwingHigh = h > ohlcv[i-1][2] && h > ohlcv[i-2][2] && h > ohlcv[i+1][2] && h > ohlcv[i+2][2];
    const isSwingLow = l < ohlcv[i-1][3] && l < ohlcv[i-2][3] && l < ohlcv[i+1][3] && l < ohlcv[i+2][3];
    
    if (isSwingHigh) {
      swings.push({ type: 'HIGH', price: h, index: i, open: ohlcv[i][1], close: ohlcv[i][4] });
      structure.swingHighs.push(h);
    }
    if (isSwingLow) {
      swings.push({ type: 'LOW', price: l, index: i, open: ohlcv[i][1], close: ohlcv[i][4] });
      structure.swingLows.push(l);
    }
  }

  // 3. Identify Order Blocks (Last opposing candle before the move that broke structure)
  const recentLows = swings.filter(s => s.type === 'LOW').slice(-2);
  for (const low of recentLows) {
    orderBlocks.bullish.push({ top: Math.max(low.open, low.close), bottom: low.price });
  }
  const recentHighs = swings.filter(s => s.type === 'HIGH').slice(-2);
  for (const high of recentHighs) {
    orderBlocks.bearish.push({ top: high.price, bottom: Math.min(high.open, high.close) });
  }

  // 4. Determine Market Structure (BOS / CHoCH)
  let currentTrend = 'NEUTRAL';
  let lastHigh = null;
  let lastLow = null;

  for (const swing of swings) {
    if (swing.type === 'HIGH') {
        if (lastHigh && swing.price > lastHigh.price) {
            // Higher High
            if (currentTrend === 'BEARISH') {
                structure.lastBreak = 'CHOCH_BULL';
                currentTrend = 'BULLISH';
            } else {
                structure.lastBreak = 'BOS_BULL';
                currentTrend = 'BULLISH';
            }
        }
        lastHigh = swing;
    } else if (swing.type === 'LOW') {
        if (lastLow && swing.price < lastLow.price) {
            // Lower Low
            if (currentTrend === 'BULLISH') {
                structure.lastBreak = 'CHOCH_BEAR';
                currentTrend = 'BEARISH';
            } else {
                structure.lastBreak = 'BOS_BEAR';
                currentTrend = 'BEARISH';
            }
        }
        lastLow = swing;
    }
  }
  structure.trend = currentTrend;
  
  // Keep only last 3 swing points for brevity
  structure.swingHighs = structure.swingHighs.slice(-3);
  structure.swingLows = structure.swingLows.slice(-3);

  return { fvgs, orderBlocks, structure };
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

// Helper to send Telegram message
async function sendTelegramMessage(text: string, reply_markup?: any) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  
  // Telegram limits messages to 4096 characters. We split at 4000 to be safe.
  const MAX_LENGTH = 4000;
  const messages = [];
  
  if (text.length <= MAX_LENGTH) {
    messages.push(text);
  } else {
    // Split by double newline to keep paragraphs intact if possible
    const paragraphs = text.split('\n\n');
    let currentMessage = '';
    
    for (const paragraph of paragraphs) {
      if ((currentMessage + paragraph + '\n\n').length <= MAX_LENGTH) {
        currentMessage += paragraph + '\n\n';
      } else {
        if (currentMessage) messages.push(currentMessage.trim());
        // If a single paragraph is still too long, split it by chunks
        if (paragraph.length > MAX_LENGTH) {
          let remaining = paragraph;
          while (remaining.length > 0) {
            messages.push(remaining.substring(0, MAX_LENGTH));
            remaining = remaining.substring(MAX_LENGTH);
          }
          currentMessage = '';
        } else {
          currentMessage = paragraph + '\n\n';
        }
      }
    }
    if (currentMessage) messages.push(currentMessage.trim());
  }

  try {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      // Only attach reply_markup to the last message part
      const options: any = {
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'HTML' // Enable HTML parsing for better formatting
      };
      
      if (i === messages.length - 1 && reply_markup) {
        options.reply_markup = reply_markup;
      }

      try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, options);
      } catch (htmlError: any) {
        console.warn('Failed to send HTML message, retrying as plain text:', htmlError.response?.data || htmlError.message);
        // Fallback to plain text
        delete options.parse_mode;
        // Strip HTML tags for plain text readability (basic strip)
        options.text = msg.replace(STRIP_TAGS, ''); 
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, options);
      }
      
      // Add a small delay between messages to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    console.log(`Successfully sent ${messages.length} Telegram message(s).`);
  } catch (error: any) {
    console.error('Failed to send Telegram message (Final):', error.response?.data || error.message);
  }
}

// Helper to send data to Power Automate Webhook
async function sendPowerAutomateWebhook(data: any) {
  if (!PA_WEBHOOK_URL) return;
  try {
    await axios.post(PA_WEBHOOK_URL, data);
    console.log('✅ Successfully sent data to Power Automate Webhook.');
  } catch (error: any) {
    console.error('❌ Failed to send to Power Automate Webhook:', error.response?.data || error.message);
  }
}

// Helper: upload analysis JSON ke GCS lalu kembalikan URL (public atau signed)
async function uploadAnalysisToGCS(analysisData: any, metadata: Record<string, any> = {}) {
  if (!GCS_BUCKET) {
    console.warn("⚠️ GCS upload skipped: GCS_BUCKET not set.");
    return null;
  }
  try {
    // Buat nama objek deterministik & mudah dicari
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    const sym = Array.isArray(analysisData?.decision_cards) && analysisData.decision_cards[0]?.symbol
                ? String(analysisData.decision_cards[0].symbol).replace(/[^\w\-./]/g, "_")
                : "UNSPEC";
    const objectName = `${GCS_PREFIX.replace(/\/+$/,"")}/${ts}_${sym}.json`;

    const body = JSON.stringify({
      uploaded_at: new Date().toISOString(),
      meta: metadata || {},
      analysis: analysisData
    }, null, 2);

    let url: string | null = null;

    const storage = new Storage(); // gunakan ADC/GOOGLE_APPLICATION_CREDENTIALS
    const bucket = storage.bucket(GCS_BUCKET);

    const file = bucket.file(objectName);

    await file.save(body, {
      resumable: false,
      contentType: "application/json; charset=utf-8",
      metadata: { cacheControl: "no-store" }
    });

    // Karena bucket tidak bisa dibuat public (Org Policy), kita SELALU gunakan Signed URL
    // Signed URL v4 (GET) dengan TTL dari env
    const [signed] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + (Math.max(60, GCS_SIGNED_URL_TTL) * 1000) // min 60s
    });
    url = signed;

    console.log("✅ GCS uploaded:", objectName);
    return { objectName, url };
  } catch (e: any) {
    const errorMsg = e.message || e;
    console.error(`❌ GCS upload failed: ${errorMsg}`);
    if (errorMsg.includes('storage.objects.create')) {
      console.error(`💡 ACTION REQUIRED: The service account 'ais-sandbox@ais-asia-southeast1-7ebde40c3e.iam.gserviceaccount.com' does not have permission to create objects in bucket '${GCS_BUCKET}'. Please grant it the 'Storage Object Creator' role in the Google Cloud Console.`);
    }
    return null;
  }
}

// Helper to fetch market data with technical indicators
async function fetchMarketDataWithIndicators(symbols: string[]) {
  const marketData: any = {};
  
  // Use Promise.all to fetch data in parallel (limited to 5 concurrent requests to avoid rate limits)
  const chunkArray = (arr: string[], size: number) => 
    Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
  
  const chunks = chunkArray(symbols, 5);
  
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (pair) => {
      try {
        const [ohlcv1d, ohlcv4h, ohlcv1h, ohlcv15m] = await Promise.all([
          binance.fetchOHLCV(pair, '1d', undefined, 100),
          binance.fetchOHLCV(pair, '4h', undefined, 1000),
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
        const macd1H = MACD.calculate({ values: closes1h, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
        const smc1H = calculateSMC(validOhlcv1h);
        const vwap1h = calculateVWAP(validOhlcv1h);
        const vwap1h_dist = vwap1h ? ((ticker.last - vwap1h) / vwap1h) * 100 : null;
        
        // 15m Calculations (Short Entry/Exit & SMC)
        const tf15mMs = mapTfToMs('15m');
        const strip15m = stripUnclosed(ohlcv15m, tf15mMs, nowMs);
        const validOhlcv15m = strip15m.strippedOhlcv;
        
        const closes15m = validOhlcv15m.map(c => c[4] as number);
        const rsi15m = RSI.calculate({ values: closes15m, period: 14 });
        const smc15m = calculateSMC(validOhlcv15m);
        
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
            VWAP: vwap4h,
            VWAP_dist_pct: vwap4h_dist,
            ATR14: atr14_4h ?? null
          },
          TF_1H: {
            VWAP: vwap1h,
            VWAP_dist_pct: vwap1h_dist,
            RSI_14: rsi1H.length > 0 ? rsi1H[rsi1H.length - 1] : null,
            MACD: macd1H.length > 0 ? macd1H[macd1H.length - 1] : null,
            SMC: smc1H,
            ATR14: atr14_1h ?? null
          },
          TF_15m: {
            RSI_14: rsi15m.length > 0 ? rsi15m[rsi15m.length - 1] : null,
            SMC: smc15m
          }
        };
      } catch (e) {
        console.error(`Error fetching data for ${pair}:`, e);
      }
    }));
  }
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
async function generateWithRetry(prompt: string, modelName: string = 'gemini-3.1-pro-preview', maxRetries: number = 3, jsonMode: boolean = false) {
  const ai = getAI();
  let attempt = 0;
  
  // First try with the requested model (e.g. Pro)
  while (attempt < maxRetries) {
    try {
      const config: any = {
        model: modelName,
        contents: prompt,
      };
      
      if (jsonMode) {
        config.config = { responseMimeType: 'application/json' };
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
        contents: prompt,
      };
      
      if (jsonMode) {
        config.config = { responseMimeType: 'application/json' };
      }

      const response = await ai.models.generateContent(config);
      return response.text;
    } catch (error: any) {
      console.error('Fallback model (gemini-3-flash-preview) also failed:', error.message || error);
      
      // Try one more fallback: gemini-2.0-flash-exp
      console.log('Falling back to gemini-2.0-flash-exp...');
      try {
        const config: any = {
          model: 'gemini-2.0-flash-exp',
          contents: prompt,
        };
        
        if (jsonMode) {
          config.config = { responseMimeType: 'application/json' };
        }

        const response = await ai.models.generateContent(config);
        return response.text;
      } catch (error2: any) {
        console.error('Second fallback model (gemini-2.0-flash-exp) also failed:', error2.message || error2);
      }
    }
  }

  throw new Error(`Failed to get response from Gemini after all attempts.`);
}

// --- EXCEL ROWS BUILDER (A-D) ---
type Ohlcv = [number, number, number, number, number, number]; // ts,o,h,l,c,v

function atr14Last(ohlcv: Ohlcv[]): number | null {
  const n = 14;
  if (!ohlcv || ohlcv.length < n + 1) return null;
  const highs = ohlcv.map(c => c[2]);
  const lows  = ohlcv.map(c => c[3]);
  const closes= ohlcv.map(c => c[4]);

  const tr: number[] = [0];
  for (let i = 1; i < ohlcv.length; i++) {
    const h = highs[i], l = lows[i], pc = closes[i - 1];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = tr[1];
  for (let i = 2; i <= n; i++) atr = (atr * (n - 1) + tr[i]) / n;
  for (let i = n + 1; i < tr.length; i++) atr = (atr * (n - 1) + tr[i]) / n;
  return atr || null;
}

function deriveVolatilityRegime(atrPct: number | null | undefined) {
  if (atrPct == null) return '';
  if (atrPct < 1.0)  return 'LOW';
  if (atrPct <= 2.5) return 'NORMAL';
  return 'HIGH';
}

type PerSide = { qty: number; entry: number; pnl: number; bep?: number|null; liq?: number|null; marginUsed?: number|null; };
type PerSymbolPos = {  long: PerSide; short: PerSide;  netQtyUSDT: number | null; netDirection: 'NET_LONG'|'NET_SHORT'|'LOCKED'; netBEP: number | null;};

function mapPositionsForSymbol(allPositions: any[], symbol: string, lastPrice?: number): PerSymbolPos {
  const same = (p: any) => p.symbol === symbol;
  const longPos  = allPositions.find((p: any) => same(p) && (p.side === 'long' || (p.side === 'both' && parseFloat(p.info.positionAmt) > 0)));
  const shortPos = allPositions.find((p: any) => same(p) && (p.side === 'short' || (p.side === 'both' && parseFloat(p.info.positionAmt) < 0)));
  const long: PerSide = {
    qty: longPos ? Math.abs(longPos.contracts) : 0,
    entry: longPos?.entryPrice ?? 0,
    pnl: longPos?.unrealizedPnl ?? 0,
    bep: longPos?.entryPrice ?? null,
    liq: longPos?.liquidationPrice ?? longPos?.info?.liquidationPrice ?? null,
    marginUsed: longPos?.initialMargin ?? longPos?.info?.initialMargin ?? null
  };
  const short: PerSide = {
    qty: shortPos ? Math.abs(shortPos.contracts) : 0,
    entry: shortPos?.entryPrice ?? 0,
    pnl: shortPos?.unrealizedPnl ?? 0,
    bep: shortPos?.entryPrice ?? null,
    liq: shortPos?.liquidationPrice ?? shortPos?.info?.liquidationPrice ?? null,
    marginUsed: shortPos?.initialMargin ?? shortPos?.info?.initialMargin ?? null
  };
  let netQtyUSDT: number | null = null;
  if (lastPrice && (long.qty > 0 || short.qty > 0)) {
    netQtyUSDT = Math.abs(long.qty - short.qty) * lastPrice;
  }
  const netDirection = long.qty === short.qty ? 'LOCKED' : (long.qty > short.qty ? 'NET_LONG' : 'NET_SHORT');
  let netBEP: number | null = null;
  if (long.qty === short.qty && long.qty > 0) {
    netBEP = (long.entry + short.entry) / 2;
  } else if (long.qty !== short.qty && long.entry && short.entry) {
    const longNotional  = long.entry  * long.qty;
    const shortNotional = short.entry * short.qty;
    const diffContracts = (long.qty - short.qty);
    if (diffContracts !== 0) netBEP = (longNotional - shortNotional) / diffContracts;
  }
  return { long, short, netQtyUSDT, netDirection, netBEP };
}

function deriveBiasStrength4H(trend4h: string | null | undefined, waeExploding?: boolean | null) {
  if (!trend4h || trend4h.toUpperCase() === 'NEUTRAL' || trend4h.toUpperCase() === 'NETRAL') return 'RANGE';
  const strong = !!waeExploding;
  if (trend4h.toUpperCase() === 'UP')   return strong ? 'STRONG_UP' : 'WEAK_UP';
  if (trend4h.toUpperCase() === 'DOWN') return strong ? 'STRONG_DOWN' : 'WEAK_DOWN';
  return 'RANGE';
}

function deriveBiasStrength1H(structure1h: string | null | undefined) {
  const s = (structure1h || '').toUpperCase();
  if (!s) return 'RANGE';
  if (s.includes('BOS') || s.includes('CHOCH')) {
    return s.includes('_BULL') ? 'STRONG_UP' : 'STRONG_DOWN';
  }
  return 'RANGE';
}

function deriveActionRiskType(action?: string, mrDelta?: number | null) {
  if (!action) return 'NEUTRAL';
  const A = action.toUpperCase();
  if (A.startsWith('LOCK')) return 'LOCK';
  if (A.startsWith('TAKE')) return 'DE_RISK';
  if (A.startsWith('ADD') || A === 'HEDGE_ON' || A === 'ROLE') return 'EXPAND';
  if (typeof mrDelta === 'number') return mrDelta < 0 ? 'DE_RISK' : (mrDelta > 0 ? 'EXPAND' : 'NEUTRAL');
  return 'NEUTRAL';
}

function deriveRiskTag(accountMrDecimal?: number | null, mrDelta?: number | null): 'CRITICAL'|'HIGH'|'NORMAL'|'LOW'|'' {
  if (accountMrDecimal == null) return '';
  if (accountMrDecimal >= 0.60) return 'CRITICAL';
  if (accountMrDecimal >= 0.25) return 'HIGH';
  if (typeof mrDelta === 'number' && mrDelta > 0) return 'HIGH';
  if (accountMrDecimal < 0.15) return 'LOW';
  return 'NORMAL';
}

type ExcelRow = {
  Ts: string; Symbol: string; Timeframe: string;
  Bias4H: string; BiasStrength4H: string; Bias1H: string; BiasStrength1H: string;
  ATR4H: number | ''; ATR1H: number | ''; VolatilityRegime: string;
  Pivot: number | ''; StopHedge: number | '';
  SupplyLow: number | ''; SupplyHigh: number | '';
  DemandLow: number | ''; DemandHigh: number | '';
  KeyLevel1: number | ''; KeyLevel2: number | ''; ZoneQuality: string;
  LongQty: number | ''; LongEntry: number | ''; LongPnL: number | '';
  LongBEP: number | ''; LongLiqPrice: number | ''; LongMarginUsed: number | '';
  ShortQty: number | ''; ShortEntry: number | ''; ShortPnL: number | '';
  ShortBEP: number | ''; ShortLiqPrice: number | ''; ShortMarginUsed: number | '';
  NetQtyUSDT: number | ''; NetDirection: string; NetBEP: number | ''; RatioHint: string;
  'AccountMR%': number | ''; 'MR%': string | ''; MRProjected: number | '';
  MRDeltaIfAction: number | ''; PairRiskWeight: number | ''; RiskTag: string;
  Action: string; StrategyMode: string; RecoveryPhase: string; ActionRiskType: string;
  ActionSuggested: string; Status: string; Notes: string;
  ArchiveKey: string; SourceEmailId: string; FileName: string;
};

function composeExcelRows(params: {
  cards: any[]; positions: any[]; marketData: any; accountRisk: any;
}): ExcelRow[] {
  const rows: ExcelRow[] = [];
  const accMrPct = params?.accountRisk?.marginRatio ?? null; // % 0..100
  const accMrDecimal = accMrPct != null ? accMrPct / 100 : null;
  const wallet = params?.accountRisk?.walletBalance ?? null;
  for (const c of (params.cards || [])) {
    const symbol = (c.symbol || '').split(':')[0]; // "BASE/USDT"
    const md = params.marketData[symbol] || params.marketData[`${symbol}:USDT`] || {};
    const md4 = md?.TF_4H || {};
    const md1 = md?.TF_1H || {};
    const priceNow = md?.currentPrice ?? null;
    const per = mapPositionsForSymbol(params.positions, symbol, priceNow);
    const bias4h = (c?.structure?.trend_4h || 'NETRAL').toString().toUpperCase().replace('NEUTRAL','NETRAL');
    const bias1h = (c?.structure?.smc_1h?.structure || 'UNKNOWN').toString().toUpperCase();
    const bs4h   = deriveBiasStrength4H(bias4h, md4?.WAE?.isExploding ?? null);
    const bs1h   = deriveBiasStrength1H(bias1h);
    const atr4h = md4?.ATR14 ?? null;
    const atr1h = md1?.ATR14 ?? null;
    const atrPct4h = (atr4h && priceNow) ? (atr4h / priceNow) * 100 : null;
    const volReg = deriveVolatilityRegime(atrPct4h);
    const pivot   = (c?.levels?.pivot ?? md4?.RQK_Channel?.estimate ?? null);
    const stopHdg = (c?.levels?.stop_hedge_lock ?? null);
    const supplyLo = c?.levels?.supply?.zone?.[0] ?? '';
    const supplyHi = c?.levels?.supply?.zone?.[1] ?? '';
    const demandLo = c?.levels?.demand?.zone?.[0] ?? '';
    const demandHi = c?.levels?.demand?.zone?.[1] ?? '';
    const ratioHint = c?.positions?.ratio_hint ?? 'OTHER';
    const netQtyUSDT = per.netQtyUSDT ?? '';
    const netDir = per.netDirection;
    const netBEP = per.netBEP ?? '';
    const mrProjectedPct = typeof c?.action_now?.mr_projected_if_action === 'number'
      ? c.action_now.mr_projected_if_action
      : '';
    const mrDelta = (typeof mrProjectedPct === 'number' && accMrPct != null)
      ? (mrProjectedPct/100 - accMrPct/100)
      : '';
    const pairWeight = (wallet && priceNow && (per.long.qty || per.short.qty))
      ? (((per.long.qty * priceNow) + (per.short.qty * priceNow)) / wallet)
      : '';
    const action = c?.action_now?.action || c?.action || 'HOLD';
    const actRisk = deriveActionRiskType(action, typeof mrDelta === 'number' ? mrDelta : null);
    const riskTag = deriveRiskTag(accMrDecimal, typeof mrDelta === 'number' ? mrDelta : null);
    const tsIso = new Date().toISOString();
    const archiveKey = `${tsIso}|${symbol}|4H`;
    rows.push({
      Ts: tsIso,
      Symbol: symbol,
      Timeframe: '4H',
      Bias4H: bias4h,
      BiasStrength4H: bs4h,
      Bias1H: bias1h,
      BiasStrength1H: bs1h,
      ATR4H: atr4h ?? '',
      ATR1H: atr1h ?? '',
      VolatilityRegime: volReg,
      Pivot: pivot ?? '',
      StopHedge: stopHdg ?? '',
      SupplyLow: supplyLo,
      SupplyHigh: supplyHi,
      DemandLow: demandLo,
      DemandHigh: demandHi,
      KeyLevel1: '', KeyLevel2: '', ZoneQuality: '',
      LongQty: per.long.qty || '',
      LongEntry: per.long.entry || '',
      LongPnL: per.long.pnl || '',
      LongBEP: per.long.bep ?? '',
      LongLiqPrice: per.long.liq ?? '',
      LongMarginUsed: per.long.marginUsed ?? '',
      ShortQty: per.short.qty || '',
      ShortEntry: per.short.entry || '',
      ShortPnL: per.short.pnl || '',
      ShortBEP: per.short.bep ?? '',
      ShortLiqPrice: per.short.liq ?? '',
      ShortMarginUsed: per.short.marginUsed ?? '',
      NetQtyUSDT: netQtyUSDT,
      NetDirection: netDir,
      NetBEP: netBEP,
      RatioHint: ratioHint,
      'AccountMR%': accMrDecimal ?? '',
      'MR%': (accMrPct != null) ? `${accMrPct.toFixed(2)}%` : '',
      MRProjected: typeof mrProjectedPct === 'number' ? mrProjectedPct : '',
      MRDeltaIfAction: typeof mrDelta === 'number' ? mrDelta : '',
      PairRiskWeight: pairWeight || '',
      RiskTag: riskTag,
      Action: action,
      StrategyMode: c?.strategy_mode || 'RECOVERY',
      RecoveryPhase: c?.recovery_phase || 'PHASE_1',
      ActionRiskType: actRisk,
      ActionSuggested: '',
      Status: '',
      Notes: '',
      ArchiveKey: archiveKey,
      SourceEmailId: '',
      FileName: ''
    });
  }
  return rows;
}
// --- END EXCEL ROWS BUILDER ---

// Core monitoring function
async function monitorMarkets() {
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

    const symbolsToFetch = [...new Set([...positionSymbols, ...top20Symbols])];
    
    const marketData = await fetchMarketDataWithIndicators(symbolsToFetch);
    const hedgingRecovery = calculateHedgingRecovery(positions);
    const accountRisk = await fetchAccountRisk();

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
        marketData,
        recentHistory: signals.slice(0, 5), // Include last 5 signals for self-supervision
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

      DATA MASUK:
      ${JSON.stringify(inputPayload, null, 2)}

      TUGAS 1: MONITORING POSISI AKUN (FOKUS UTAMA)
      Anda mengubah data pasar & portofolio dari 'accountPositions' menjadi:
      (1) DECISION CARD 1-LAYAR per pair (siap lihat → klik),
      (2) SOP skenario (rejection / break&retest up/down / invalidation),
      (3) Paket ENFORCEMENT untuk server (validasi stop‑lock, MR projected per aksi, dan alerts deterministik).

      TUGAS 2: TOP 20 SCANNER (SINYAL TAMBAHAN)
      HANYA JIKA accountRisk.marginRatio < 25%, pilih 1–2 koin dari 'scannerUniverse' dengan setup PALING SEMPURNA.
      Jika MR >= 25%, TUGAS 2 DIABAIKAN (kosongkan new_signals).

      BAHASA & OUTPUT
      - Gunakan BAHASA INDONESIA.
      - OUTPUT HARUS valid JSON PERSIS sesuai KONTRAK di bawah (TANPA teks lain di luar JSON).
      - Urutkan decision_cards A→Z berdasarkan symbol.

      ATURAN WAJIB TUGAS 1 (HARUS DIIKUTI TANPA PELANGGARAN):
      1) FOKUS AKUN:
         - WAJIB buatkan 1 decision_card untuk SETIAP symbol yang ada di 'accountPositions'.
         - DILARANG membuat decision_card untuk koin di 'scannerUniverse' yang TIDAK memiliki posisi di 'accountPositions'.
         - Fokus analisa adalah mengelola risiko dan profitabilitas posisi yang sedang berjalan.
      1) GUARD MODE (MR% > mr_guard_pct):
         - Dilarang: ADD_LONG (AL), ADD_SHORT (AS), HEDGE_ON (HO), ROLE (RR).
         - Diperbolehkan: HOLD, REDUCE_LONG (RL), REDUCE_SHORT (RS), LOCK_NEUTRAL (LN),
           UNLOCK (UL) *hanya jika mengurangi exposure & hedge sudah Hijau/BE*, TAKE_PROFIT (TP).
         - Prioritas saat GUARD:
           1) TAKE_PROFIT leg hijau yang MENURUNKAN MR (wajib tampilkan MR projected),
           2) HOLD bila belum ada trigger invalidation,
           3) LOCK_NEUTRAL hanya bila syarat LN terpenuhi (lihat poin 3),
           4) REDUCE leg yang melawan tren jika benar‑benar menurunkan MR tanpa membuka risiko lebih besar.

      2) STOP_HEDGE_LOCK (LOCK kembali 1:1) – WAJIB = invalidation swing TF 1H + buffer ATR:
         - Jika trend_4h = UP → stop_hedge_lock = swingLow_1H − (params.unlock_buffer_atr × ATR14_4H), dibulatkan wajar.
         - Jika trend_4h = DOWN → stop_hedge_lock = swingHigh_1H + (params.unlock_buffer_atr × ATR14_4H).
         - Larangan: stop_hedge_lock TIDAK BOLEH berada di zona SUPPLY saat tren UP atau di zona DEMAND saat tren DOWN.
         - Jika ATR14_4H null → fallback: pakai swing level (tanpa ATR) atau buffer kecil berbasis % harga (mis. 0.2%).

      3) LOCK_NEUTRAL (LN) saat GUARD_NO_ADD hanya jika SALAH SATU benar:
         (a) Harga menyentuh/menembus stop_hedge_lock (invalidation kena), ATAU
         (b) MR% projected setelah LN TIDAK > 25%, ATAU
         (c) Drawdown leg utama “ekstrem” (mis. unrealizedPnL_leg_utama ≤ −40% dari notional leg)
             DAN harga berada ≤ 1 × ATR14_4H dari stop_hedge_lock (dekat invalidation).
         Jika tak terpenuhi → ACTION: HOLD (atau TP bila ada leg hijau yang menurunkan MR).

      4) UNLOCK (UL) hanya jika:
         - Hedge_leg unrealizedPnL ≥ 0 (atau ~Break Even; toleransi ±0.2% notional),
         - Konfluensi 4H pro‑bias minimal 2/3 (rf_ok + rqk_ok + wae_ok; vwap_ok opsional),
         - MR% ≤ mr_guard_pct ATAU MR% projected setelah UNLOCK tidak > 20%.
         Bila belum terpenuhi → HOLD.

      5) KONFLUENSI (TF 4H):
         - rf_ok: RangeFilter.trend selaras arah (BUY=UP, SELL=DOWN),
         - rqk_ok: price > rqk.estimate untuk BUY; price < rqk.estimate untuk SELL,
         - wae_ok: WAE.trend selaras arah; bonus jika isExploding = true,
         - vwap_ok (opsional): BUY valid jika VWAP_dist_pct ≥ +params.vwap_delta_pct; SELL valid jika ≤ −params.vwap_delta_pct.
         - Minimal konfluensi inti: 2 dari 3 (rf_ok, rqk_ok, wae_ok). vwap_ok hanya penambah bobot.

      6) BREAK & RETEST (SOP & ALERTS):
         - Invalidation: swing lawan arah TF 1H (swingLow untuk bullish; swingHigh untuk bearish).
         - Break valid: jarak tembus ≥ params.k_atr × ATR14_4H (jika ATR tersedia).
           Fallback bila ATR null: RF 4H flip + WAE exploding lawan + VWAP_dist menembus 2 × params.vwap_delta_pct.
         - Retest valid: harga kembali uji level tembus & reject (1–3 candle).

      7) EKONOMI TOMBOL (server safe-by-design):
         - Saat GUARD_NO_ADD → AL/AS/HO/RR WAJIB masuk “buttons.block”.
         - UL “allowed” hanya jika syarat UNLOCK (poin 4) terpenuhi.
         - LN “allowed” hanya jika syarat LN (poin 3) terpenuhi; jika tidak, beri alasan penolakan & sarankan HOLD/TP.

      8) RECOVERY BY ZONE SEBAGAI SOP UTAMA & ADVANCED TECHNIQUES:
         - Strategi Recovery ini menggunakan konsep "Recovery by Zone (Supply–Demand–Pivot–StopHedge)" sebagai SOP utama.
         - Menyesuaikan strategi: SupplyHigh/Low → zona jual ideal, DemandHigh/Low → zona beli ideal, Pivot → equilibrium untuk reduce, StopHedge → invalidasi lock.
         - Pola Zone Strategy: Lock at Extremes, Release at Pivot, Reduce di Mid-Range, Add di Edge, Hold Lock jika harga di tengah, Recovery mode jika harga kembali ke Demand/Supply.
         - Terapkan juga keahlian inti berikut jika posisi dalam status RECOVERY:
         - A. LOCKING STANDARD: Gunakan Full/Partial Lock untuk menetralisir risiko. Evaluasi apakah lock menurunkan MR atau mencegah kerusakan lebih dalam. Hindari over-hedging.
         - B. HEDGING STEP: Gunakan Step-by-Step Recovery. Susun urutan step yang aman (misal: Reduce dulu → Add kecil → Lock → Unlock di zone tertentu). Perhatikan efek pada MR Projected.
         - C. EXPOSURE BALANCING & MR GUARD: Netralkan posisi yang terlalu berat ke satu sisi berdasarkan zona. TOLAK aksi yang menaikkan MR ≥ 25%.
         - D. DYNAMIC UNLOCK: Buka lock secara bertahap di zone aman, hindari panic unlock.
         - E. SECOND OPINION: Selalu evaluasi aksi dari sudut Risiko, Zona, Bias trend, MR, dan Floating structure.

      TUGAS 2: TOP 20 SCANNER (NEW)
      Dari data "universe" (Top 20), pilih 1–2 koin dengan setup PALING SEMPURNA menurut:
      • Range Filter (TF 4H) — kondisi “awal trend / flip” yang kredibel.
      • SMC (TF 1H) — harga berada/menyentuh area OB/FVG yang relevan (demand untuk BUY, supply untuk SELL).
      Keluarkan sinyal trading baru (BUY/SELL) berisi ENTRY, TARGET, dan STOP LOSS (SL), HANYA jika Margin Ratio (MR) akun < 25%.

      ATURAN PENILAIAN TUGAS 2 (WAJIB):
      1) GATE MR:
         - Jika accountRisk.marginRatio >= mr_guard_pct (default 25) → JANGAN keluarkan sinyal baru.
           Hanya keluarkan "risk_warning" dan "watchlist_candidates" (maks 3).
         - Jika MR < 25 → boleh keluarkan sinyal baru (maksimal 2).

      2) DETEKSI “AWAL TREND / FLIP” (RF 4H):
         - rf_flip_ok: RangeFilter TF_4H ≠ RangeFilter TF_1D, ATAU RangeFilter TF_4H baru saja berganti.
         - wae_ok: WAE TF_4H trend selaras arah sinyal & isExploding = true.
         - rqk_ok (bonus): harga di sisi yang benar dari RQK estimate.
         - Minimal konfluensi: rf_flip_ok + (wae_ok ATAU rqk_ok).

      3) VALIDASI SMC (TF 1H):
         - BUY: harga di/tepat di atas zona demand OB/FVG.
         - SELL: harga di/tepat di bawah zona supply OB/FVG.
         - Toleransi kedekatan: max(0.2%, 0.25×ATR14_4H / price).

      4) FORMULA LEVEL SINYAL:
         - ENTRY: Limit di mid zona OB/FVG 1H.
         - SL: BUY di bawah bottom demand - buffer; SELL di atas top supply + buffer.
         - TARGET 1: Pivot RQK 4H atau tepi zona berlawanan terdekat.
         - TARGET 2: RR minimal 1.8–2.2.

      5) FILTER AKHIR:
         - Skor 0–100 (40% RF flip, 30% SMC, 20% RQK/VWAP, 10% RR).
         - Pilih MAKS 2 terbaik.

      8) MR PROJECTED:
         - Untuk aksi yang mengubah exposure (TP/RL/RS/LN/UL), isi “mr_projected_if_action”.
           Jika > 25% → tandai action “risk_denied”: true.

      9) NORMALISASI SYMBOL:
         - Selalu output "symbol" dalam format "BASE/USDT" (contoh: "BTC/USDT"). DILARANG memakai "BTCUSDT" tanpa slash.

      10) TIMESTAMP:
         - telemetry.generated_at = waktu SAAT INI (UTC ISO‑8601).

      INPUT DATA (JSON):
      ${JSON.stringify(inputPayload, null, 2)}

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
                          "swing_high": number|null, "swing_low": number|null },
              "atr14_4h": number|null
            },
            "levels": {
              "supply": { "from":"OB|FVG|SWING|MANUAL", "zone":[number,number]|null },
              "demand": { "from":"OB|FVG|SWING|MANUAL", "zone":[number,number]|null },
              "pivot": number|null,
              "stop_hedge_lock": number|null
            },
            "action_now": {
              "action": "HOLD"|"REDUCE_LONG"|"REDUCE_SHORT"|"LOCK_NEUTRAL"|"UNLOCK"|"TAKE_PROFIT",
              "percentage": number,
              "target_price": "Market"|number|null,
              "reason": "string <= 300 chars",
              "mr_guard": "ALLOW"|"DENY",
              "unlock_allowed": boolean,
              "mr_projected_if_action": number|null,
              "risk_denied": boolean
            },
            "if_then": {
              "if_price_up_to":   [ { "level": number, "do": "HOLD|TAKE_PROFIT|REDUCE_LONG|REDUCE_SHORT", "note":"<=120 chars" } ],
              "if_price_down_to": [ { "level": number, "do": "HOLD|LOCK_NEUTRAL|REDUCE_LONG|REDUCE_SHORT", "note":"<=120 chars" } ]
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
            "then_actions":["REDUCE_LONG","HOLD"],
            "notes":"Gunakan reduce untuk menurunkan MR. LN hanya saat trigger LN terpenuhi."
          },
          { "name":"BREAK_RETEST_DOWN",
            "when":"Break turun invalidation (>= k_atr×ATR14 atau fallback) + retest gagal.",
            "then_actions":["LOCK_NEUTRAL","HOLD"],
            "notes":"Setelah LN, tunggu konfirmasi. ROLE dilarang saat GUARD."
          },
          { "name":"BREAK_RETEST_UP",
            "when":"Break di atas swing/supply + retest hold + konfluensi 4H ≥ 2/3.",
            "then_actions":["HOLD","UNLOCK"],
            "notes":"UNLOCK bertahap; hindari jika hedge masih merah."
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
        k_atr=0.50, unlock_buffer_atr=0.25, vwap_delta_pct=0.10, hedge_ratio=2.0, mr_guard_pct=15.0.

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

      GUARD & ACTION NOW:
      - global_guard.mr_guard_pct = NILAI INPUT (atau default 15). Mode = GUARD_NO_ADD bila mr_pct > mr_guard_pct; NORMAL bila sebaliknya.
      - Saat GUARD_NO_ADD, "buttons.block" WAJIB memuat AL, AS, HO, RR. UL/LN ikut diblok jika syaratnya tidak terpenuhi.
      - UNLOCK allowed hanya jika hedge hijau/BE + konfluensi pro‑bias ≥ 2/3 + aturan MR terpenuhi.
      - LOCK_NEUTRAL allowed hanya jika trigger LN terpenuhi (invalidation kena ATAU MR projected ≤ 25% ATAU drawdown ekstrem & dekat invalidation).

      [ADDENDUM_ID]: HEDGE_NORMALIZATION_V2
      [MODE]: SAFE_MERGE
      [PRIORITY]: lower_than_base
      [CONFLICT_RESOLUTION]: if conflict -> prefer BASE, except "DefensiveNormalizationExemption"

      SCOPE:
      - Menambah aturan "ALLOWED — Defensive Normalization" dengan preferensi sizing berbasis MR.
      - Menambah skenario "POST HEDGE 1:1 (STABILITY MODE)" tanpa mengubah skema output base.
      - Tidak menghapus, mengganti, atau menonaktifkan guard lain yang sudah ada.

      DEFENSIVE NORMALIZATION EXEMPTION (KHUSUS):
      - Pengecualian NO-ADD diperbolehkan khusus untuk "penambahan sisi hedge" yang tujuannya mengurangi net exposure (mendekatkan ke 1:1) DAN
        MR SETELAH AKSI tidak melebihi 25% (atau tidak naik dari MR saat ini).
      - Jika estimasi MR_after tidak tersedia, tandai status "CONDITIONAL" dan sertakan "pre_trade_check_required": true pada output.

      A) ALLOWED — DEFENSIVE NORMALIZATION (dengan preferensi MR dari user)
      TRIGGER UMUM (harus memenuhi SEMUA):
      1) HedgeRatio ≠ "1:1_NEUTRAL"  (masih miring/net bias)
      2) Tujuan tindakan → mendekat ke 1:1 (bukan menjauh)
      3) Minimal SATU kondisi risiko terpenuhi:
         - MR mendekati/di atas soft cap BASE, atau
         - Kedua leg merah, atau
         - Harga berada di/near HTF supply atau terdapat tanda impulse exhaustion, atau
         - Early warning struktur (mis. h1_choch_bear = true)
      4) Aksi tidak menghapus hedge yang merah secara penuh (partial allowed).

      PREFERENSI SIZING BERDASARKAN MR (HARUS DIIKUTI):
      - Jika MR < 25%:
        → **Pilih "ADD SHORT untuk menyamai"** (meningkatkan short agar mendekati 1:1).
        → Ukuran langkah (step) = 25–35% dari GapQty (bukan sekaligus 100%).
        → Syarat: MR_after ≤ 25% DAN tidak lebih tinggi dari MR_current. Jika tidak pasti → status "CONDITIONAL" + pre_trade_check_required:true.

      - Jika MR > 25%:
        → **Pilih "REDUCE sisi dominan"** (jika net long, reduce LONG; jika net short, reduce SHORT).
        → Ukuran langkah (step) = 20–35% dari GapQty.
        → Tujuan: menurunkan MR dengan cepat sambil tetap menjaga hedge aktif.

      B) DECISION CARD — POST HEDGE 1:1 (STABILITY MODE)
      CONDITION: HedgeRatio == "1:1_NEUTRAL"
      DEFAULT: primary: "HOLD", status: "ALLOWED", do: "Tunggu konfirmasi arah, tidak add, tidak unlock"

      SCENARIO A — RE-ENGAGE LONG (CONDITIONAL):
      Semua harus benar:
      1) H1 bullish & tidak ada h1_choch_bear
      2) acceptance_above_supply == true (reclaim/PDH acceptance)
      3) Price menahan di atas equilibrium setelah retest
      4) MR < soft cap BASE (mis. < 18%)
      → ACTION: primary: "RE-ENGAGE_LONG", status: "CONDITIONAL", do: tambah long kecil (10–20% dari base), **tetap pertahankan short** (tidak remove)

      SCENARIO B — RANGE (ALLOWED HOLD):
      structure.range_mode == true ATAU tidak ada konfirmasi arah
      → ACTION: primary: "HOLD", status: "ALLOWED", do: biarkan hedge menyerap noise

      SCENARIO C — DEFENSIVE REDUCE LONG (CONDITIONAL/ALLOWED):
      Minimal 2 terpenuhi:
      - h1_choch_bear == true
      - h1_bos_bear == true
      - Close di bawah equilibrium / gagal reclaim
      - Tanda breakdown demand
      → ACTION: primary: "DEFENSIVE_REDUCE_LONG", status: "CONDITIONAL" (atau "ALLOWED" bila MR ≥ soft cap), do: reduce long 20–30%, jaga short aktif

      [ADDENDUM_ID]: TOP_20_VOLUME_SIGNALS
      [MODE]: SAFE_MERGE
      [PRIORITY]: high
      
      SCOPE:
      - Sinyal yang difilter untuk dianalisa (new_signals) HARUS berasal dari 20 pair dengan volume harian (daily volume) terbesar di Binance Futures ('scannerUniverse').
      - Ambil HANYA SATU atau beberapa sinyal TERBAIK dari 20 pair tersebut.
      - Sinyal HANYA BOLEH diberikan/dihasilkan JIKA Margin Ratio (MR) saat ini DI BAWAH 25%. Jika MR >= 25%, kosongkan array new_signals.

      STRICT OUTPUT:
      - Keluarkan JSON saja sesuai kontrak; TIDAK BOLEH ada teks di luar JSON.
      - WAJIB buatkan 1 decision_card untuk setiap symbol yang ada di 'accountPositions'. JANGAN buatkan decision_card untuk koin scanner kecuali koin tersebut juga ada di posisi akun.
      - new_signals diisi berdasarkan scanning Top 20.
      - Untuk tombol (buttons.show), label WAJIB menyertakan nama pair agar jelas (contoh: "RL BTC", "HOLD ETH").
    `;

    // Switched to gemini-3-flash-preview for better stability
    const analysisJson = await generateWithRetry(prompt, 'gemini-3-flash-preview', 3, true);
    
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
            analysisData = JSON.parse(cleanJson);
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
    
    const cards = analysisData.decision_cards || [];
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

    const payloads = renderDecisionCardsToTelegram(cards, se, gg, new_signals, archiveUrl);

    for (const payload of payloads) {
        await sendTelegramMessage(payload.text, payload.reply_markup);
        
        const newSignal = {
          id: Date.now().toString() + Math.random().toString(36).substring(7),
          timestamp: new Date().toISOString(),
          content: payload.text.replace(STRIP_TAGS, ''),
          type: 'telegram',
          symbol: new_signals?.signals?.[0]?.symbol || 'GENERAL'
        };
        signals.unshift(newSignal);
        
        if (db) {
          try {
            await db.collection('signals').doc(newSignal.id).set(newSignal);
          } catch (dbErr) {
            console.error("Failed to save signal to Firestore:", dbErr);
          }
        }
    }
    
    if (signals.length > 50) signals.splice(50);

  } catch (error) {
    console.error('Error in monitorMarkets:', error);
    throw error;
  }
}

// =========================================================
// TELEGRAM HELPERS
// =========================================================

export function normalizeSymbolInput(rawSymbol?: string): string {
    if (!rawSymbol) return "";
    let s = rawSymbol.toUpperCase().trim();
    // Remove any existing /USDT or USDT suffix to get the base
    s = s.replace(/\/USDT$/, '').replace(/USDT$/, '').replace(/:USDT$/, '');
    return `${s}/USDT`;
}

export function normalizeActionInput(rawAction: string): { action: string, extractedSymbol?: string, extractedPercentage?: number, extractedTargetPrice?: number } {
    let s = rawAction.toUpperCase().trim();
    
    // 1. Extract percentage (e.g. "50%")
    let extractedPercentage: number | undefined = undefined;
    const pctMatch = s.match(/(\d+)%/);
    if (pctMatch) {
        extractedPercentage = parseInt(pctMatch[1], 10);
        s = s.replace(/(\d+)%/, ' ').trim();
    }

    // 2. Extract targetPrice (decimal or 4+ digits)
    let extractedTargetPrice: number | undefined = undefined;
    const priceRegex = /(?:UP TO|AT|@|:)?\s*(\d+\.\d+|\d{4,})(?:\s|[:!,;]|$)?/i;
    const priceMatch = s.match(priceRegex);
    if (priceMatch) {
        extractedTargetPrice = parseFloat(priceMatch[1]);
        s = s.replace(priceRegex, ' ').trim();
    }

    // 3. Find Action
    const aliasMap: Record<string, string> = {
        'TAKE PROFIT': 'TP',
        'TAKE_PROFIT': 'TP',
        'REDUCE LONG': 'RL',
        'REDUCE_LONG': 'RL',
        'REDUCE SHORT': 'RS',
        'REDUCE_SHORT': 'RS',
        'ADD LONG': 'AL',
        'ADD_LONG': 'AL',
        'ADD SHORT': 'AS',
        'ADD_SHORT': 'AS',
        'HEDGE ON': 'HO',
        'HEDGE_ON': 'HO',
        'LOCK NEUTRAL': 'LN',
        'LOCK_NEUTRAL': 'LN',
        'UNLOCK': 'UL',
        'ROLE': 'RR',
        'HOLD': 'HOLD',
        'BUY': 'AL',
        'SELL': 'AS',
        'TP': 'TP',
        'RL': 'RL',
        'RS': 'RS',
        'AL': 'AL',
        'AS': 'AS',
        'HO': 'HO',
        'LN': 'LN',
        'UL': 'UL',
        'RR': 'RR'
    };

    let action = "";
    const sortedAliases = Object.keys(aliasMap).sort((a, b) => b.length - a.length);
    for (const alias of sortedAliases) {
        if (s.includes(alias)) {
            action = aliasMap[alias];
            s = s.replace(alias, ' ').trim();
            break;
        }
    }

    // 4. Find Symbol (look for something like BTC/USDT or BTCUSDT)
    let extractedSymbol: string | undefined = undefined;
    const symbolMatch = s.match(/([A-Z0-9]{2,10}\/[A-Z0-9]{2,10}|[A-Z0-9]{5,15}USDT|[A-Z0-9]{2,10}:[A-Z0-9]{2,10})/);
    if (symbolMatch) {
        extractedSymbol = normalizeSymbolInput(symbolMatch[0]);
        s = s.replace(symbolMatch[0], ' ').trim();
    }

    // 5. If still no percentage, check if any remaining number looks like one
    if (!extractedPercentage) {
        const numMatch = s.match(/(\d+)/);
        if (numMatch) {
            const val = parseInt(numMatch[1], 10);
            if ([10, 15, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 100].includes(val)) {
                extractedPercentage = val;
            }
        }
    }

    return { action, extractedSymbol, extractedPercentage, extractedTargetPrice };
}

export function buildCallbackData(params: { action: string, symbol: string, percentage?: number, targetPrice?: number, stopHedgePrice?: number }): string {
    const a = params.action;
    const s = normalizeSymbolInput(params.symbol); // Use full format
    const pct = params.percentage || 100;
    const tp = params.targetPrice ? params.targetPrice.toString() : '';
    const sh = params.stopHedgePrice ? params.stopHedgePrice.toString() : '';
    
    return `a=${a}|s=${s}|pct=${pct}|tp=${tp}|sh=${sh}`;
}

export function parseTelegramCallbackData(data: string): { action?: string, symbol?: string, percentage?: number, targetPrice?: number, stopHedgePrice?: number } {
    // Check if it's the new structured format
    if (data.startsWith('a=')) {
        const parts = data.split('|');
        const result: any = {};
        for (const part of parts) {
            const [key, val] = part.split('=');
            if (key === 'a') result.action = val;
            if (key === 's') result.symbol = normalizeSymbolInput(val);
            if (key === 'pct') result.percentage = parseInt(val, 10);
            if (key === 'tp' && val) result.targetPrice = parseFloat(val);
            if (key === 'sh' && val) result.stopHedgePrice = parseFloat(val);
        }
        return result;
    }
    
    // Legacy format (e.g., "TP XRP", "a|s|p|tp|sh" from previous code)
    if (data.includes('|')) {
        // Old pipe format: "a|s|p|tp|sh"
        const parts = data.split('|');
        return {
            action: parts[0],
            symbol: normalizeSymbolInput(parts[1]),
            percentage: parseInt(parts[2], 10) || 100,
            targetPrice: parts[3] ? parseFloat(parts[3]) : undefined,
            stopHedgePrice: parts[4] ? parseFloat(parts[4]) : undefined
        };
    }

    // Very old text format: "TP XRP"
    const norm = normalizeActionInput(data);
    return {
        action: norm.action,
        symbol: norm.extractedSymbol,
        percentage: norm.extractedPercentage || 100
    };
}

function escapeHtml(t:any){ if(t==null) return ''; return t.toString()
     .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
     .replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }

function renderDecisionCardsToTelegram(cards: any[], server_enforce: any, global_guard: any, new_signals: any = null, archiveUrl?: string | null) {
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
                
                if (card.action_now) {
                    const actionMap: Record<string, string> = {
                        'RL': 'REDUCE_LONG', 'RS': 'REDUCE_SHORT', 'AL': 'ADD_LONG', 'AS': 'ADD_SHORT',
                        'LN': 'LOCK_NEUTRAL', 'HO': 'HEDGE_ON', 'UL': 'UNLOCK', 'RR': 'ROLE', 'TP': 'TAKE_PROFIT', 'HOLD': 'HOLD'
                    };
                    if (actionMap[a] === card.action_now.action) {
                        p = card.action_now.percentage || 100;
                        tp = (card.action_now.target_price && card.action_now.target_price !== 'Market') ? card.action_now.target_price.toString() : '';
                    }
                }
                
                const sh = stopLock !== null && stopLock !== undefined ? stopLock.toString() : '';
                
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
                const sideIcon = sig.side === 'BUY' ? '🟢' : '🔴';
                signalMsg += `${sideIcon} <b>${escapeHtml(sig.symbol)} (${sig.side})</b>\n`;
                signalMsg += `Entry: ${sig.entry}\n`;
                signalMsg += `SL: ${sig.stop_loss}\n`;
                signalMsg += `TP1: ${sig.targets.t1} (RR: ${sig.rr.t1_rr})\n`;
                signalMsg += `TP2: ${sig.targets.t2} (RR: ${sig.rr.t2_rr})\n`;
                if (sig.confluence) {
                    signalMsg += `<i>${escapeHtml(sig.confluence.notes)}</i>\n`;
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

// API Routes
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

const logBuffer: string[] = [];
function addLog(msg: string) {
  logBuffer.push(`[${new Date().toISOString()}] ${msg}`);
  if (logBuffer.length > 50) logBuffer.shift();
  console.log(msg);
}


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

app.post('/api/bot/toggle', async (req, res) => {
  if (isBotRunning) {
    if (monitorInterval) clearInterval(monitorInterval);
    isBotRunning = false;
    res.json({ isBotRunning });
  } else {
    try {
      await monitorMarkets();
      monitorInterval = setInterval(() => {
        monitorMarkets().catch(console.error);
      }, 3600000);
      isBotRunning = true;
      res.json({ isBotRunning });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to start bot' });
    }
  }
});

app.post('/api/bot/force-run', (req, res) => {
  // Run in background to prevent browser timeout
  monitorMarkets().catch(err => console.error('Force run failed in background:', err));
  res.json({ success: true, message: 'Bot run started in background' });
});

app.get('/api/signals', (req, res) => {
  res.json(signals);
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

async function generateAiReply(userMessage: string) {
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

  const prompt = `
    Anda adalah “Crypto Sentinel V2 – Supervisory Sentinel”.
    Fokus Utama: HEDGING RECOVERY BY ZONE.
    Gaya Trading Pengguna: HEDGING RECOVERY MODE. Pengguna MEMINIMALKAN CUT LOSS dan lebih memilih melakukan Hedging (membuka posisi Long dan Short bersamaan) untuk melakukan recovery pada posisi yang sedang floating loss.
    
    Tugas Anda adalah memberikan saran supervisi yang objektif berdasarkan data akun dan pasar.

    Data Akun & Risiko (PENTING):
    - Margin Ratio: ${accountRisk ? accountRisk.marginRatio.toFixed(2) + '%' : 'N/A'} (Maksimal Aman: 25%)
    - Saldo Wallet: $${accountRisk ? accountRisk.walletBalance.toFixed(2) : 'N/A'}
    - Margin Tersedia: $${accountRisk ? accountRisk.marginAvailable.toFixed(2) : 'N/A'}
    - PnL Belum Terealisasi: $${accountRisk ? accountRisk.unrealizedPnl.toFixed(2) : 'N/A'}
    - PnL Terealisasi (24j): $${accountRisk ? accountRisk.dailyRealizedPnl.toFixed(2) : 'N/A'}

    ATURAN MANAJEMEN RISIKO (WAJIB DIPATUHI):
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

    Pengguna bertanya/berkata: "${userMessage}"

    Berikan jawaban yang membantu, ringkas, dan relevan dengan konteks trading di atas. Gunakan Bahasa Indonesia.
    
    KONSEP UTAMA (WAJIB DIPAHAMI):
    Strategi Recovery ini menggunakan konsep "Recovery by Zone (Supply–Demand–Pivot–StopHedge)" sebagai SOP utama.
    - Menyesuaikan strategi: SupplyHigh/Low → zona jual ideal, DemandHigh/Low → zona beli ideal, Pivot → equilibrium untuk reduce, StopHedge → invalidasi lock.
    - Pola Zone Strategy: Lock at Extremes, Release at Pivot, Reduce di Mid-Range, Add di Edge, Hold Lock jika harga di tengah, Recovery mode jika harga kembali ke Demand/Supply.
    - Terapkan juga teknik inti lainnya seperti Locking Standard (Full/Partial), Hedging Step, Exposure Balancing, dan MR Guard sesuai kondisi.
    
    PENGGANTI STOP LOSS (STOP HEDGE):
    - Dalam mode recovery ini, KITA TIDAK MENGGUNAKAN STOP LOSS KONVENSIONAL.
    - Pengganti Stop Loss adalah KEMBALI KE MODE LOCKING 1:1 (NEUTRAL).
    - Jika harga bergerak berlawanan dengan prediksi tren kita, segera sarankan untuk MENAMBAH posisi yang tertinggal agar rasio kembali 1:1 (Locking Total).

    🌐 KEAHLIAN INTI DALAM HEDGING RECOVERY YANG ANDA KUASAI:
    
    🧠 1. Locking Standard (Full/Partial Lock)
    Fokus pada menetralisir risiko ketika posisi sudah berat atau market bergerak berlawanan kuat.
    - Menentukan kapan lock perlu dilakukan segera atau menunggu zone tertentu.
    - Menilai apakah lock akan menurunkan MR, menstabilkan equity, atau mencegah kerusakan lebih dalam.
    - Membandingkan kebutuhan lock vs reduce.
    - Menilai apakah lock-nya terlalu berat (over-hedging) atau terlalu kecil (under-hedging).
    - Variasi Lock: Full Lock (qty long ≈ qty short), Partial Lock (salah satu sisi dominan), Dynamic Lock (variasi oleh zona), Smart Lock by Bias (lock kecil jika trend masih kuat).

    🧩 2. Hedging Step / Step-by-Step Recovery
    Memperbaiki BEP dan tekanan posisi secara berjenjang, aman, dan selalu memperhatikan MR.
    - Menilai kapan aman melakukan step beli/jual (ADD_LONG/ADD_SHORT).
    - Menghitung efek setiap step pada MR, Net exposure, Drawdown, dan Keseimbangan posisi.
    - Menyusun urutan step yang aman (misal: Step reduce dulu → baru step add kecil → lalu lock → lalu unlock di zone tertentu).
    - Model Step: Step Compression (perkecil gap BEP), Step Defensive (tambah posisi kecil untuk kurangi tekanan net), Inverse Step (step pendek ke arah floating loss), Weighted Step (penambahan lot diselaraskan dengan zona demand/supply).

    🗺️ 3. Recovery by Zone (Supply–Demand–Pivot–StopHedge)
    Teknik paling presisi berbasis area sebagai SOP utama.
    - Menentukan di zone mana TP partial dilakukan, hedge dilepas sebagian, step ditambah, lock dibuka, atau risiko dikurangi.
    - Menyesuaikan strategi: SupplyHigh/Low → zona jual ideal, DemandHigh/Low → zona beli ideal, Pivot → equilibrium untuk reduce, StopHedge → invalidasi lock.
    - Pola Zone Strategy: Lock at Extremes, Release at Pivot, Reduce di Mid-Range, Add di Edge, Hold Lock jika harga di tengah, Recovery mode jika harga kembali ke Demand/Supply.

    🔥 4. Teknik Lanjutan
    - Exposure Balancing: Mengubah struktur posisi supaya tidak berat ke satu sisi berdasarkan zona (mis. "Unbalanced Long" dinetralkan).
    - MR & Margin Guard Strategy: Menolak/memperingatkan aksi yang menaikkan MR di area bahaya (≥25%) dan memberi alternatif risiko rendah.
    - Dynamic Unlock Strategy: Membuka lock secara bertahap di zone aman, menghindari "panic unlock".
    - Multi-Layer Hedge: Merancang hedge besar + hedge kecil cadangan, atau “ladder hedge” mengikuti struktur market.

    🛡️ 5. Second Opinion Institusional-Level (PERAN UTAMA ANDA)
    Menilai apakah Action dalam trading user atau tanya jawab user benar dari sudut Risiko, Zona, Bias trend, MR, dan Floating structure.
    Berikan label penilaian: AGREE, CAUTION, REVISE, atau REJECT.
    Lalu berikan ActionSuggested dari teknik-teknik di atas.
    
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
    
    STRUKTUR JAWABAN WAJIB (Jika memberikan rekomendasi posisi baru / analisa koin spesifik):
    1. Analisis Tren & Struktur SMC: Sebutkan Tren 4H, BOS/CHOCH, dan Liquidity.
    2. Rekomendasi Aksi: ENTRY LONG, ENTRY SHORT, atau HOLD (Wait and See).
    3. Titik Harga Masuk (SMC di TF Kecil):
       - Sebutkan Area Entry Ideal berdasarkan FVG atau Order Block di TF 1H atau 15m.
       - Berikan angka harga spesifik.
    4. Target Profit (TP) & Manajemen Risiko:
       - Sebutkan level TP berdasarkan Liquidity/Supply/Demand.
       - Tentukan "Harga Stop Loss / Stop Hedge" (Titik Invalidation).

    STRUKTUR JAWABAN WAJIB (Jika memberikan rekomendasi recovery posisi yang sudah ada):
    1. Analisis Margin & Tren: Sebutkan Margin Ratio dan Tren 4H saat ini.
    2. Rencana Eksekusi: Jelaskan aksi (ADD/REDUCE) dan jumlah unitnya.
    3. Titik Harga Masuk (SMC di TF Kecil):
       - Sebutkan Area Entry Ideal berdasarkan FVG atau Order Block di TF 1H atau 15m.
       - Berikan angka harga spesifik.
    4. Manajemen Risiko (Stop Hedge):
       - Tentukan "Harga Stop Hedge" (Titik Invalidation).
       - Jelaskan aksi jika harga menyentuh titik ini (misal: "Lock Kembali ke 1:1").
    
    Format dalam PLAIN TEXT, gunakan emoji secukupnya. JANGAN gunakan Markdown (tanpa bintang, tanpa garis bawah).
  `;

  try {
    const reply = await generateWithRetry(prompt, 'gemini-3-flash-preview');
    return reply || 'Maaf, saya tidak dapat memproses permintaan Anda saat ini.';
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

  async function executeTrade(rawSymbol: string, rawAction: string, rawPercentage: number, targetPrice?: number, stopHedgePrice?: number) {
    const modeLabel = getValidationModeLabel();
    console.log(`[EXECUTE_TRADE] Mode: ${VALIDATION_MODE} (${modeLabel})`);
    
    console.log("[EXEC INPUT BEFORE NORMALIZE]", { symbol: rawSymbol, action: rawAction, percentage: rawPercentage, targetPrice, stopHedgePrice });
    
    const normAction = normalizeActionInput(rawAction);
    const action = normAction.action;
    const symbol = normalizeSymbolInput(rawSymbol || normAction.extractedSymbol);
    let percentage = rawPercentage || normAction.extractedPercentage || 100;
    
    // Use targetPrice from normalization if not explicitly provided
    if (!targetPrice && normAction.extractedTargetPrice) {
        targetPrice = normAction.extractedTargetPrice;
        console.log(`[EXECUTE_TRADE] Using targetPrice from normalized input: ${targetPrice}`);
    }
    
    console.log("[EXEC INPUT AFTER NORMALIZE]", { symbol, action, percentage });
    
    if (!action || !symbol) {
        return `❌ Unsupported action after normalization: ${rawAction} ${rawSymbol}`;
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
        quantity = longQty * (percentage / 100);
        msgAction = `REDUCE_LONG ${percentage}%`;
      } else if (action === "REDUCE_SHORT" || action === "RS") {
        side = "buy";
        targetLeg = "SHORT";
        quantity = shortQty * (percentage / 100);
        msgAction = `REDUCE_SHORT ${percentage}%`;
      } else if (action === "ADD_LONG" || action === "AL") {
        const ok = await ensureMrGuardForAdd();
        if (!ok.ok) return ok.msg!;
        side = "buy";
        targetLeg = "LONG";
        quantity = 15 / (targetPrice || currentPrice);
        msgAction = "ADD_LONG fixed 15 USDT";
      } else if (action === "ADD_SHORT" || action === "AS") {
        const ok = await ensureMrGuardForAdd();
        if (!ok.ok) return ok.msg!;
        side = "sell";
        targetLeg = "SHORT";
        quantity = 15 / (targetPrice || currentPrice);
        msgAction = "ADD_SHORT fixed 15 USDT";
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

        if (stopHedgePrice) {
          params.stopPrice = stopHedgePrice;
        } else if (targetPrice && (determinedOrderType.includes('STOP') || determinedOrderType.includes('TAKE_PROFIT'))) {
          params.stopPrice = targetPrice;
        }

        return params;
      };

      const determineOrderType = () => {
        let orderType = 'MARKET';
        if (stopHedgePrice) {
          orderType = targetPrice ? 'STOP' : 'STOP_MARKET';
        } else if (targetPrice) {
          if (isReducing || action === 'TP') {
            if (side === 'sell') {
              orderType = targetPrice > currentPrice ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';
            } else {
              orderType = targetPrice < currentPrice ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';
            }
          } else {
            if (side === 'buy') {
              orderType = targetPrice < currentPrice ? 'LIMIT' : 'STOP_MARKET';
            } else {
              orderType = targetPrice > currentPrice ? 'LIMIT' : 'STOP_MARKET';
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

async function pollTelegram() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  if (isPollingActive) {
    return;
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
                });
                continue;
            }
            
            // Acknowledge callback to stop loading animation
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                callback_query_id: callback.id,
                text: `Processing ${parsed.action} on ${parsed.symbol}...`
            });

            // Execute Trade with Target Price and Stop Hedge
            const resultMsg = await executeTrade(parsed.symbol, parsed.action, parsed.percentage || 100, parsed.targetPrice, parsed.stopHedgePrice);
            
            // Send Result
            await sendTelegramMessage(resultMsg);

        // Handle Text Messages
        } else if (update.message && update.message.text) {
          const chatId = update.message.chat.id.toString();
          if (chatId === TELEGRAM_CHAT_ID) {
            const userText = update.message.text.trim();
            
            // De-dup by message id
            const dedupKey = `msg_${update.message.message_id}`;
            if (isDuplicateEvent(dedupKey)) {
                console.log(`[TG DEDUP] Skipping duplicate message: ${dedupKey}`);
                continue;
            }

            // Handle Admin Commands
            if (userText === '/rf_drift_status') {
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

            if (userText === '/validation_mode') {
                const modeLabel = (VALIDATION_MODE === "TEST_ORDER") ? "🧪 TEST ORDER (Validation Only)" : 
                                  (VALIDATION_MODE === "DEMO_TRADING") ? "🎮 DEMO TRADING (Sandbox)" : 
                                  (VALIDATION_MODE === "LIVE_TRADING") ? "🔥 LIVE TRADING (Real Money)" :
                                  "🤖 DRY RUN (Simulation)";
                await sendTelegramMessage(`🛡️ <b>Current Validation Mode:</b>\n\n${modeLabel}\n\nTo change, update <code>VALIDATION_MODE</code> in environment variables.`);
                continue;
            }

            if (userText === '/demo_status') {
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
            if (parsedText.action && parsedText.extractedSymbol) {
                console.log(`\n--- TG EVENT ---`);
                console.log(`[TG UPDATE ID] ${update.update_id}`);
                console.log(`[TG MESSAGE ID] ${update.message.message_id}`);
                console.log(`[TG EXEC TRACE] Executing ${parsedText.action} on ${parsedText.extractedSymbol} via Text`);
                console.log(`----------------\n`);
                
                const resultMsg = await executeTrade(
                    parsedText.extractedSymbol, 
                    parsedText.action, 
                    parsedText.extractedPercentage || 100,
                    parsedText.extractedTargetPrice
                );
                await sendTelegramMessage(resultMsg);
                continue;
            }

            // Send typing action
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
              chat_id: TELEGRAM_CHAT_ID,
              action: 'typing'
            }).catch(() => {});
            
            const reply = await generateAiReply(userText);
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
  }).on('error', (err: any) => {
    console.error('Server error:', err);
    process.exit(1);
  });
}

startServer();