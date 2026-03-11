import axios from 'axios';

async function test() {
  const baseUrl = 'http://localhost:3000';
  
  console.log('--- Testing SMTP Test Endpoint ---');
  try {
    const res1 = await axios.post(`${baseUrl}/api/email/test`);
    console.log('POST /api/email/test response:', res1.data);
  } catch (e: any) {
    console.error('POST /api/email/test failed:', e.response?.data || e.message);
  }

  console.log('\n--- Testing Force Run (Email 1) ---');
  try {
    const res2 = await axios.post(`${baseUrl}/api/bot/force-run`);
    console.log('POST /api/bot/force-run response:', res2.data);
  } catch (e: any) {
    console.error('POST /api/bot/force-run failed:', e.response?.data || e.message);
  }

  console.log('\n--- Testing Cooldown (Email 2 - should be skipped) ---');
  try {
    const res3 = await axios.post(`${baseUrl}/api/bot/force-run`);
    console.log('POST /api/bot/force-run response:', res3.data);
    console.log('Check server logs to confirm if the second email was skipped due to cooldown.');
  } catch (e: any) {
    console.error('POST /api/bot/force-run failed:', e.response?.data || e.message);
  }
}

test();
