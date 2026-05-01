from __future__ import annotations

import re
from typing import List, Tuple

_CREDENTIAL_PATTERNS: List[Tuple[str, re.Pattern[str]]] = [
    ("api_key", re.compile("s" + "k-[a-zA-Z0-9_-]{20,}")),
    ("aws_key", re.compile("A" + "KIA[0-9A-Z]{16}")),
    ("github_token", re.compile("g" + "hp_[a-zA-Z0-9]{36}")),
    ("github_token", re.compile("g" + "ho_[a-zA-Z0-9]{36}")),
    ("slack_token", re.compile("x" + "oxb-[0-9A-Za-z\-]+")),
    ("bearer_token", re.compile(r"Bearer\s+[a-zA-Z0-9_\-.]{20,}")),
]


class CredentialStripper:
    """Redacts credentials from text using compiled regex patterns."""

    def __init__(self) -> None:
        self._patterns = _CREDENTIAL_PATTERNS

    def strip(self, text: str) -> str:
        for label, pattern in self._patterns:
            text = pattern.sub(f"[REDACTED:{label}]", text)
        return text


def wrap_tool_output(tool_name: str, content: str, success: bool = True) -> str:
    status = "success" if success else "error"
    header = f'<tool_result name="{tool_name}" status="{status}">'
    return f"{header}\n{content}\n</tool_result>"

