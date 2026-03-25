
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { readFileSync } from 'fs';

async function testWrite() {
  try {
    const config = JSON.parse(readFileSync('./firebase-applet-config.json', 'utf8'));
    const app = initializeApp(config);
    const db = getFirestore(app, config.firestoreDatabaseId);
    const auth = getAuth(app);

    await signInWithEmailAndPassword(auth, 'server@sentinel.local', 'sentinel-server-secret-123');
    
    console.log('Attempting to write to trading_journal...');
    const journalId = `journal_${Date.now()}_TEST`;
    const journalEntry = {
      id: journalId, timestamp: new Date().toISOString(), symbol: 'TEST/USDT', side: 'LONG', entryPrice: 100,
      stopLoss: 0, target1: 0, target2: 0, reason: 'Test', sentiment: 'NEUTRAL', status: 'OPEN', source: 'PAPER_BOT', pnl: 0
    };
    await setDoc(doc(db, 'trading_journal', journalId), journalEntry);
    console.log('Write to trading_journal successful!');

    console.log('Attempting to update trading_journal (close)...');
    await setDoc(doc(db, 'trading_journal', journalId), {
      exitPrice: 110, pnl: 10, status: 'CLOSED', closedAt: new Date().toISOString(), closeReason: 'Test Close'
    }, { merge: true });
    console.log('Update to trading_journal successful!');

    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

testWrite();
