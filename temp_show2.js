commit 79560d0602d40b608deb36c50a6b865d92714be2
Author: Ryan <ryan@jarvis.local>
Date:   Tue May 12 10:19:25 2026 -0400

    feat: Stabilize Leo voice pipeline, fix Gemini Live v1beta, and harden STT noise gate

diff --git a/tools/oracle-discord/shared/gemini-live-bridge.mjs b/tools/oracle-discord/shared/gemini-live-bridge.mjs
index 9c7074ec..f78f436c 100644
--- a/tools/oracle-discord/shared/gemini-live-bridge.mjs
+++ b/tools/oracle-discord/shared/gemini-live-bridge.mjs
@@ -18,8 +18,8 @@
 
 import WebSocket from 'ws';
 
-// v1alpha is required for gemini-2.0-flash-live-001 — v1beta returns 1008 model-not-found
-const GEMINI_LIVE_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent`;
+// v1beta is now the stable endpoint for gemini-2.0-flash-live-001
+const GEMINI_LIVE_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
 
 export class GeminiLiveBridge {
   constructor(apiKey) {
@@ -62,7 +62,7 @@ export class GeminiLiveBridge {
         // Send session setup
         this.ws.send(JSON.stringify({
           setup: {
-            model: "models/gemini-2.0-flash-live-001",
+            model: "models/gemini-2.0-flash-exp",
             generation_config: {
               response_modalities: ["AUDIO"],
               speech_config: {
@@ -78,10 +78,9 @@ export class GeminiLiveBridge {
             realtime_input_config: {
               automatic_activity_detection: {
                 disabled: false,
-                // LOW start sensitivity — requires a stronger signal to trigger, so
-                // keyboard clicks / fan noise / synth bleed don't fire it.
+                // HIGH start sensitivity — catches word starts more aggressively
                 // Valid API values: START_SENSITIVITY_HIGH | START_SENSITIVITY_LOW
-                start_of_speech_sensitivity: "START_SENSITIVITY_LOW",
+                start_of_speech_sensitivity: "START_SENSITIVITY_HIGH",
                 end_of_speech_sensitivity: "END_SENSITIVITY_LOW", // Don't cut off mid-thought
                 prefix_padding_ms: 300,   // Slightly more lead-in to catch word starts cleanly
                 silence_duration_ms: 900  // 900ms gap before treating speech as finished
