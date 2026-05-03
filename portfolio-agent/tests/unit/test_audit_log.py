"""Unit tests for app.app_utils.audit_log.

Tests that log_interaction:
  - is a no-op when AGENT_LOG_URL or AGENT_LOG_TOKEN are unset
  - swallows exceptions on network failure
  - swallows exceptions on non-200 status
  - sends the correct payload and headers when configured
"""
from __future__ import annotations

import importlib
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _reload_audit_log(url: str = "", token: str = ""):
    """Re-import audit_log with patched env vars so module-level constants reset."""
    env_patch = {"AGENT_LOG_URL": url, "AGENT_LOG_TOKEN": token}
    with patch.dict("os.environ", env_patch, clear=False):
        if "app.app_utils.audit_log" in sys.modules:
            del sys.modules["app.app_utils.audit_log"]
        mod = importlib.import_module("app.app_utils.audit_log")
    return mod


@pytest.mark.asyncio
async def test_noop_when_url_unset():
    """log_interaction does nothing when AGENT_LOG_URL is empty."""
    mod = _reload_audit_log(url="", token="secret")
    with patch("httpx.AsyncClient") as mock_client:
        await mod.log_interaction({"sessionId": "s", "turnIndex": 0, "question": "q",
                                   "response": "r", "status": "ok"})
    mock_client.assert_not_called()


@pytest.mark.asyncio
async def test_noop_when_token_unset():
    """log_interaction does nothing when AGENT_LOG_TOKEN is empty."""
    mod = _reload_audit_log(url="http://localhost:8787/api/agent-log", token="")
    with patch("httpx.AsyncClient") as mock_client:
        await mod.log_interaction({"sessionId": "s", "turnIndex": 0, "question": "q",
                                   "response": "r", "status": "ok"})
    mock_client.assert_not_called()


@pytest.mark.asyncio
async def test_silent_on_network_error():
    """log_interaction swallows a network connection error without raising."""
    mod = _reload_audit_log(url="http://bad-host.invalid/api/agent-log", token="tok")
    # Patch httpx.AsyncClient to raise on post
    mock_response = AsyncMock()
    mock_response.post = AsyncMock(side_effect=Exception("connection refused"))
    with patch("httpx.AsyncClient") as mock_client:
        mock_client.return_value.__aenter__ = AsyncMock(return_value=mock_response)
        mock_client.return_value.__aexit__ = AsyncMock(return_value=False)
        # Should not raise
        await mod.log_interaction({"sessionId": "s", "turnIndex": 0, "question": "q",
                                   "response": "r", "status": "ok"})


@pytest.mark.asyncio
async def test_silent_on_4xx_response():
    """log_interaction warns but does not raise on 401 from the server."""
    mod = _reload_audit_log(url="http://localhost:8787/api/agent-log", token="wrong")
    mock_response = MagicMock()
    mock_response.status_code = 401
    mock_response.text = "Unauthorized"

    mock_client_instance = AsyncMock()
    mock_client_instance.post = AsyncMock(return_value=mock_response)

    with patch("httpx.AsyncClient") as mock_client:
        mock_client.return_value.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client.return_value.__aexit__ = AsyncMock(return_value=False)
        # Should not raise
        await mod.log_interaction({"sessionId": "s", "turnIndex": 0, "question": "q",
                                   "response": "r", "status": "ok"})


@pytest.mark.asyncio
async def test_sends_correct_headers_and_payload():
    """log_interaction sends X-Internal-Token header and JSON payload."""
    url = "http://localhost:8787/api/agent-log"
    token = "my-secret-token"
    mod = _reload_audit_log(url=url, token=token)

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.text = '{"ok": true, "id": 1}'

    mock_client_instance = AsyncMock()
    mock_client_instance.post = AsyncMock(return_value=mock_response)

    payload = {
        "sessionId": "abc123",
        "turnIndex": 1,
        "question": "What projects?",
        "response": "Projects are...",
        "toolCalls": [{"name": "get_projects", "args": {}}],
        "tokensInput": 50,
        "tokensOutput": 100,
        "latencyMs": 800,
        "status": "ok",
        "errorMessage": None,
        "identity": {"sub": "sub123", "email": "x@y.com"},
        "userAgent": "test",
        "referrer": "",
        "ip": "1.2.3.x",
        "agentVersion": "abc",
    }

    with patch("httpx.AsyncClient") as mock_client:
        mock_client.return_value.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client.return_value.__aexit__ = AsyncMock(return_value=False)
        await mod.log_interaction(payload)

    mock_client_instance.post.assert_called_once()
    call_kwargs = mock_client_instance.post.call_args
    assert call_kwargs.args[0] == url
    assert call_kwargs.kwargs["headers"]["X-Internal-Token"] == token
    assert call_kwargs.kwargs["json"]["sessionId"] == "abc123"
    assert call_kwargs.kwargs["json"]["status"] == "ok"
