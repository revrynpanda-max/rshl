document.addEventListener('DOMContentLoaded', () => {
    const chatHistory = document.getElementById('chat-history');
    const terminalOutput = document.getElementById('terminal-output');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const statusIndicator = document.querySelector('.status-indicator');

    let isPolling = false;

    function addMessage(text, role) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${role}`;
        
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = text;
        
        msgDiv.appendChild(bubble);
        chatHistory.appendChild(msgDiv);
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function addLog(text, type = 'normal') {
        const logLine = document.createElement('div');
        logLine.className = `log-line ${type}`;
        
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        logLine.textContent = `[${timestamp}] ${text}`;
        
        terminalOutput.appendChild(logLine);
        terminalOutput.scrollTop = terminalOutput.scrollHeight;
    }

    async function pollInterjections() {
        if (isPolling) return;
        isPolling = true;
        
        statusIndicator.style.boxShadow = '0 0 15px #f59e0b';
        statusIndicator.style.background = '#f59e0b'; // Processing state
        
        while (true) {
            try {
                const response = await fetch('http://127.0.0.1:3334/api/interjections');
                if (!response.ok) throw new Error('Network error');
                
                const data = await response.json();
                
                for (const inter of data.interjections || []) {
                    if (inter.from === 'KAI_SPEAKING') {
                        addMessage(inter.text, 'kai');
                        addLog(`Spoke: ${inter.text.substring(0, 30)}...`, 'speaking');
                    } else if (inter.from === 'KAI_FINAL') {
                        // Optional: Could do something specific on final turn
                        addLog('Turn complete.', 'system');
                        statusIndicator.style.boxShadow = '0 0 10px #10b981';
                        statusIndicator.style.background = '#10b981';
                    } else {
                        // Internal thought
                        addLog(`THOUGHT: ${inter.text}`);
                    }
                }
            } catch (err) {
                // Silently handle polling errors, backend might just be busy
            }
            
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    async function sendMessage() {
        const text = chatInput.value.trim();
        if (!text) return;

        chatInput.value = '';
        addMessage(text, 'user');
        addLog(`Sent input: ${text.substring(0, 30)}...`, 'system');

        try {
            const response = await fetch('http://127.0.0.1:3334/api/oracle-turn', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from: 'User',
                    text: text,
                    async_mode: true
                })
            });
            
            if (!response.ok) {
                addLog('Error connecting to Oracle Server', 'system');
                return;
            }
            
            // Ensure poller is running
            pollInterjections();
            
        } catch (err) {
            addLog(`Connection Error: ${err.message}`, 'system');
            addMessage('Error connecting to KAI. Is the server running?', 'kai');
        }
    }

    sendBtn.addEventListener('click', sendMessage);
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Auto-resize textarea
    chatInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
    });

    // Start background poller just in case KAI talks without input
    pollInterjections();
});
