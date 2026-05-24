// Centralized inference routing for KAI ecosystem
// Routes requests to: Groq Cloud | Ollama Local | Gemini | OpenAI-compatible endpoints

import { config } from 'dotenv';
config();

const ENDPOINTS = {
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: process.env.GROQ_API_KEY,
    models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768']
  },
  ollama: {
    url: 'http://localhost:11434/api/chat',
    key: null,
    models: ['Leo-Sovereign', 'Oracle-Sovereign', 'Kai-Coder-Sovereign']
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    key: process.env.GEMINI_API_KEY,
    models: ['gemini-2.0-flash-exp']
  }
};

export async function routeInference(provider, model, messages, options = {}) {
  const endpoint = ENDPOINTS[provider];
  
  if (!endpoint) {
    throw new Error(`Unknown inference provider: ${provider}`);
  }
  
  if (!endpoint.models.includes(model)) {
    throw new Error(`Model ${model} not available for provider ${provider}`);
  }
  
  const requestBody = {
    model,
    messages,
    temperature: options.temperature || 0.7,
    max_tokens: options.max_tokens || 2048,
    stream: options.stream || false
  };
  
  const headers = {
    'Content-Type': 'application/json'
  };
  
  if (endpoint.key) {
    headers['Authorization'] = `Bearer ${endpoint.key}`;
  }
  
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${provider} inference failed: ${response.status} ${errorText}`);
    }
    
    return await response.json();
    
  } catch (error) {
    console.error(`[INFERENCE ROUTER] ${provider} error:`, error.message);
    throw error;
  }
}

export async function healthCheck(provider) {
  const endpoint = ENDPOINTS[provider];
  
  if (!endpoint) {
    return { healthy: false, error: 'Unknown provider' };
  }
  
  try {
    // Simple ping to verify endpoint accessibility
    const testUrl = provider === 'ollama' 
      ? 'http://localhost:11434/api/tags'
      : endpoint.url.replace(/\/chat\/completions$/, '/models');
    
    const headers = endpoint.key 
      ? { 'Authorization': `Bearer ${endpoint.key}` }
      : {};
    
    const response = await fetch(testUrl, { 
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5000)
    });
    
    return {
      healthy: response.ok,
      status: response.status,
      provider,
      models: endpoint.models
    };
    
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
      provider
    };
  }
}
