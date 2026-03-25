
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

    const userCredential = await signInWithEmailAndPassword(auth, 'server@sentinel.local', 'sentinel-server-secret-123');
    console.log('Signed in as:', userCredential.user.email);

    console.log('Attempting to write to paper_monitoring...');
    await setDoc(doc(db, 'paper_monitoring', 'TEST_SYMBOL'), { test: true });
    console.log('Write to paper_monitoring successful!');

    console.log('Attempting to write to paper_positions...');
    await setDoc(doc(db, 'paper_positions', 'TEST_POS'), { test: true });
    console.log('Write to paper_positions successful!');

    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

testWrite();
