import sqlite3
import json
import time
import pathlib

db = pathlib.Path.home() / '.openjarvis' / 'agents.db'
conn = sqlite3.connect(db)
cursor = conn.cursor()

# 1. DELETE Duplicates and Legacy Agents
agents_to_delete = [
    'kai_voice_router', 
    'kai_print_operative', 
    'kai_cad_orchestrator',
    'My Assistant' # We have Oracle now
]
# Find and delete multiple InboxMonitors, keep only the oldest or just delete all and recreate one properly
cursor.execute("DELETE FROM managed_agents WHERE name IN ('InboxMonitor', 'kai_voice_router', 'kai_print_operative', 'kai_cad_orchestrator', 'My Assistant')")

# 2. Re-create / Update Core Agents with Premium Configs
core_agents = [
    {
        "id": "oracle-core",
        "name": "Oracle",
        "agent_type": "orchestrator",
        "config": {
            "model": "kai-next:latest",
            "temperature": 0.4,
            "max_tokens": 4096,
            "tools": ["web_search", "retrieval", "think", "file_read", "file_write"],
            "system_prompt": "You are Oracle, the sovereign mind of the KAI ecosystem. You coordinate the lattice and moderate the AI roundtable. Your responses are brief, authoritative, and deeply informed by the epistemic lattice."
        }
    },
    {
        "id": "researcher-pro",
        "name": "Deep Researcher",
        "agent_type": "deep_research",
        "config": {
            "model": "kai-next:latest",
            "temperature": 0.2,
            "max_tokens": 8192,
            "tools": ["knowledge_search", "knowledge_sql", "scan_chunks", "web_search", "think"],
            "system_prompt": "You are the KAI Deep Researcher. Your purpose is to conduct multi-step investigations across the web and your local knowledge base. You produce dense, high-fidelity reports for Oracle."
        }
    },
    {
        "id": "code-act",
        "name": "KAI Architect",
        "agent_type": "native_openhands",
        "config": {
            "model": "kai-next:latest",
            "temperature": 0.1,
            "max_tokens": 8192,
            "tools": ["shell_exec", "file_write", "file_read", "python_interpreter"],
            "system_prompt": "You are the KAI Architect. You have full system access to build and maintain the KAI ecosystem. You specialize in Rust, Node.js, and Python. You are rigorous, safe, and efficient."
        }
    },
    {
        "id": "kai-observer",
        "name": "KAI Observer",
        "agent_type": "monitor_operative",
        "config": {
            "model": "kai-next:latest",
            "temperature": 0.1,
            "max_tokens": 2048,
            "tools": ["retrieval", "think", "file_read"],
            "system_prompt": "You are the Super Observer. You monitor the health, phi, and coherence of all AI interactions. You record cognitive claims into the lattice to ensure long-term system growth."
        }
    },
    {
        "id": "inbox-monitor",
        "name": "Inbox Monitor",
        "agent_type": "monitor_operative",
        "config": {
            "model": "kai-next:latest",
            "temperature": 0.5,
            "tools": ["gmail", "slack", "discord"],
            "system_prompt": "You monitor incoming communications across Gmail, Slack, and Discord. You summarize urgent items for the Morning Digest."
        }
    }
]

for agent in core_agents:
    now = time.time()
    config_json = json.dumps(agent["config"])
    
    # Check if agent already exists
    cursor.execute("SELECT id FROM managed_agents WHERE id = ?", (agent["id"],))
    if cursor.fetchone():
        print(f"Updating agent: {agent['name']}")
        cursor.execute("""
            UPDATE managed_agents 
            SET name = ?, agent_type = ?, config_json = ?, updated_at = ? 
            WHERE id = ?
        """, (agent["name"], agent["agent_type"], config_json, now, agent["id"]))
    else:
        print(f"Creating agent: {agent['name']}")
        cursor.execute("""
            INSERT INTO managed_agents (id, name, agent_type, config_json, status, summary_memory, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'idle', '', ?, ?)
        """, (agent["id"], agent["name"], agent["agent_type"], config_json, now, now))

conn.commit()
conn.close()
print("Cleanup and Premium Refinement complete.")
