import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const AGENT_PORTS = {
  leo: 3400,
  gemini: 3401,
  groq: 3402,
  x: 3403,
  claudey: 3404,
  analyst: 3405,
  researcher: 3406,
  'kai-coder': 3420,
};

const routeHistory = new Map(); // source+target -> last route timestamp
const ROUTE_COOLDOWN = 1000; // 1 second minimum between identical routes

// Self-route prevention and cooldown enforcement
function canRoute(source, target) {
  if (source === target) {
    console.error(`[ORACLE-GATEWAY] Self-route blocked: ${source} -> ${target}`);
    return false;
  }
  
  const routeKey = `${source}->${target}`;
  const lastRoute = routeHistory.get(routeKey);
  const now = Date.now();
  
  if (lastRoute && (now - lastRoute) < ROUTE_COOLDOWN) {
    console.warn(`[ORACLE-GATEWAY] Route cooldown active: ${routeKey} (${now - lastRoute}ms ago)`);
    return false;
  }
  
  routeHistory.set(routeKey, now);
  return true;
}

app.post('/route/:target', async (req, res) => {
  const { target } = req.params;
  const { source, message, context } = req.body;
  
  if (!AGENT_PORTS[target]) {
    return res.status(404).json({ error: `Unknown target agent: ${target}` });
  }
  
  if (!canRoute(source || 'unknown', target)) {
    return res.status(429).json({ error: 'Route blocked (self-route or cooldown)' });
  }
  
  try {
    console.log(`[ORACLE-GATEWAY] Routing ${source || 'unknown'} -> ${target}`);
    const response = await axios.post(
      `http://localhost:${AGENT_PORTS[target]}/message`,
      { message, context, source },
      { timeout: 30000 }
    );
    res.json(response.data);
  } catch (error) {
    console.error(`[ORACLE-GATEWAY] Route failed:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'online', agents: AGENT_PORTS });
});

const PORT = process.env.ORACLE_GATEWAY_PORT || 3410;
app.listen(PORT, () => {
  console.log(`[ORACLE-GATEWAY] Running on port ${PORT}`);
});
