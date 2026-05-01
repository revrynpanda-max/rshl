"""KAI Shell & Code Execution Tool.

Gives Oracle the ability to run shell commands, read/write files, and
execute code — the same capabilities the KAI CLI source provides, but
wired natively through OpenJarvis without requiring a TypeScript build.
"""

from __future__ import annotations

import os
import subprocess
import shlex
from typing import Any, Dict, Optional
from openjarvis.core.registry import ToolRegistry
from openjarvis.tools._stubs import BaseTool, ToolSpec
from openjarvis.core.types import ToolResult


@ToolRegistry.register("kai_cli")
class KAICLITool(BaseTool):
    """Execute shell commands, read files, and inspect the KAI project.

    This is Oracle's coding arm — the same capabilities as the KAI CLI,
    directly available without a TypeScript runtime dependency.
    """

    tool_id = "kai_cli"

    # Commands that are never allowed regardless of input
    _BLOCKED = ("rm -rf /", "format c:", "del /f /s /q c:\\", "shutdown", "mkfs")

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="kai_cli",
            description=(
                "Execute a shell command or read a file in the KAI project. "
                "Use for: running scripts, checking build status, reading source files, "
                "running cargo check, git status, python scripts, etc. "
                "Always scoped to C:/KAI project directory."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": (
                            "Shell command to run (e.g. 'cargo check --bin kai', "
                            "'cat src/core/universe.rs', 'git log --oneline -5'). "
                            "Or use action='read_file' with path instead."
                        ),
                    },
                    "action": {
                        "type": "string",
                        "enum": ["shell", "read_file", "list_dir", "status"],
                        "description": "Action type. Default: 'shell'.",
                    },
                    "path": {
                        "type": "string",
                        "description": "File or directory path for read_file/list_dir actions.",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Timeout in seconds (default 30, max 120).",
                    },
                },
                "required": [],
            },
            category="system",
        )

    def _is_safe(self, cmd: str) -> bool:
        low = cmd.lower()
        return not any(b in low for b in self._BLOCKED)

    def execute(self, **params: Any) -> ToolResult:
        action = params.get("action", "shell")
        timeout = min(int(params.get("timeout", 30)), 120)

        if action == "read_file" or (not params.get("command") and params.get("path")):
            return self._read_file(params.get("path", ""))

        if action == "list_dir":
            return self._list_dir(params.get("path", "C:/KAI"))

        if action == "status":
            return self._kai_status()

        command = params.get("command", "")
        if not command:
            return ToolResult(tool_name="kai_cli", content="No command provided.", success=False)

        if not self._is_safe(command):
            return ToolResult(tool_name="kai_cli", content="Command blocked for safety.", success=False)

        return self._run_shell(command, timeout)

    def _run_shell(self, command: str, timeout: int = 30) -> ToolResult:
        kai_dir = os.environ.get("KAI_PROJECT_DIR", "C:/KAI")
        try:
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=kai_dir,
                env={**os.environ, "KAI_ORACLE_HOST": "http://127.0.0.1:3333"},
            )
            output = ""
            if result.stdout.strip():
                output += f"STDOUT:\n{result.stdout.strip()}\n"
            if result.stderr.strip():
                output += f"STDERR:\n{result.stderr.strip()}\n"
            if not output:
                output = f"[Command completed with exit code {result.returncode}]"
            return ToolResult(
                tool_name="kai_cli",
                content=output[:4000],  # cap at 4KB
                success=result.returncode == 0,
                metadata={"exit_code": result.returncode, "command": command},
            )
        except subprocess.TimeoutExpired:
            return ToolResult(tool_name="kai_cli", content=f"Command timed out after {timeout}s.", success=False)
        except Exception as e:
            return ToolResult(tool_name="kai_cli", content=f"Execution error: {e}", success=False)

    def _read_file(self, path: str) -> ToolResult:
        if not path:
            return ToolResult(tool_name="kai_cli", content="No path provided.", success=False)
        # Normalize path
        if not os.path.isabs(path):
            path = os.path.join("C:/KAI", path)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            lines = content.splitlines()
            preview = "\n".join(lines[:200])  # first 200 lines
            suffix = f"\n\n[...{len(lines) - 200} more lines]" if len(lines) > 200 else ""
            return ToolResult(
                tool_name="kai_cli",
                content=f"FILE: {path}\nLINES: {len(lines)}\n\n{preview}{suffix}",
                success=True,
                metadata={"path": path, "total_lines": len(lines)},
            )
        except Exception as e:
            return ToolResult(tool_name="kai_cli", content=f"Cannot read '{path}': {e}", success=False)

    def _list_dir(self, path: str) -> ToolResult:
        if not path:
            path = "C:/KAI"
        try:
            entries = os.listdir(path)
            dirs = sorted([e for e in entries if os.path.isdir(os.path.join(path, e))])
            files = sorted([e for e in entries if os.path.isfile(os.path.join(path, e))])
            listing = f"DIRECTORY: {path}\n\nFolders:\n"
            listing += "\n".join(f"  📁 {d}" for d in dirs) or "  (none)"
            listing += "\n\nFiles:\n"
            listing += "\n".join(f"  📄 {f}" for f in files[:50]) or "  (none)"
            if len(files) > 50:
                listing += f"\n  ...and {len(files)-50} more files"
            return ToolResult(tool_name="kai_cli", content=listing, success=True)
        except Exception as e:
            return ToolResult(tool_name="kai_cli", content=f"Cannot list '{path}': {e}", success=False)

    def _kai_status(self) -> ToolResult:
        """Check KAI system status — Oracle server, OpenJarvis, lattice."""
        import requests
        lines = []
        try:
            r = requests.get("http://127.0.0.1:3333/api/status", timeout=3)
            if r.ok:
                data = r.json()
                lines.append(f"✅ Oracle Server: ONLINE")
                lines.append(f"   Lattice cells: {data.get('lattice_size', '?')}")
                lines.append(f"   Anchors (strength>4): {data.get('anchor_count', '?')}")
                lines.append(f"   Time: {data.get('time', '?')}")
            else:
                lines.append(f"⚠️  Oracle Server: HTTP {r.status_code}")
        except Exception as e:
            lines.append(f"❌ Oracle Server: OFFLINE ({e})")

        try:
            r2 = requests.get("http://127.0.0.1:8080/health", timeout=3)
            lines.append(f"{'✅' if r2.ok else '⚠️ '} OpenJarvis: {'ONLINE' if r2.ok else 'HTTP ' + str(r2.status_code)}")
        except Exception:
            lines.append("❌ OpenJarvis: OFFLINE")

        return ToolResult(tool_name="kai_cli", content="\n".join(lines), success=True)


__all__ = ["KAICLITool"]
