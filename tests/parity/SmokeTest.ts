import { ParityAdapter } from './ParityAdapter.js';
import { computeMRProjectedAfterAdd } from '../../src/paper-engine/valuation.js';
import { buildParityInputState } from '../../src/paper-engine/parity_runtime.js';
import { withFirestoreFailSoft, isFirestoreTemporarilyUnavailable, markFirestoreUnavailable } from '../../src/paper-engine/firestore_failsoft.js';

console.log("==================================================");
console.log("[SMOKE A] CANONICAL PARITY PATH");
console.log("==================================================");

const walletA = { marginRatio: 10, equity: 10000, balance: 10000 };
const longPosA = { size: 1, currentPnl: -50, entryPrice: 61000 };
const shortPosA = { size: 1, currentPnl: 50, entryPrice: 60000 };
const freshSignalA = {
  side: 'BUY',
  trend: { primary4H: 'UP', status: 'CONTINUATION_CONFIRMED' },
  smc: { validated: true }
};

const inputStateA = buildParityInputState({
  symbol: 'BTCUSDT',
  currentPrice: 60500,
  freshSignal: freshSignalA,
  longPos: longPosA,
  shortPos: shortPosA,
  wallet: walletA,
  currentStructure: 'LOCK_1TO1',
  stopHedgeHit: false,
  historyHasSignal: false,
  signalAlreadyActed: false,
  mrProjected: 15
});

console.log("Input State A:", JSON.stringify(inputStateA, null, 2));
const parityResultA = ParityAdapter.evaluate(inputStateA);
console.log("Output A:", JSON.stringify(parityResultA, null, 2));

console.log("\n==================================================");
console.log("[SMOKE B] DEGRADED MODE (FIRESTORE UNAVAILABLE)");
console.log("==================================================");

async function runDegradedSmoke() {
  // Simulate a quota error
  console.log("1. Simulating Firestore Quota Error...");
  const mockFirestoreCall = async () => {
    throw new Error("Quota exceeded.");
  };

  const result = await withFirestoreFailSoft(
    mockFirestoreCall,
    [],
    (err) => console.log("   -> Caught error in fail-soft:", err.message)
  );
  
  console.log("   -> Result from fail-soft:", result);
  console.log("   -> isFirestoreTemporarilyUnavailable?", isFirestoreTemporarilyUnavailable());

  // Now simulate paper trading engine running while degraded
  console.log("\n2. Simulating Paper Trading Engine Tick while degraded...");
  
  const walletB = { marginRatio: 10, equity: 10000, balance: 10000 };
  const longPosB = { size: 1, currentPnl: 100, entryPrice: 59000 };
  
  // Engine still builds state and evaluates parity in-memory
  const inputStateB = buildParityInputState({
    symbol: 'BTCUSDT',
    currentPrice: 60000,
    freshSignal: null,
    longPos: longPosB,
    shortPos: undefined,
    wallet: walletB,
    currentStructure: 'SINGLE',
    stopHedgeHit: false,
    historyHasSignal: false,
    signalAlreadyActed: false,
    mrProjected: 10
  });

  const parityResultB = ParityAdapter.evaluate(inputStateB);
  console.log("   -> Engine evaluated successfully in-memory.");
  console.log("   -> Action:", parityResultB.final_action);
}

runDegradedSmoke().catch(console.error);

