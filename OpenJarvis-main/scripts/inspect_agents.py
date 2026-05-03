import sqlite3
import json
import pathlib

db = pathlib.Path.home() / '.openjarvis' / 'agents.db'
conn = sqlite3.connect(db)
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

names = ('InboxMonitor', 'kai_voice_router', 'kai_print_operative', 'kai_cad_orchestrator')
query = f"SELECT id, name, agent_type, config_json, created_at FROM managed_agents WHERE name IN {names}"
agents = [dict(r) for r in cursor.execute(query).fetchall()]
print(json.dumps(agents, indent=2))
conn.close()
