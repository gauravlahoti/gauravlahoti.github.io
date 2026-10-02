"""Unit tests for the ambient agent's data + send tools.

Covers:
  app.app_utils.ambient_data — GET to the Worker's /api/ambient/* endpoints
  app.app_utils.ambient_send — the digest email via the Resend MCP path

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
            out = await ambient_data.get_recent_interactions()
    assert out == []
    mc.assert_not_called()


@pytest.mark.asyncio
async def test_interactions_sends_token_and_derives_url():
    resp = MagicMock(status_code=200)
    resp.json.return_value = {"interactions": [{"question": "q", "status": "ok"}]}
    client, instance = _mock_client(resp)
    with patch.dict("os.environ", _ENV, clear=False):
        with patch("httpx.AsyncClient", client):
            out = await ambient_data.get_recent_interactions()
    assert out == [{"question": "q", "status": "ok"}]
    call = instance.get.call_args
    assert call.args[0] == "http://localhost:8787/api/ambient/interactions"
    # Spec 84: the report period, not a day count.
    assert set(call.kwargs["params"]) == {"from", "to", "prev_from", "prev_to"}
    assert call.kwargs["headers"]["X-Internal-Token"] == "tok-123"


@pytest.mark.asyncio
async def test_interactions_empty_on_http_error():
    resp = MagicMock(status_code=500, text="boom")
    client, _ = _mock_client(resp)
    with patch.dict("os.environ", _ENV, clear=False):
        with patch("httpx.AsyncClient", client):
            out = await ambient_data.get_recent_interactions()
    assert out == []


_SEND_ENV = {
    "GAURAV_CONTACT_EMAIL": "gaurav@example.com",
    "NOTE_FROM_ADDRESS": "agent@gauravlahoti.dev",
    "RESEND_MCP_URL": "https://mcp.example/mcp",
}

# Spec 84: the shape /api/ambient/stats returns now (src/digest.js).
_STATS = {
    "window_days": 4,
    "all_time": {"pageviews": 1280, "unique_visitors": 904, "conversations": 47},
    "window": {"pageviews": 210, "unique_visitors": 150, "conversations": 9,
               "agent_turns": 30, "agent_errors": 1},
    "prev_window": {"pageviews": 180, "unique_visitors": 120, "conversations": 6},
    "modes": [
        {"mode": "avatar", "turns": 14, "sessions": 3, "avatar_seconds": 150.0, "median_first_ms": 1300},
        {"mode": "text", "turns": 10, "sessions": 4, "avatar_seconds": 0, "median_first_ms": 2400},
        {"mode": "convo", "turns": 6, "sessions": 2, "avatar_seconds": 60.0, "median_first_ms": 800},
    ],
    "prev_modes": [{"mode": "avatar", "turns": 4, "sessions": 1, "avatar_seconds": 60.0}],
    "statuses": [{"status": "ok", "count": 25}, {"status": "interrupted", "count": 4},
                 {"status": "error", "count": 1}],
    "top_pages": [{"path": "/", "views": 120, "visitors": 90},
                  {"path": "/ai-labs/mcp-lab/", "views": 30, "visitors": 22}],
    "top_referrers": [{"source": "linkedin", "views": 80}, {"source": "direct", "views": 40}],
    "emails": {"resumes": 2, "notes": 1, "failures": 0},
    "fallback": {"turns": 10, "fell_back": 1},
    "top_posts": [{"post_id": "7500058000000000001", "reactions": 120, "comments": 14, "reposts": 3}],
    "top_questions": [{"question": "What is he writing about on LinkedIn?", "count": 4}],
    "geo": [{"country": "IN", "city": "Gurugram", "count": 8}],
    "errors": [{"question": "Show me Pulse", "status": "error", "error_message": "TimeoutError"}],
    "geo_points": [
        {"lat": 37.4, "lon": -122.1, "city": "San Jose", "country": "US", "visitors": 14, "chatted": 3},
        {"lat": 12.9, "lon": 77.6, "city": "Bengaluru", "country": "IN", "visitors": 18, "chatted": 4},
        {"lat": 28.6, "lon": 77.2, "city": "New Delhi", "country": "IN", "visitors": 11, "chatted": 0},
        {"lat": None, "lon": None, "city": None, "country": "DE", "visitors": 2, "chatted": 0},
    ],
    "map_days": 30,
    "countries": [{"country": "US", "visitors": 70}, {"country": "IN", "visitors": 60}, {"country": "GB", "visitors": 10},
                  {"country": "DE", "visitors": 10}],
    "daily": [{"day": f"2026-09-{d:02d}", "visitors": d % 7 + 3, "chats": d % 3, "avatar_chats": d % 2}
              for d in range(17, 31)],
    "hours": [2, 1, 1, 0, 0, 1, 2, 3, 4, 6, 8, 9, 10, 9, 8, 7, 6, 5, 5, 6, 9, 12, 10, 6],
    "funnel": {"sessions": 160, "chatted": 9, "avatar": 5, "emailed": 3},
    # Thu 1 Oct 08:00 IST -> Mon 5 Oct 08:00 IST, vs the same days a week earlier
    "period": {"from": 1790821800, "to": 1791167400, "prev_from": 1790217000, "prev_to": 1790562600},
    "usage_mtd": [{"model": "gemini-3.8-live", "turns": 20, "tokens_in": 0, "tokens_out": 0, "avatar_seconds": 210.0},
                  {"model": "gemini-3.6-flash", "turns": 10, "tokens_in": 2_000_000, "tokens_out": 100_000,
                   "avatar_seconds": 0}],
    "model_spend_usd": {"tokens": 0.36, "avatar": 1.36, "total": 1.72, "avatar_seconds": 210.0},
}
_COST = {
    "ok": True, "currency": "INR", "mtd": 312.4, "per_day": 31.0, "forecast": 930.0, "usd_rate": 88.0,
    "daily": [31.0] * 9 + [33.4], "days_in_month": 30,
    "by_service": [{"service": "Cloud Run", "mtd": 290.0}, {"service": "Secret Manager", "mtd": 15.0},
                   {"service": "Other", "mtd": 7.4}],
    "budget": 1200.0, "over_budget": False, "stale": False, "month_start": False,
    "top_services": [{"service": "Cloud Run", "mtd": 290.0}, {"service": "Secret Manager", "mtd": 15.0}],
    "movers": [],
    "always_on": [{"service": "atlas", "min_instances": 1, "expected": True}],
}
_TITLES = {"7500058000000000001": "My website's AI agent used to only type."}
_PERF = {"ok": True, "score": 82, "metrics": {"lcp": "2.9 s", "fcp": "1.4 s", "tbt": "120 ms", "cls": "0.01"},
         "opportunities": [{"title": "Reduce unused JavaScript", "savings_ms": 900}], "field": None}
def _run_context():
    """A ToolContext stand-in: two Gemini calls in this run, one from an older run."""
    from types import SimpleNamespace
    um = lambda i, o, t: SimpleNamespace(prompt_token_count=i, candidates_token_count=o, thoughts_token_count=t)  # noqa: E731
    events = [
        SimpleNamespace(invocation_id="old", usage_metadata=um(9, 9, 9), model_version="gemini-3.8-flash"),
        SimpleNamespace(invocation_id="inv", usage_metadata=um(40_000, 1_000, 4_000), model_version="gemini-3.8-flash"),
        SimpleNamespace(invocation_id="inv", usage_metadata=None, model_version=None),
        SimpleNamespace(invocation_id="inv", usage_metadata=um(50_000, 2_000, 3_000), model_version="gemini-3.8-flash"),
    ]
    return SimpleNamespace(invocation_id="inv", session=SimpleNamespace(events=events))


_TLDR = ["Visitors up a quarter, mostly from LinkedIn.", "Scale intake to zero.", "<b>All clear</b>, spend on track."]
_RECS = [
    {"area": "cost", "title": "Scale intake to zero", "problem": "intake holds an idle instance all day.",
     "action": "Set min-instances to 0 on intake.", "tangible": "About 960 rupees a month.",
     "intangible": "One less thing running unwatched.", "effort": "S", "confidence": 90},
    {"area": "website", "title": "Trim unused JavaScript", "problem": "LCP is 2.9s against a 1.5s budget.",
     "action": "Defer the hero graph module.", "tangible": "Up to 0.9s off LCP.",
     "intangible": "Faster first impression for recruiters.", "effort": "M", "confidence": 70},
    {"area": "nonsense", "title": "<b>Bad</b>", "problem": "p", "action": "a", "tangible": "", "intangible": "",
     "effort": "XL", "confidence": 400},
    {"title": "missing fields"},
]


@pytest.mark.asyncio
async def test_visitor_stats_fetch():
    resp = MagicMock(status_code=200)
    resp.json.return_value = _STATS
    client, instance = _mock_client(resp)
    with patch.dict("os.environ", _ENV, clear=False):
        with patch("httpx.AsyncClient", client):
            out = await ambient_data.get_visitor_stats()
    assert out["all_time"]["pageviews"] == 1280
    assert instance.get.call_args.args[0] == "http://localhost:8787/api/ambient/stats"
    params = instance.get.call_args.kwargs["params"]
    assert params["prev_to"] - params["to"] == -7 * 86400 and params["prev_from"] == params["from"] - 7 * 86400
    assert out["model_spend_usd"]["avatar_seconds"] == 210.0


def _email(stats=_STATS, cost=_COST, titles=_TITLES, recs=_RECS, perf=_PERF):
    html, _ = ambient_send.build_email(stats, cost, titles, _TLDR,
                                       "<p><strong>Themes</strong></p>", recs, perf)
    return html


def test_email_renders_every_section():
    html = _email()
    for section in ("Recommendations", "How people talk to Atlas", "Where visitors are", "When they visit",
                    "Journey", "What they asked", "What they explored", "Reach", "Health", "Cost watch"):
        assert section in html, section
    assert "▲ 25%" in html                                # 150 vs 120 visitors
    assert "3.5" in html                                  # avatar minutes: (150+60)/60
    assert "MCP Lab" in html and "LinkedIn" in html       # page names, sources
    assert "₹312" in html and "₹930 by month end" in html  # spend and forecast
    assert "talked over the avatar on 20%" in html        # 4 of 20 spoken turns
    assert "Turns that errored" in html                   # health shows the error
    assert "TTFT" in html and "first word" not in html    # the industry term
    assert "🇺🇸" in html and "🇮🇳" in html                # country split with flags
    assert "Busiest hour: 21:00 IST" in html              # the heatmap caption
    assert "Website speed (mobile Lighthouse)" in html and ">82<" in html


def test_every_inline_image_is_attached_and_described():
    import re
    html, images = ambient_send.build_email(_STATS, _COST, _TITLES, _TLDR, "", _RECS, _PERF)
    cids = re.findall(r'src="cid:([a-z]+)"', html)
    assert sorted(cids) == sorted(c for c, _, _ in images)
    assert {"trend", "modes", "map", "pace", "spend"} <= set(cids)
    for cid, png, alt in images:
        assert png[:8] == b"\x89PNG\r\n\x1a\n", cid
        assert alt and f'alt="' in html
    assert len(html.encode()) < 60_000                    # far from Gmail's ~102 KB clip


def test_a_failed_chart_falls_back_to_html(monkeypatch):
    from app.app_utils import charts
    monkeypatch.setattr(charts, "donut", lambda *a, **k: None)
    monkeypatch.setattr(charts, "visitor_map", lambda *a, **k: None)
    html, images = ambient_send.build_email(_STATS, _COST, _TITLES, _TLDR, "", _RECS, _PERF)
    assert "cid:modes" not in html and "cid:map" not in html
    assert "How people talk to Atlas" in html             # stacked-bar fallback still renders
    assert "Where visitors are" in html                   # the country split still renders


def test_recommendations_are_validated_and_escaped():
    recs = ambient_send.clean_recommendations(_RECS)
    assert [r["title"] for r in recs] == ["Scale intake to zero", "Trim unused JavaScript", "Bad"]
    assert recs[2]["area"] == "agents" and recs[2]["effort"] == "M" and recs[2]["confidence"] == 95
    html = _email()
    assert "1. Scale intake to zero" in html and "2. Trim unused JavaScript" in html
    assert "About 960 rupees a month." in html and "Faster first impression" in html
    assert "<b>Bad</b>" not in html
    assert ambient_send.clean_recommendations("not a list") == []


def test_tldr_sits_under_the_header_and_previews_the_inbox():
    html = _email()
    assert html.index(">TL;DR") < html.index("Visitors</div>") < html.index("Cost watch") < html.index("Recommendations")
    assert html.index("Recommendations") > html.index("Health")   # last section, right before the footer
    assert "Visitors up a quarter, mostly from LinkedIn." in html
    assert "<b>All clear</b>" not in html and "All clear, spend on track." in html
    # The first bullet is the hidden preheader, before anything visible.
    assert html.index("display:none") < html.index("Gauravlahoti.dev Weekly Pulse")
    assert ambient_send.clean_tldr(["a", "", "- b", "c", "d"]) == ["a", "b", "c"]


def test_tldr_falls_back_to_the_numbers_when_the_agent_gives_none():
    html, _ = ambient_send.build_email(_STATS, _COST, _TITLES, [], "", _RECS, _PERF)
    assert "150 visitors (120 the same days last week), 9 chats with Atlas, 5 avatar chats." in html
    assert "Top action: Scale intake to zero." in html
    assert "on pace for ₹930, within budget." in html


def test_header_names_the_report_and_its_period():
    from datetime import datetime
    html, _ = ambient_send.build_email(_STATS, _COST, _TITLES, _TLDR, "", _RECS, _PERF,
                                       now=datetime(2026, 10, 5, 8, 0, tzinfo=ambient_send.IST))
    assert "Gauravlahoti.dev Weekly Pulse" in html and "Mon 5 Oct 2026" in html
    assert "Every Monday and Thursday, 08:00 IST" in html
    assert "Thu 1 Oct 08:00 to Mon 5 Oct 08:00" in html and "since the last report, 4 days" in html
    assert "the same days last week, 24 Sep to 28 Sep" in html
    assert html.index("Compared with") < html.index(">TL;DR")
    header = html[:html.index(">TL;DR")]
    assert "✦" not in header                   # no tag in the header; About this report covers it


def test_no_section_states_its_own_fixed_window():
    # Spec 84: one period for everything; only the trend (14 days, context)
    # and cost (this month) differ, and they say so.
    html = _email()
    assert "last 4 days" not in html and "last 30 days" not in html
    assert "for context, beyond this period" in html and "so far this month" in html


def test_cost_watch_lists_every_source():
    html = _email()
    assert "Where the money goes" in html
    assert "Google Cloud infrastructure" in html and "actual, from the bill" in html
    assert "Gemini and the avatar (adk-deploy-trail)" in html and "estimate at list price, from Atlas usage" in html
    assert "₹151" in html                    # 1.72 USD at Google's 88 rupee rate
    # adk-deploy-trail runs on free credits: shown, but only the bill is charged.
    assert "free credits" in html and "Total charged so far this month" in html
    assert "<strong>₹312</strong>" in html
    # Free-tier services sit outside the table and the total, and say so.
    rows = ambient_send.cost_sources(_COST, _STATS)
    assert not any("Cloudflare" in name for name, _, _ in rows)
    assert "Free tier, not in the total: Cloudflare Worker + database, Resend email, GitHub Pages" in html
    rows = ambient_send.cost_sources({"ok": False}, {"model_spend_usd": {"total": 2.5}})
    assert rows[0][1] == "not connected" and rows[1][1] == "$2.50"   # no rate: shown in USD


def test_billed_models_count_in_the_total(monkeypatch):
    monkeypatch.setenv("PULSE_MODELS_BILLED", "1")
    html = _email()
    assert "<strong>₹464</strong>" in html and "free credits" not in html   # 312.4 + 151.36, rounded


def test_header_has_no_headline_line():
    html = _email()
    header = html[:html.index(">TL;DR")]
    assert "border-top:1px solid #262626" not in header


def test_cloud_run_is_split_into_its_services():
    rows = ambient_data.split_cloud_run(300.0, {"atlas": 600.0, "pulse": 30.0, "resend-mcp-server": 0.0, "agentic-rag": 120.0})
    assert [r["service"] for r in rows] == ["atlas", "agentic-rag", "pulse"]
    assert rows[0]["mtd"] == 240.0 and sum(r["mtd"] for r in rows) == 300.0
    assert ambient_data.split_cloud_run(0, {"atlas": 1}) == [] and ambient_data.split_cloud_run(5, None) == []
    cost = {**_COST, "cloud_run_services": rows}
    parts = ambient_send.spend_parts(cost)
    assert [p["service"] for p in parts][:2] == ["Cloud Run: atlas", "Cloud Run: agentic-rag"]
    assert round(sum(p["mtd"] for p in parts), 2) == round(300.0 + 15.0 + 7.4, 2)   # nothing lost
    html, images = ambient_send.build_email(_STATS, cost, _TITLES, _TLDR, "", _RECS, _PERF)
    assert "Cloud Run: atlas ₹240" in next(alt for cid, _, alt in images if cid == "spend")
    assert "split across services by each one" in html


def test_report_period_tiles_the_twice_weekly_schedule():
    from datetime import datetime, timedelta
    IST = ambient_data.IST
    mon = ambient_data.report_period(datetime(2026, 10, 5, 8, 0, 30, tzinfo=IST))
    thu = ambient_data.report_period(datetime(2026, 10, 8, 8, 1, tzinfo=IST))
    adhoc = ambient_data.report_period(datetime(2026, 10, 7, 15, 0, tzinfo=IST))
    assert mon["start"] == datetime(2026, 10, 1, 8, 0, tzinfo=IST)          # Thu -> Mon, 4 days
    assert thu["start"] == datetime(2026, 10, 5, 8, 0, tzinfo=IST)          # Mon -> Thu, 3 days
    assert adhoc["start"] == datetime(2026, 10, 5, 8, 0, tzinfo=IST)        # ad-hoc: since Monday
    assert thu["from"] - mon["to"] < 120                                     # no gap, no overlap
    for p in (mon, thu, adhoc):
        assert p["from"] - p["prev_from"] == p["to"] - p["prev_to"] == 7 * 86400


def test_resume_downloads_are_gone():
    # Spec 84: the gate that produced downloads was retired 2026-06-10.
    html = _email()
    assert "Download" not in html and "download" not in html


def test_empty_stats_still_render_and_hide_empty_sections():
    html, images = ambient_send.build_email({}, {}, {}, [], "", [], {})
    assert "nobody talked to Atlas" in html
    for hidden in ("How people talk to Atlas", "Recommendations", "Where visitors are", "When they visit",
                   "Journey", "Last 14 days"):
        assert hidden not in html, hidden
    assert "All clear" in html
    assert images == []


def test_cost_unavailable_degrades_but_still_flags_leaks():
    cost = {"ok": False, "reason": "not_configured",
            "always_on": [{"service": "intake", "min_instances": 1, "expected": False}]}
    html = _email(cost=cost)
    assert "export isn" in html.lower() and "connected yet" in html.lower()
    assert "intake" in html and "running all day" in html
    assert "no billing data" in html


def test_expected_always_on_service_is_not_flagged():
    assert "running all day" not in _email()   # atlas is on purpose


def test_subject_is_informative_and_dash_free():
    subject = ambient_send.build_subject(_STATS, _COST)
    assert subject == "Weekly Pulse · 150 visitors · 5 avatar chats · ₹312 this month"
    assert "-" not in subject and "—" not in subject
    assert ambient_send.build_subject({}, {}) == "Weekly Pulse · 0 visitors · 0 avatar chats"


def test_summarize_costs_forecasts_from_recent_run_rate():
    from datetime import datetime, timezone
    raw = {
        "currency": "INR",
        "by_service": [{"service": s, "mtd": v} for s, v in
                       [("Cloud Run", 300.0), ("Secret Manager", 10.0), ("AR", 4.0), ("Build", 2.0), ("Logs", 1.0), ("DNS", 0.5)]],
        "daily": [{"day": f"2026-09-{d:02d}", "total": 10.0} for d in range(1, 11)]
                 + [{"day": f"2026-09-{d:02d}", "total": 40.0} for d in range(11, 21)],
        "weeks": [{"service": "Cloud Run", "this_week": 280.0, "last_week": 70.0},
                  {"service": "Cloud Build", "this_week": 1.0, "last_week": 0.0}],
        "export_latest": "2026-09-20 10:00:00.123456+00",
    }
    out = ambient_data.summarize_costs(raw, 1200.0, datetime(2026, 9, 20, 12, tzinfo=timezone.utc))
    assert out["mtd"] == 317.5
    assert out["per_day"] == 40.0              # last 7 days, not the month's average
    assert out["forecast"] == 317.5 + 40.0 * 10
    assert out["over_budget"] is False
    assert [m["service"] for m in out["movers"]] == ["Cloud Run"]   # tiny Cloud Build ignored
    assert out["stale"] is False
    assert len(out["daily"]) == 20 and out["days_in_month"] == 30
    assert [s["service"] for s in out["by_service"]] == ["Cloud Run", "Secret Manager", "AR", "Build", "Other"]
    assert out["by_service"][-1]["mtd"] == 1.5


def test_summarize_psi_keeps_score_metrics_and_top_savings():
    data = {
        "lighthouseResult": {
            "categories": {"performance": {"score": 0.82}},
            "audits": {
                "largest-contentful-paint": {"displayValue": "2.9 s"},
                "total-blocking-time": {"displayValue": "120 ms"},
                "unused-javascript": {"title": "Reduce unused JavaScript",
                                      "details": {"type": "opportunity", "overallSavingsMs": 900}},
                "tiny": {"title": "Tiny", "details": {"type": "opportunity", "overallSavingsMs": 20}},
            },
        },
        "loadingExperience": {"metrics": {"LARGEST_CONTENTFUL_PAINT_MS": {"category": "AVERAGE"}}},
    }
    out = ambient_data.summarize_psi(data)
    assert out["score"] == 82 and out["metrics"]["lcp"] == "2.9 s"
    assert out["opportunities"] == [{"title": "Reduce unused JavaScript", "savings_ms": 900}]
    assert out["field"] == {"largest_contentful_paint_ms": "AVERAGE"}


@pytest.mark.asyncio
async def test_cost_summary_without_token_is_not_configured():
    with patch.dict("os.environ", {**_ENV, "COST_MONITOR_TOKEN": ""}, clear=False):
        with patch.object(ambient_data, "_always_on_services", new=AsyncMock(return_value=None)):
            out = await ambient_data.get_cost_summary()
    assert out == {"ok": False, "reason": "not_configured", "always_on": None}


@pytest.mark.asyncio
async def test_review_email_single_send_to_gaurav():
    with patch.dict("os.environ", _SEND_ENV, clear=False):
        with patch("app.app_utils.ambient_send.get_visitor_stats", new=AsyncMock(return_value=_STATS)), \
             patch("app.app_utils.ambient_send.get_cost_summary", new=AsyncMock(return_value=_COST)), \
             patch("app.app_utils.ambient_send.get_post_titles", new=AsyncMock(return_value=_TITLES)), \
             patch("app.app_utils.ambient_send.get_site_performance", new=AsyncMock(return_value=_PERF)):
            with patch("app.app_utils.ambient_send._send_via_mcp",
                       new=AsyncMock(return_value=(True, None, 1))) as mock_send:
                out = await ambient_send.send_review_email(_TLDR, "<strong>Themes</strong>", _RECS, _run_context())
    assert out["ok"] is True
    mock_send.assert_called_once()                       # exactly ONE email
    args = mock_send.call_args.args[0]
    assert args["to"] == ["gaurav@example.com"]          # hardcoded recipient
    assert args["subject"].startswith("Weekly Pulse · 150 visitors")
    assert "Themes" in args["html"]
    # It says what Gemini wrote and what this run cost: 90k in, 10k out
    # (7k thinking) at 0.75 / 3.75 per 1M = 0.105 USD.
    assert "✦ Powered by Gemini 3.8 Flash" in args["html"]
    assert "2 model calls · 90,000 input tokens · 10,000 output tokens, 7,000 of them thinking" in args["html"]
    assert "about $0.105 (₹9.24)" in args["html"]
    # Charts travel as inline attachments the HTML references by cid.
    cids = {a["contentId"] for a in args["attachments"]}
    assert {"map", "trend", "pace"} <= cids
    assert all(f"cid:{c}" in args["html"] for c in cids)
    assert all(a["contentType"] == "image/png" and a["content"] for a in args["attachments"])
    # Resend MCP rejects the send without a text part (regression guard #60).
    assert isinstance(args.get("text"), str) and args["text"].strip()
    assert "<" not in args["text"]


@pytest.mark.asyncio
async def test_review_email_not_configured_without_inbox():
    env = {**_SEND_ENV, "GAURAV_CONTACT_EMAIL": ""}
    with patch.dict("os.environ", env, clear=False):
        with patch("app.app_utils.ambient_send.get_visitor_stats", new=AsyncMock(return_value=_STATS)), \
             patch("app.app_utils.ambient_send.get_cost_summary", new=AsyncMock(return_value=_COST)), \
             patch("app.app_utils.ambient_send.get_post_titles", new=AsyncMock(return_value={})), \
             patch("app.app_utils.ambient_send.get_site_performance", new=AsyncMock(return_value=_PERF)):
            with patch("app.app_utils.ambient_send._send_via_mcp",
                       new=AsyncMock(return_value=(True, None, 1))) as mock_send:
                out = await ambient_send.send_review_email([], "<strong>x</strong>", [], _run_context())
    assert out["ok"] is False
    assert out["code"] == "not_configured"
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_a_run_that_never_sends_still_delivers_the_numbers(monkeypatch):
    # Spec 84: the model once ran out of output tokens before calling the send
    # tool. The run must still deliver an email, and report itself as failed.
    from app import api

    async def no_send(**kwargs):
        if False:
            yield None

    sent = []

    async def numbers_only(note):
        sent.append(note)
        return {"ok": True}

    monkeypatch.setattr(api._runner, "run_async", no_send)
    monkeypatch.setattr(api, "send_numbers_only", numbers_only)
    monkeypatch.setattr(api, "warm_mcp_server", AsyncMock())
    out = await api._run_ambient_cycle()
    assert sent and "numbers-only" in sent[0]
    assert out["emails_sent"] == 1 and out["email_failure"] == "agent_did_not_send"


def test_numbers_only_email_keeps_every_number_and_drops_the_ai_parts():
    html, _ = ambient_send.build_email(_STATS, _COST, _TITLES, [], "", [], _PERF)
    assert "Gemini 3.8 Flash" not in html and "About this report" not in html
    assert "150 visitors (120 the same days last week)" in html   # TL;DR from the numbers
    assert "Cost watch" in html and "Where visitors are" in html
