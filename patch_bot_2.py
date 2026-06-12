import sys

with open('C:/KAI/tools/oracle-discord/bots/start-bot.mjs', 'r', encoding='utf-8') as f:
    text = f.read()

old_1 = """    if (finalReply.length > 200) {
      const cut = finalReply.slice(0, 200);
      const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
      finalReply = lastBreak > 60 ? cut.slice(0, lastBreak + 1) : (cut + '...');
    }"""
    
new_1 = """    if (finalReply.length > 200) {
      const cut = finalReply.slice(0, 200);
      const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
      finalReply = lastBreak > 60 ? cut.slice(0, lastBreak + 1) : (cut + '...');
    }
    
    // Prevent double-texting chunks by collapsing newlines
    finalReply = finalReply.replace(/\\n/g, ' ').replace(/\\r/g, '').trim();"""

if old_1 in text:
    text = text.replace(old_1, new_1)
    print("Fix 4 applied")
else:
    print("Fix 4 failed")

with open('C:/KAI/tools/oracle-discord/bots/start-bot.mjs', 'w', encoding='utf-8') as f:
    f.write(text)
