"""Spec 84: the inline PNG charts. Each returns PNG bytes for real data and
None for nothing to draw, so a section can fall back to HTML."""
from __future__ import annotations

from app.app_utils import charts

PNG = b"\x89PNG\r\n\x1a\n"
POINTS = [
    {"lat": 37.4, "lon": -122.1, "city": "San Jose", "country": "US", "visitors": 14, "chatted": 3},
    {"lat": 28.6, "lon": 77.2, "city": "New Delhi", "country": "IN", "visitors": 11, "chatted": 2},
    {"lat": 12.9, "lon": 77.6, "city": "Bengaluru", "country": "IN", "visitors": 18, "chatted": 0},
    {"lat": 19.1, "lon": 72.9, "city": "Mumbai", "country": "IN", "visitors": 8, "chatted": 0},
    {"lat": None, "lon": None, "city": None, "country": "DE", "visitors": 2, "chatted": 0},
]


def test_map_is_a_png_and_empty_is_none():
    assert charts.visitor_map(POINTS)[:8] == PNG
    assert charts.visitor_map([]) is None
    assert charts.visitor_map([{"lat": None, "lon": None, "country": "ZZ", "visitors": 3}]) is None


def test_points_without_coordinates_use_the_country_centroid():
    placed = charts.place(POINTS)
    germany = next(p for p in placed if p["country"] == "DE")
    assert 5 < germany["lon"] < 16 and 47 < germany["lat"] < 56


def test_indian_cities_fall_inside_the_india_inset():
    placed = charts.place(POINTS)
    inside = {p["city"] for p in placed if charts.in_india_box(p)}
    assert {"New Delhi", "Bengaluru", "Mumbai"} <= inside and "San Jose" not in inside


def test_donut_trend_and_pace_render_and_skip_empty():
    assert charts.donut([("Text", 3, "#6366f1"), ("Avatar", 5, "#00b39a")], "8", "chats")[:8] == PNG
    assert charts.donut([("Text", 0, "#6366f1")], "0", "chats") is None
    daily = [{"day": f"2026-09-{d:02d}", "visitors": d, "chats": d // 3} for d in range(17, 31)]
    assert charts.trend(daily)[:8] == PNG
    assert charts.trend([{"day": "2026-09-30", "visitors": 0, "chats": 0}]) is None
    assert charts.spend_pace([30.0] * 10, 1200.0, 930.0, 30)[:8] == PNG
    assert charts.spend_pace([], 1200.0, 0.0, 30) is None


def test_a_chart_error_returns_none_instead_of_raising():
    assert charts.donut("not a list", "x", "y") is None


def test_visits_without_coordinates_group_by_country_not_city():
    # Spec 84 follow-up: four US cities with no coordinates used to stack on
    # the US centre labelled "Boardman". They are one country bubble now.
    pts = [
        {"lat": None, "lon": None, "city": "Boardman", "country": "US", "visitors": 3, "chatted": 0},
        {"lat": None, "lon": None, "city": "Council Bluffs", "country": "US", "visitors": 1, "chatted": 0},
        {"lat": None, "lon": None, "city": "Clifton", "country": "US", "visitors": 1, "chatted": 1},
        {"lat": 28.5, "lon": 77.0, "city": "Gurugram", "country": "IN", "visitors": 4, "chatted": 2},
    ]
    placed = charts.place(pts)
    us = [p for p in placed if p["country"] == "US"]
    assert len(us) == 1 and us[0]["approx"] and us[0]["city"] == "United States"
    assert us[0]["visitors"] == 5 and us[0]["chatted"] == 1
    gurugram = next(p for p in placed if p.get("city") == "Gurugram")
    assert not gurugram["approx"] and gurugram["lat"] == 28.5
    assert charts.visitor_map(pts)[:8] == PNG
