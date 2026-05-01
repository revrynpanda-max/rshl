"""RSHL (Recursive Sparse Hyperdimensional Lattice) Storage Backend.

Bridges OpenJarvis to KAI's native geometric intelligence engine via the Oracle API.
"""

from __future__ import annotations

import requests
from typing import Any, Dict, List, Optional

from openjarvis.core.registry import MemoryRegistry
from openjarvis.tools.storage._stubs import MemoryBackend, RetrievalResult


@MemoryRegistry.register("rshl")
class RSHLBackend(MemoryBackend):
    """Memory backend that utilizes KAI's RSHL engine.
    
    This backend requires the KAI Oracle server to be running on port 3333.
    """

    def __init__(self, oracle_url: str = "http://127.0.0.1:3333", **kwargs: Any):
        self.oracle_url = oracle_url
        self.backend_id = "rshl"

    def count(self) -> int:
        """Return number of entries (not supported by RSHL API, return -1)."""
        return -1

    def store(
        self,
        content: str,
        *,
        source: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Store content in KAI's RSHL lattice."""
        payload = {
            "text": content,
            "source": source or "openjarvis",
        }
        if metadata:
            if "region" in metadata:
                payload["region"] = metadata["region"]
            if "strength" in metadata:
                payload["strength"] = metadata["strength"]

        try:
            # Oracle RSHL store endpoint
            resp = requests.post(
                f"{self.oracle_url}/api/rshl/store", 
                json=payload, 
                timeout=5
            )
            resp.raise_for_status()
            return "ok"
        except Exception as e:
            # Non-fatal: if RSHL is down, we just don't store there
            print(f"RSHL Store failed: {e}")
            return "failed"

    def retrieve(
        self,
        query: str,
        *,
        top_k: int = 5,
        **kwargs: Any,
    ) -> List[RetrievalResult]:
        """Query KAI's RSHL lattice for semantic hits."""
        try:
            # Oracle RSHL query endpoint
            resp = requests.post(
                f"{self.oracle_url}/api/rshl/query",
                json={"query": query, "limit": top_k},
                timeout=5
            )
            resp.raise_for_status()
            hits = resp.json()
            
            results = []
            for hit in hits:
                results.append(
                    RetrievalResult(
                        content=hit.get("text", ""),
                        score=hit.get("score", 0.0),
                        source=hit.get("source", "rshl"),
                        metadata={
                            "region": hit.get("region", "unknown"),
                            "strength": hit.get("strength", 1.0),
                            "label": hit.get("label", "")
                        }
                    )
                )
            return results
        except Exception as e:
            print(f"RSHL Retrieval failed: {e}")
            return []

    def delete(self, doc_id: str) -> bool:
        """Deletion not supported in RSHL via API yet."""
        return False

    def clear(self) -> None:
        """Clearing not supported in RSHL via API."""
        pass


__all__ = ["RSHLBackend"]
