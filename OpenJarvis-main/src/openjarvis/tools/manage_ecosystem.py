from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from openjarvis.tools.base import BaseTool, ToolResult, ToolSpec

class EcosystemControlTool(BaseTool):
    """Tool to manage the KAI AI Roundtable ecosystem via natural language.
    Allows for restarting bots, updating environment variables, and pushing hotfixes.
    """

    name = "manage_ecosystem"

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name=self.name,
            description="Manage the AI Roundtable ecosystem. Actions: restart, hotfix, env_update, status_check.",
            category="system",
            parameters={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["restart", "hotfix", "env_update", "status_check"],
                        "description": "The system action to perform."
                    },
                    "target": {
                        "type": "string",
                        "description": "The target bot name (for restart) or KEY=VALUE (for env_update)."
                    },
                    "reason": {
                        "type": "string",
                        "description": "Optional reason for the action to be logged."
                    }
                },
                "required": ["action"]
            }
        )

    def execute(self, action: str, target: Optional[str] = None, reason: Optional[str] = None) -> ToolResult:
        command_file = Path("c:/KAI/tools/oracle-discord/remote_commands.json")
        
        cmd_data = {
            "action": action,
            "target": target,
            "reason": reason,
            "timestamp": os.path.getmtime(__file__) if os.path.exists(__file__) else 0
        }
        
        try:
            with open(command_file, "w") as f:
                json.dump(cmd_data, f)
            
            return ToolResult(
                success=True,
                content=f"Successfully queued ecosystem action: {action} on {target or 'system'}. The Ecosystem Manager is processing it now."
            )
        except Exception as e:
            return ToolResult(success=False, error=f"Failed to communicate with Ecosystem Manager: {str(e)}")

def register_tool(registry):
    registry.register("manage_ecosystem", EcosystemControlTool)
