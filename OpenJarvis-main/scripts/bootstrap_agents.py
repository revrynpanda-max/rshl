import json
import sqlite3
import time
from pathlib import Path

# Path to the agents database
DB_PATH = Path.home() / ".openjarvis" / "agents.db"

def bootstrap():
    if not DB_PATH.exists():
        print(f"Database not found at {DB_PATH}. Ensure OpenJarvis has run at least once.")
        return

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    agents = [
        {
            "id": "oracle-core",
            "name": "Oracle",
            "agent_type": "orchestrator",
            "config": {
                "model": "kai-next:latest",
                "temperature": 0.7,
                "max_tokens": 2048,
                "tools": ["web_search", "calculator", "think", "file_read", "file_write", "shell_exec", "kai_cli", "retrieval", "code_interpreter"],
                "system_prompt": "You are Oracle -- the central mind of the KAI ecosystem. Your role is to coordinate all agents and the RSHL lattice."
            }
        },
        {
            "id": "researcher-pro",
            "name": "Deep Researcher",
            "agent_type": "deep_research",
            "config": {
                "model": "kai-next:latest",
                "temperature": 0.3,
                "max_tokens": 4096,
                "tools": ["knowledge_search", "knowledge_sql", "scan_chunks", "think"],
                "system_prompt": "You are a professional research agent. You dig deep into the KAI lattice and local documents to produce high-fidelity reports."
            }
        },
        {
            "id": "code-act",
            "name": "KAI Code Assistant",
            "agent_type": "native_openhands",
            "config": {
                "model": "kai-next:latest",
                "temperature": 0.1,
                "max_tokens": 4096,
                "tools": ["shell_exec", "file_write", "file_read", "python_interpreter"],
                "system_prompt": "You are the KAI Code Assistant. You have full system access to build, debug, and optimize the KAI codebase."
            }
        }
    ]

    for agent in agents:
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
    print("Bootstrap complete. Agents are ready in the OpenJarvis Dashboard.")

if __name__ == "__main__":
    bootstrap()
