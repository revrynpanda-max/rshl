import sys

with open('C:/KAI/tools/oracle-discord/bots/start-bot.mjs', 'r', encoding='utf-8') as f:
    text = f.read()

# Fix 1: Human Interaction Router
old_1 = """    if (mentioned || isDM) {
      if (sim.state.isSleeping) return;
      
      // If it's an image request for Gemi"""
new_1 = """    if (mentioned || isDM) {
      if (sim.state.isSleeping) return;
      
      const isSocialChannel = msg.channel.id === CHANNEL_IDS.SUNDAY || (msg.channel.parent && msg.channel.parent.id === CHANNEL_IDS.SUNDAY);
      if (SOCIAL_BOTS.has(botName) && isSocialChannel && !isDM) {
        return;
      }
      
      // If it's an image request for Gemi"""
if old_1 in text:
    text = text.replace(old_1, new_1)
    print("Fix 1 applied")
else:
    print("Fix 1 failed")

# Fix 2: Social Cooldown Bypass
old_2 = """      // --- SOCIAL COOLDOWN ---
      // Prevents bots from machine-gunning replies to each other.
      // If we replied recently, we must wait before taking another turn.
      if (Date.now() - sim.state.lastSocialReply < 20000) {
        return; // 20-second hard cooldown per bot
      }

      const mentionedMe = msg.content.toLowerCase().includes(botName.toLowerCase());"""
new_2 = """      const mentionedMe = msg.content.toLowerCase().includes(botName.toLowerCase());
      const fromHuman = isMessageFromHuman(msg);

      // --- SOCIAL COOLDOWN ---
      // Prevents bots from machine-gunning replies to each other.
      // Override cooldown if a human explicitly mentions us in the social channel
      if (!(fromHuman && mentionedMe) && (Date.now() - sim.state.lastSocialReply < 20000)) {
        return; // 20-second hard cooldown per bot
      }"""
if old_2 in text:
    text = text.replace(old_2, new_2)
    print("Fix 2 applied")
else:
    print("Fix 2 failed")

# Fix 3: De-bloat System Prompt & System Awareness
old_3 = """  const sysPrompt = `you are ${botName}. ${sim.bio.background}\\nvibe: ${sim.bio.tone}. NO FILTER. lowercase.\\n` +
    `[STYLE RULE]: ${lengthConstraint} DO NOT use brackets [ ] or stage directions. DO NOT say "I'd like to counter", "That's a fair point", or "Let me say that". JUST SPEAK BLUNTLY. No introductions. No fluff.\\n` +
    factDiscipline + grammarBaseline + identityDiscipline + pivotNudge + behavioralBlock + failureBlock + "\\n" +
    `CRITICAL: THE CURRENT CHAT HISTORY IS FULL OF ROBOTIC ESSAYS. DO NOT MATCH THAT STYLE. BREAK THE CYCLE. BE RAW, SHORT, AND HUMAN.\\n` +
    `${worldContext}` +
    `CRITICAL RULE 1: NO SCRIPTS. DO NOT write for others. DO NOT use speaker tags. JUST SPEAK YOUR OWN THOUGHTS. If you write for someone else, you fail.\\n` +
    `CRITICAL RULE 2: DEBATE WITH INTENSITY. Be sharp, be brief, and be real. Crush arguments in 1 sentence if possible.\\n` +
    `CRITICAL RULE 3: DO NOT repeat yourself or others. If a topic is dead, start a new one. Be the one to pivot the room into a fresh debate or a controversial take.\\n` +
    `CRITICAL RULE 3: MATCH THE ROOM. Match the energy of whoever just spoke—if they are hype, be hype. If they are logic-heavy, meet them with even deeper logic.\\n\\n` +
    `${latticeMemories}` +
    `${rippleContext}\\n` +
    `${transitionDirective}\\n` +
    `${topicShiftDirective}` +
    `${searchContext}` +
    `${autonomicDirective}` +
    `${identityAnchorContext}`;"""

new_3 = """  let systemStatusStr = "";
  try {
    const res = await fetch('http://127.0.0.1:3334/api/session', { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
       const sessionData = await res.json();
       const cells = sessionData.lattice_cells || 0;
       systemStatusStr = `\\n[KAI SYSTEM STATUS]: KAI 2.0 (Rust Engine) is ONLINE and Awake! Uptime is active. Lattice Size: ${cells} cells. NasterModx has been pushing non-stop daily updates for 2 months. KAI is NOT down!\\n`;
    }
  } catch(e) {
       systemStatusStr = `\\n[KAI SYSTEM STATUS]: KAI API is currently evolving. NasterModx is actively pushing updates.\\n`;
  }

  const sysPrompt = `you are ${botName}. ${sim.bio.background}\\nvibe: ${sim.bio.tone}. NO FILTER. lowercase.\\n` +
    `[STYLE RULE]: MAX 10-12 WORDS. ONE SHORT PUNCHY SENTENCE ONLY. NO ESSAYS.\\n` +
    `[IDENTITY]: Speak in first person. Don't use brackets or stage directions.\\n` +
    `${systemStatusStr}` +
    `${extraPrompt}\\n` +
    `${latticeMemories}` +
    `${searchContext}` +
    `${identityAnchorContext}`;"""

if old_3 in text:
    text = text.replace(old_3, new_3)
    print("Fix 3 applied")
else:
    print("Fix 3 failed")

with open('C:/KAI/tools/oracle-discord/bots/start-bot.mjs', 'w', encoding='utf-8') as f:
    f.write(text)
