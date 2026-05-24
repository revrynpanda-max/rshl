import { config } from 'dotenv';
config();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/models';

async function verifyGroqHealth() {
  console.log('[GROQ HEALTH CHECK] Starting verification...\n');
  
  if (!GROQ_API_KEY) {
    console.error('❌ GROQ_API_KEY not found in environment');
    console.error('   Check .env file in oracle-discord root');
    process.exit(1);
  }

  try {
    console.log(`[GROQ HEALTH CHECK] Pinging ${GROQ_ENDPOINT}...`);
    
    const response = await fetch(GROQ_ENDPOINT, {
      headers: { 
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    const modelCount = data.data?.length || 0;
    
    console.log('\n✅ GROQ API HEALTHY');
    console.log(`   Available models: ${modelCount}`);
    console.log(`   Endpoint: ${GROQ_ENDPOINT}`);
    console.log(`   Status: ${response.status} OK`);
    
    if (modelCount > 0) {
      console.log('\n[AVAILABLE MODELS]');
      data.data.slice(0, 5).forEach(model => {
        console.log(`   - ${model.id}`);
      });
      if (modelCount > 5) {
        console.log(`   ... and ${modelCount - 5} more`);
      }
    }
    
    console.log('\n[RESULT] Groq cloud endpoint is operational.');
    console.log('[RESULT] No local inference service required.');
    
    return true;
    
  } catch (error) {
    console.error('\n❌ GROQ API FAILURE');
    console.error(`   Error: ${error.message}`);
    console.error(`   Endpoint: ${GROQ_ENDPOINT}`);
    console.error('\n[DIAGNOSTIC STEPS]');
    console.error('   1. Verify GROQ_API_KEY in .env');
    console.error('   2. Check network connectivity');
    console.error('   3. Verify API key validity at https://console.groq.com');
    console.error('   4. Check rate limits');
    
    process.exit(1);
  }
}

verifyGroqHealth();
