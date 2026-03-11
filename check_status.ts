import axios from 'axios';

async function checkStatus() {
  const baseUrl = 'http://localhost:3000';
  try {
    const res = await axios.get(`${baseUrl}/api/status`);
    console.log('Status:', res.data);
  } catch (e: any) {
    console.error('Status check failed:', e.response?.data || e.message);
  }
}

checkStatus();
