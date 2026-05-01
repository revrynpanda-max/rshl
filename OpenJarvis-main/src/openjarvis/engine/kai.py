"""KAI (Recursive Sparse Hyperdimensional Lattice) Engine backend.

Bridges OpenJarvis reasoning to KAI's Oracle server.
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator, Sequence
from typing import Any, Dict, List

import httpx

from openjarvis.core.registry import EngineRegistry
from openjarvis.core.types import Message
from openjarvis.engine._base import (
    EngineConnectionError,
    InferenceEngine,
    messages_to_dicts,
)

logger = logging.getLogger(__name__)


@EngineRegistry.register("kai")
class KAIEngine(InferenceEngine):
    """Engine that delegates reasoning to KAI's Oracle server."""

    engine_id = "kai"
    _DEFAULT_HOST = "http://localhost:3333"

    def __init__(
        self,
        host: str | None = None,
        *,
        timeout: float = 180.0,
    ) -> None:
        # Priority: explicit host > KAI_ORACLE_HOST env var > default
        if host is None:
            env_host = os.environ.get("KAI_ORACLE_HOST")
            host = env_host or self._DEFAULT_HOST
        self._host = host.rstrip("/")
        self._client = httpx.Client(base_url=self._host, timeout=timeout)

    def generate(
        self,
        messages: Sequence[Message],
        *,
        model: str = "kai-oracle",
        temperature: float = 0.7,
        max_tokens: int = 1024,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """Send the last user message to KAI for reasoning."""
        input_text = ""
        # Find the last user message
        for m in reversed(messages):
            if m.role.value == "user" and m.content:
                input_text = m.content
                break

        if not input_text:
            return {
                "content": "No user input found.",
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                "model": model,
                "finish_reason": "stop",
            }

        try:
            # Oracle turn endpoint
            resp = self._client.post(
                "/api/oracle-turn",
                json={"input": input_text},
                timeout=timeout,
            )
            resp.raise_for_status()
            data = resp.json()
            
            content = data.get("response", "")
            
            return {
                "content": content,
                "usage": {
                    "prompt_tokens": data.get("prompt_tokens", 0),
                    "completion_tokens": data.get("completion_tokens", 0),
                    "total_tokens": data.get("total_tokens", 0),
                },
                "model": model,
                "finish_reason": "stop",
            }
        except (httpx.ConnectError, httpx.TimeoutException) as exc:
            raise EngineConnectionError(
                f"KAI Oracle not reachable at {self._host}"
            ) from exc
        except httpx.HTTPStatusError as exc:
            body = exc.response.text[:500] if exc.response else ""
            raise RuntimeError(
                f"KAI Oracle returned {exc.response.status_code}: {body}"
            ) from exc

    async def stream(
        self,
        messages: Sequence[Message],
        *,
        model: str = "kai-oracle",
        temperature: float = 0.7,
        max_tokens: int = 1024,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """KAI Oracle doesn't support streaming yet; return full response as one chunk."""
        res = self.generate(
            messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs
        )
        yield res["content"]

    def list_models(self) -> List[str]:
        """Return the available KAI 'models'."""
        return ["kai-oracle", "kai-rshl"]

    def health(self) -> bool:
        """Check if KAI Oracle is alive."""
        try:
            # We assumeport 3333 has some endpoint we can hit
            resp = self._client.get("/api/rshl/query", params={"query": "health"}, timeout=2.0)
            return resp.status_code != 404
        except Exception:
            return False

    def close(self) -> None:
        self._client.close()


__all__ = ["KAIEngine"]
