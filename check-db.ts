
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';
import { readFileSync } from 'fs';

async function checkDB() {
  try {
    const config = JSON.parse(readFileSync('./firebase-applet-config.json', 'utf8'));
    const app = initializeApp(config);
    const db = getFirestore(app, config.firestoreDatabaseId);

    console.log('Checking approved_settings...');
    const snap = await getDocs(collection(db, 'approved_settings'));
    console.log(`Found ${snap.docs.length} approved settings.`);
    snap.docs.forEach(d => console.log(`- ${d.id}: ${JSON.stringify(d.data())}`));

    console.log('\nChecking paper_positions...');
    const snapPos = await getDocs(collection(db, 'paper_positions'));
    console.log(`Found ${snapPos.docs.length} paper positions.`);
    snapPos.docs.forEach(d => console.log(`- ${d.id}: ${JSON.stringify(d.data())}`));

    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

checkDB();
