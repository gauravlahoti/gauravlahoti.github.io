"""Unit tests for the ambient agent's data + send tools.

Covers:
  app.app_utils.ambient_data — GET/POST to the Worker's /api/ambient/* endpoints
  app.app_utils.ambient_send — digest/draft emails via the Resend MCP path

Both modules read env at call time and never raise, so we patch os.environ and
mock the transport (httpx for data, _send_via_mcp for send).
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.app_utils import ambient_data, ambient_send

_ENV = {
    "AGENT_LOG_URL": "http://localhost:8787/api/agent-log",
    "AGENT_LOG_TOKEN": "tok-123",
}


def _mock_client(mock_response: MagicMock) -> MagicMock:
    """Build a patched httpx.AsyncClient whose get/post return mock_response."""
    instance = AsyncMock()
    instance.get = AsyncMock(return_value=mock_response)
    instance.post = AsyncMock(return_value=mock_response)
    client = MagicMock()
    client.return_value.__aenter__ = AsyncMock(return_value=instance)
    client.return_value.__aexit__ = AsyncMock(return_value=False)
    return client, instance


@pytest.mark.asyncio
async def test_interactions_returns_empty_when_unconfigured():
    with patch.dict("os.environ", {"AGENT_LOG_URL": "", "AGENT_LOG_TOKEN": ""}, clear=False):
        with patch("httpx.AsyncClient") as mc:
            out = await ambient_data.get_recent_interactions(days=3)
    assert out == []
    mc.assert_not_called()


@pytest.mark.asyncio
async def test_interactions_sends_token_and_derives_url():
    resp = MagicMock(status_code=200)
    resp.json.return_value = {"interactions": [{"question": "q", "status": "ok"}]}
    client, instance = _mock_client(resp)
    with patch.dict("os.environ", _ENV, clear=False):
        with patch("httpx.AsyncClient", client):
            out = await ambient_data.get_recent_interactions(days=7)
    assert out == [{"question": "q", "status": "ok"}]
    call = instance.get.call_args
    assert call.args[0] == "http://localhost:8787/api/ambient/interactions"
    assert call.kwargs["params"] == {"days": 7}
    assert call.kwargs["headers"]["X-Internal-Token"] == "tok-123"


@pytest.mark.asyncio
async def test_interactions_empty_on_http_error():
    resp = MagicMock(status_code=500, text="boom")
    client, _ = _mock_client(resp)
    with patch.dict("os.environ", _ENV, clear=False):
        with patch("httpx.AsyncClient", client):
            out = await ambient_data.get_recent_interactions()
    assert out == []


@pytest.mark.asyncio
async def test_pending_leads_parses_payload():
    resp = MagicMock(status_code=200)
    resp.json.return_value = {"leads": [{"id": 1, "email": "a@b.com", "name": "A"}]}
    client, instance = _mock_client(resp)
    with patch.dict("os.environ", _ENV, clear=False):
        with patch("httpx.AsyncClient", client):
            out = await ambient_data.get_pending_leads()
    assert out[0]["id"] == 1
    assert instance.get.call_args.args[0] == "http://localhost:8787/api/ambient/leads"


@pytest.mark.asyncio
async def test_mark_leads_done_posts_ids():
    resp = MagicMock(status_code=200)
    resp.json.return_value = {"ok": True, "marked": 2}
    client, instance = _mock_client(resp)
    with patch.dict("os.environ", _ENV, clear=False):
        with patch("httpx.AsyncClient", client):
            out = await ambient_data.mark_leads_done([1, 2])
    assert out == {"ok": True, "marked": 2}
    call = instance.post.call_args
    assert call.args[0] == "http://localhost:8787/api/ambient/leads/mark"
    assert call.kwargs["json"] == {"ids": [1, 2]}


@pytest.mark.asyncio
async def test_mark_leads_done_filters_invalid_ids():
    client, instance = _mock_client(MagicMock(status_code=200))
    with patch.dict("os.environ", _ENV, clear=False):
        with patch("httpx.AsyncClient", client):
            out = await ambient_data.mark_leads_done([0, -1, "x"])  # type: ignore[list-item]
    # no valid ids → no POST, returns marked:0
    assert out == {"ok": True, "marked": 0}
    instance.post.assert_not_called()


_SEND_ENV = {
    "GAURAV_CONTACT_EMAIL": "gaurav@example.com",
    "NOTE_FROM_ADDRESS": "agent@gauravlahoti.dev",
    "RESEND_MCP_URL": "https://mcp.example/mcp",
}


@pytest.mark.asyncio
async def test_digest_email_goes_only_to_gaurav():
    with patch.dict("os.environ", _SEND_ENV, clear=False):
        with patch(
            "app.app_utils.ambient_send._send_via_mcp",
            new=AsyncMock(return_value=(True, None)),
        ) as mock_send:
            out = await ambient_send.send_digest_email("<strong>Themes</strong>")
    assert out["ok"] is True
    args = mock_send.call_args.args[0]
    assert args["to"] == ["gaurav@example.com"]  # hardcoded recipient
    assert args["from"] == "agent@gauravlahoti.dev"


@pytest.mark.asyncio
async def test_lead_drafts_not_configured_without_inbox():
    env = {**_SEND_ENV, "GAURAV_CONTACT_EMAIL": ""}
    with patch.dict("os.environ", env, clear=False):
        with patch(
            "app.app_utils.ambient_send._send_via_mcp",
            new=AsyncMock(return_value=(True, None)),
        ) as mock_send:
            out = await ambient_send.send_lead_drafts("<h4>Lead</h4>")
    assert out["ok"] is False
    assert out["code"] == "not_configured"
    mock_send.assert_not_called()
