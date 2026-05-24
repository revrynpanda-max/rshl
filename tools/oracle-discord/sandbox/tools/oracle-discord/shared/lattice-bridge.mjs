import axios from 'axios';

const LATTICE_URL = process.env.LATTICE_URL || 'http://localhost:3334';
const BRIDGE_TIMEOUT = 5000;

// Echo prevention: track relayed messages
const relayedMessages = new Set();
const RELAY_CACHE_SIZE = 100;

export default class LatticeBridge {
  constructor() {
    this.healthy = false;
    this.checkHealth();
  }

  async checkHealth() {
    try {
      const response = await axios.get(`${LATTICE_URL}/health`, { timeout: 2000 });
      this.healthy = response.status === 200;
      console.log(`[LATTICE-BRIDGE] Health check: ${this.healthy ? 'OK' : 'FAIL'}`);
    } catch (error) {
      this.healthy = false;
      console.error(`[LATTICE-BRIDGE] Health check failed:`, error.message);
    }
  }

  // Prevent echo loops when relaying to Discord
  async relayToDiscord(channelId, message, metadata = {}) {
    const messageHash = `${channelId}:${message.substring(0, 50)}`;
    
    if (relayedMessages.has(messageHash)) {
      console.warn(`[LATTICE-BRIDGE] Echo prevented: duplicate relay detected`);
      return { status: 'skipped', reason: 'duplicate' };
    }
    
    relayedMessages.add(messageHash);
    if (relayedMessages.size > RELAY_CACHE_SIZE) {
      const first = relayedMessages.values().next().value;
      relayedMessages.delete(first);
    }
    
    try {
      const response = await axios.post(
        `${LATTICE_URL}/discord/relay`,
        { channelId, message: `[LATTICE_RELAY] ${message}`, metadata },
        { timeout: BRIDGE_TIMEOUT }
      );
      return response.data;
    } catch (error) {
      console.error(`[LATTICE-BRIDGE] Relay failed:`, error.message);
      throw error;
    }
  }

  async snapshot() {
    if (!this.healthy) {
      throw new Error('Lattice bridge is not healthy');
    }
    try {
      const response = await axios.get(`${LATTICE_URL}/lattice/snapshot`, {
        timeout: BRIDGE_TIMEOUT,
      });
      return response.data;
    } catch (error) {
      console.error(`[LATTICE-BRIDGE] Snapshot failed:`, error.message);
      throw error;
    }
  }

  async query(vector) {
    if (!this.healthy) {
      throw new Error('Lattice bridge is not healthy');
    }
    try {
      const response = await axios.post(
        `${LATTICE_URL}/lattice/query`,
        { vector },
        { timeout: BRIDGE_TIMEOUT }
      );
      return response.data;
    } catch (error) {
      console.error(`[LATTICE-BRIDGE] Query failed:`, error.message);
      throw error;
    }
  }
}
