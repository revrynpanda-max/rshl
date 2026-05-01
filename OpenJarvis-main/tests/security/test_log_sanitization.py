"""Tests for log sanitization (Section 5)."""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path


class TestSanitizingFormatter:
    """SanitizingFormatter should redact secrets in log messages."""

    def test_redacts_openai_key(self) -> None:
        from openjarvis.cli.log_config import SanitizingFormatter

        fmt = SanitizingFormatter("%(message)s")
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="Key is openai-dummy-key",
            args=(),
            exc_info=None,
        )
        result = fmt.format(record)
        assert "dummy-sk-proj-" not in result
        assert "[REDACTED" in result

    def test_redacts_aws_key(self) -> None:
        from openjarvis.cli.log_config import SanitizingFormatter

        fmt = SanitizingFormatter("%(message)s")
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="AWS: AKIAEXAMPLE000000000",
            args=(),
            exc_info=None,
        )
        result = fmt.format(record)
        assert "AKIAEXAMPLE000000000" not in result

    def test_clean_message_unchanged(self) -> None:
        from openjarvis.cli.log_config import SanitizingFormatter

        fmt = SanitizingFormatter("%(message)s")
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="Server started on port 8000",
            args=(),
            exc_info=None,
        )
        result = fmt.format(record)
        assert result == "Server started on port 8000"

    def test_redacts_slack_token(self) -> None:
        from openjarvis.cli.log_config import SanitizingFormatter

        fmt = SanitizingFormatter("%(message)s")
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="Token: xoxb-EXAMPLE",
            args=(),
            exc_info=None,
        )
        result = fmt.format(record)
        assert "xoxb-" not in result


class TestScopedCredentialAccess:
    """get_tool_credential should return values without polluting os.environ."""

    def test_returns_credential_value(self) -> None:
        from openjarvis.core.credentials import get_tool_credential

        with tempfile.NamedTemporaryFile(mode="w", suffix=".toml", delete=False) as f:
            f.write('[slack]\nSLACK_BOT_TOKEN = "xoxb-test-token"\n')
            f.flush()
            result = get_tool_credential("slack", "SLACK_BOT_TOKEN", path=Path(f.name))
            assert result == "xoxb-test-token"
            assert os.environ.get("SLACK_BOT_TOKEN") != "xoxb-test-token"
        os.unlink(f.name)

    def test_returns_none_for_missing(self) -> None:
        from openjarvis.core.credentials import get_tool_credential

        with tempfile.NamedTemporaryFile(mode="w", suffix=".toml", delete=False) as f:
            f.write("[slack]\n")
            f.flush()
            result = get_tool_credential("slack", "SLACK_BOT_TOKEN", path=Path(f.name))
            assert result is None
        os.unlink(f.name)

    def test_returns_none_for_missing_file(self) -> None:
        from openjarvis.core.credentials import get_tool_credential

        result = get_tool_credential(
            "slack", "SLACK_BOT_TOKEN", path=Path("/nonexistent/file.toml")
        )
        assert result is None


