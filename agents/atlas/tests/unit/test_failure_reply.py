"""Unit tests for the maintenance-vs-generic failure copy in app/api.py.

Covers: model-unavailability codes (403/429/503) getting the maintenance
notice, other API errors and plain exceptions getting the generic retry copy,
and ADK's own 429 wrapper being classified as unavailable.

Run with: uv run pytest tests/unit/test_failure_reply.py -v
"""

import pytest
from google.adk.models.google_llm import _ResourceExhaustedError
from google.genai.errors import ClientError, ServerError

from app.api import _GENERIC_ERROR_REPLY, _MAINTENANCE_REPLY, _failure_reply


def _api_error(cls, code):
    """Build a genai error without going through its HTTP-response parsing."""
    err = cls.__new__(cls)
    err.code = code
    err.message = "test"
    return err


@pytest.mark.parametrize("code", [403, 429, 503])
def test_model_unavailable_codes_get_maintenance_notice(code):
    cls = ServerError if code == 503 else ClientError
    assert _failure_reply(_api_error(cls, code)) == _MAINTENANCE_REPLY


def test_adk_resource_exhausted_wrapper_is_unavailable():
    """ADK wraps quota 429s in its own ClientError subclass."""
    assert _failure_reply(_api_error(_ResourceExhaustedError, 429)) == _MAINTENANCE_REPLY


@pytest.mark.parametrize("code", [400, 404, 500])
def test_other_api_errors_get_generic_copy(code):
    """A malformed or genuinely failed request is not a maintenance window."""
    cls = ServerError if code == 500 else ClientError
    assert _failure_reply(_api_error(cls, code)) == _GENERIC_ERROR_REPLY


def test_non_api_exception_gets_generic_copy():
    assert _failure_reply(ValueError("boom")) == _GENERIC_ERROR_REPLY


def test_maintenance_copy_has_no_em_dash():
    """Repo voice rule: no em-dashes in user-facing copy."""
    assert "—" not in _MAINTENANCE_REPLY
