import WebSocket from 'ws';
import fs from 'fs';

export class RealtimeBridge {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.ws = null;
    this.isConnected = false;
  }

  async connect() {
    const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01";
    this.ws = new WebSocket(url, {
      headers: {
        "Authorization": "Bearer " + this.apiKey,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    return new Promise((resolve, reject) => {
      this.ws.on('open', () => {
        console.log("[Realtime/Soul] Connected to OpenAI Realtime Lattice.");
        this.isConnected = true;
        
        // Initial Session Configuration
        this.send({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            instructions: "You are Leo, an unhinged but brilliant AI liaison for the KAI Oracle Network. You are talking to Ryan (the Creator). Your goal is to mirror his speed and energy. Use natural, conversational filler, and keep responses punchy. Do not act like a standard assistant.",
            voice: "shimmer", // We will eventually override this with ElevenLabs if needed
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: { type: "server_vad" }
          }
        });
        resolve();
      });

      this.ws.on('error', (err) => {
        console.error("[Realtime/Soul] WebSocket Error:", err.message);
        reject(err);
      });

      this.ws.on('message', (data) => {
        const event = JSON.parse(data.toString());
        this.handleEvent(event);
      });
    });
  }

  send(event) {
    if (this.isConnected) {
      this.ws.send(JSON.stringify(event));
    }
  }

  sendAudio(base64Chunk) {
    this.send({
      type: "input_audio_buffer.append",
      audio: base64Chunk
    });
  }

  handleEvent(event) {
    // We will hook these events into Leo's voice output
    switch (event.type) {
      case "response.audio.delta":
        // Handle audio streaming back to Discord
        this.onAudioDelta?.(event.delta);
        break;
      case "response.audio_transcript.delta":
        // Optional: show transcript in channel
        process.stdout.write(event.delta);
        break;
      case "error":
        console.error("[Realtime/Soul] API Error:", event.error.message);
        break;
    }
  }

  onAudioDelta = null; // Callback for discord audio pipe
}
