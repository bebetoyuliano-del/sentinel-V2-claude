import axios from 'axios';
import { app } from '../../server.js';
import { markFirestoreUnavailable } from '../../src/paper-engine/firestore_failsoft.js';

async function runTest() {
  console.log("==================================================");
  console.log("[SMOKE B] DEGRADED API TEST (ACTUAL ENDPOINT)");
  console.log("==================================================");
  
  const server = app.listen(0, async () => {
    const port = (server.address() as any).port;
    
    // 1. Trigger quota error
    console.log("1. Triggering Firestore Quota Error...");
    markFirestoreUnavailable(60_000); // Force degraded mode
    
    // 2. Call API
    console.log(`2. Calling http://localhost:${port}/api/signals...`);
    try {
      const response = await axios.get(`http://localhost:${port}/api/signals`);
      
      console.log("   -> Status:", response.status);
      console.log("   -> Content-Type:", response.headers['content-type']);
      console.log("   -> Body:", JSON.stringify(response.data, null, 2));
      
      if (response.data.degraded === true && response.data.code === 'FIRESTORE_UNAVAILABLE') {
        console.log("   -> SUCCESS: API returned JSON degraded response.");
      } else {
        console.log("   -> FAILED: API did not return expected degraded JSON.");
      }
    } catch (err: any) {
      console.log("   -> Error:", err.message);
      if (err.response) {
        console.log("   -> Response Status:", err.response.status);
        console.log("   -> Response Body:", err.response.data);
      }
    } finally {
      server.close();
      process.exit(0);
    }
  });
}

runTest().catch(console.error);
