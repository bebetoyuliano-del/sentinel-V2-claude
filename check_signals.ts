import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, query, orderBy, limit } from 'firebase/firestore';
import * as fs from 'fs';

const config = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));
const app = initializeApp(config);
const db = getFirestore(app, config.firestoreDatabaseId);

async function check() {
  const q = query(collection(db, 'signals'), orderBy('timestamp', 'desc'), limit(5));
  const snap = await getDocs(q);
  snap.docs.forEach(doc => {
    const data = doc.data();
    if (data.type === 'scanner_signal') {
      console.log('Signal ID:', doc.id);
      console.log('SMC:', JSON.stringify(data.smc, null, 2));
    }
  });
  process.exit(0);
}
check();
