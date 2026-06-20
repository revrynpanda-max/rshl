import { GeminiLiveSessionManager } from './tools/oracle-discord/shared/gemini-live-bridge.mjs';

async function run() {
  console.log("Starting Gemini Live Audio Test...");
  const manager = new GeminiLiveSessionManager();
  
  try {
    const bridge = await manager.getOrCreate("1111", "Leo", "You are Leo.", "TestUser", { enableTools: false });
    if (!bridge) return console.log("Failed to create bridge.");
    
    bridge.onTranscript = (txt) => console.log("[Gemini Transcript]:", txt);
    bridge.onError = (err) => console.log("[Gemini Error]:", err);
    bridge.onTurnComplete = () => console.log("[Gemini Turn Complete]");

    console.log("Sending speaker context...");
    bridge.sendSpeakerContext("TestUser");

    console.log("Sending empty audio chunk...");
    const emptyPcm = Buffer.alloc(16000 * 2); // 1 second of silence at 16kHz mono
    bridge.sendAudio(emptyPcm); // this will downsample it, which is fine

    console.log("Sending turn complete...");
    bridge.sendAudioStreamEnd();

    setTimeout(() => {
      console.log("Test finished.");
      process.exit(0);
    }, 5000);
  } catch (err) {
    console.error("Test Error:", err);
  }
}
run();
