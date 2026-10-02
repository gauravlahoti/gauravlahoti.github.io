"""Pulse v2 charts (spec 84): PNGs embedded inline in the digest email.

Gmail strips inline SVG and CSS gradients, so the map, the donuts and the
line charts are rendered here and attached with a Content-ID. Bars, the
funnel and the heatmap stay HTML in ambient_send.py.

Every function returns PNG bytes, or None when there is nothing to draw or
anything fails, so a chart problem never stops the email: the section falls
back to its HTML version. Drawn at 2x (1120px wide, shown at 560px) on white,
in the email's palette and font.

Map data is bundled Natural Earth (public domain, see assets/geo/build_geo.py):
the world uses the India point-of-view boundaries, and the India inset draws
state lines clipped to that outline.
"""
from __future__ import annotations

import io
import json
import logging
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from matplotlib.patches import Polygon  # noqa: E402
import matplotlib.ticker  # noqa: E402,F401

logger = logging.getLogger(__name__)

ASSETS = Path(__file__).resolve().parent.parent / "assets"

INK = "#0b0f14"
MUTED = "#6b7280"
FAINT = "#9ca3af"
LINE = "#e5e7eb"
LAND = "#eef0f3"
BORDER = "#d6dae0"
CHAT = "#00b39a"      # visitors who talked to Atlas
VISIT = "#64748b"     # visitors who didn't
BAD = "#dc2626"
WIDTH_IN = 5.6        # 560 CSS px at 100 dpi, saved at 200 dpi
DPI = 200


@lru_cache(maxsize=1)
def _font() -> str:
    """Register the bundled Inter weights once; fall back to the default."""
    try:
        for ttf in sorted((ASSETS / "fonts").glob("Inter-*.ttf")):
            font_manager.fontManager.addfont(str(ttf))
        return "Inter"
    except Exception:  # noqa: BLE001
        return "DejaVu Sans"


def _style() -> None:
    plt.rcParams.update({
        # DejaVu Sans as fallback: the bundled Inter subset has no ₹ glyph.
        "font.family": [_font(), "DejaVu Sans"],
        "font.size": 8,
        "axes.edgecolor": LINE,
        "axes.labelcolor": MUTED,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "figure.facecolor": "white",
        "axes.facecolor": "white",
    })


def _png(fig) -> bytes:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=DPI, facecolor="white", bbox_inches="tight", pad_inches=0.08)
    plt.close(fig)
    return buf.getvalue()


def _safe(fn):
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception:  # noqa: BLE001 - a chart must never stop the email
            logger.exception("chart %s failed", fn.__name__)
            plt.close("all")
            return None
    wrapper.__name__ = fn.__name__
    return wrapper


# ── map ───────────────────────────────────────────────────────────────────────
@lru_cache(maxsize=1)
def _world() -> dict[str, Any]:
    return json.loads((ASSETS / "geo" / "world.geojson").read_text())


@lru_cache(maxsize=1)
def _india() -> dict[str, Any]:
    return json.loads((ASSETS / "geo" / "india_states.geojson").read_text())


@lru_cache(maxsize=1)
def centroids() -> dict[str, tuple[float, float]]:
    """ISO A2 -> (lon, lat) of a point inside the country."""
    return {f["properties"]["iso"]: (f["properties"]["cx"], f["properties"]["cy"])
            for f in _world()["features"] if f["properties"].get("iso")}


def _rings(geometry: dict[str, Any]):
    polys = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    for poly in polys:
        for ring in poly:
            if len(ring) >= 3:
                yield ring


def _draw(ax, features, face: str, edge: str, lw: float, outline_only: bool = False) -> None:
    for f in features:
        for i, ring in enumerate(_rings(f["geometry"])):
            ax.add_patch(Polygon(ring, closed=True, facecolor="none" if outline_only else face,
                                 edgecolor=edge, linewidth=lw, zorder=1))


_SHORT_NAMES = {"US": "United States", "GB": "United Kingdom", "AE": "UAE"}


@lru_cache(maxsize=1)
def country_names() -> dict[str, str]:
    names = {f["properties"]["iso"]: f["properties"]["name"]
             for f in _world()["features"] if f["properties"].get("iso")}
    return {**names, **_SHORT_NAMES}


def place(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Points to draw. Visits with coordinates plot where they are. Visits
    without (logged before coordinates were recorded) can't be put on a city,
    so they merge into one bubble per country at its centre, labelled with
    the country, never with a city it isn't at. Unplaceable ones drop."""
    cents, names = centroids(), country_names()
    exact, approx = [], {}
    for p in points or []:
        lat, lon = p.get("lat"), p.get("lon")
        if lat is not None and lon is not None:
            exact.append({**p, "lat": float(lat), "lon": float(lon), "approx": False})
            continue
        iso = str(p.get("country") or "").upper()
        if iso not in cents:
            continue
        a = approx.setdefault(iso, {"country": iso, "city": names.get(iso, iso), "visitors": 0,
                                    "chatted": 0, "lon": cents[iso][0], "lat": cents[iso][1], "approx": True})
        a["visitors"] += int(p.get("visitors") or 0)
        a["chatted"] += int(p.get("chatted") or 0)
    return exact + list(approx.values())


INDIA_BOX = (67.0, 98.0, 6.0, 37.0)   # lon min, lon max, lat min, lat max


def in_india_box(p: dict[str, Any]) -> bool:
    lo0, lo1, la0, la1 = INDIA_BOX
    return lo0 <= p["lon"] <= lo1 and la0 <= p["lat"] <= la1


def _bubbles(ax, pts, scale: float, labels: list[dict[str, Any]], fontsize: float, gap: float) -> None:
    top = max(p["visitors"] for p in pts) or 1
    for p in sorted(pts, key=lambda p: -p["visitors"]):
        size = scale * (0.25 + 0.75 * math.sqrt(p["visitors"] / top))
        colour = CHAT if p.get("chatted") else VISIT
        ax.scatter(p["lon"], p["lat"], s=size, color=colour, alpha=0.78,
                   edgecolors="white", linewidths=0.6, zorder=3)
    placed: list[dict[str, Any]] = []
    for p in labels:
        # Skip a label that would sit on a bigger, already-labelled city
        # (New Delhi and Gurugram are 25 km apart).
        if any(abs(p["lon"] - q["lon"]) < gap and abs(p["lat"] - q["lat"]) < gap * 0.6 for q in placed):
            continue
        placed.append(p)
        ax.annotate(p["city"], (p["lon"], p["lat"]), xytext=(5, 3), textcoords="offset points",
                    fontsize=fontsize, color=INK, zorder=4)


def _top_labels(pts, n):
    return [p for p in sorted(pts, key=lambda p: -p["visitors"]) if p.get("city")][:n]


@_safe
def visitor_map(points: list[dict[str, Any]]) -> bytes | None:
    """World map with a bubble per city; below it a zoomed India inset and
    the top cities with a colour key."""
    pts = [p for p in place(points) if p.get("visitors")]
    if not pts:
        return None
    _style()
    india_pts = [p for p in pts if in_india_box(p)]
    fig = plt.figure(figsize=(WIDTH_IN, 5.9))
    grid = fig.add_gridspec(2, 2, height_ratios=[2.9, 3.0], width_ratios=[1.05, 0.95],
                            hspace=0.04, wspace=0.02)

    ax = fig.add_subplot(grid[0, :])
    _draw(ax, _world()["features"], LAND, "white", 0.4)
    # In the world view, label cities outside India; the inset labels India's.
    _bubbles(ax, pts, 150, _top_labels([p for p in pts if not in_india_box(p)], 3), 7, 12)
    ax.set_xlim(-170, 180)
    ax.set_ylim(-58, 84)
    ax.set_aspect("equal")
    ax.axis("off")

    ax2 = fig.add_subplot(grid[1, 0])
    lo0, lo1, la0, la1 = INDIA_BOX
    states = _india()["features"]
    _draw(ax2, [f for f in states if f["properties"]["name"] != "__outline__"], LAND, BORDER, 0.35)
    _draw(ax2, [f for f in states if f["properties"]["name"] == "__outline__"], LAND, VISIT, 0.6,
          outline_only=True)
    if india_pts:
        _bubbles(ax2, india_pts, 230, _top_labels(india_pts, 5), 7, 2.2)
    ax2.set_xlim(lo0, lo1)
    ax2.set_ylim(la0, la1)
    ax2.set_aspect("equal")
    ax2.axis("off")
    ax2.set_title("India", loc="left", fontsize=8, color=MUTED, pad=0)

    # Right of India: the top cities and what the colours mean.
    key = fig.add_subplot(grid[1, 1])
    key.axis("off")
    key.set_xlim(0, 1)
    key.set_ylim(0, 1)
    key.text(0.04, 0.95, "Top cities this period", fontsize=8, color=MUTED, va="top")
    key.text(0.96, 0.95, "visitors", fontsize=7, color=FAINT, va="top", ha="right")
    # The list names real cities, including ones the map could only place by
    # country; the note below says so.
    named = _top_labels([{**p, "approx": False} for p in points or []
                         if p.get("visitors") and p.get("city")], 7)
    for i, p in enumerate(named):
        y = 0.85 - i * 0.085
        key.scatter(0.07, y, s=28, color=CHAT if p.get("chatted") else VISIT)
        key.text(0.13, y, p["city"], fontsize=8.5, color=INK, va="center")
        key.text(0.96, y, f"{p['visitors']:,}", fontsize=8.5, color=MUTED, va="center", ha="right")
    ky = 0.85 - len(named) * 0.085 - 0.04
    key.plot([0.04, 0.96], [ky + 0.03, ky + 0.03], color=LINE, linewidth=0.8)
    key.scatter(0.07, ky - 0.03, s=28, color=CHAT)
    key.text(0.13, ky - 0.03, "someone chatted with Atlas", fontsize=7.5, color=MUTED, va="center")
    key.scatter(0.07, ky - 0.11, s=28, color=VISIT)
    key.text(0.13, ky - 0.11, "browsed only", fontsize=7.5, color=MUTED, va="center")
    key.text(0.04, ky - 0.2, "Bubble size: visitors", fontsize=7.5, color=FAINT, va="center")
    if any(p.get("approx") for p in pts):
        key.text(0.04, ky - 0.3, "Earlier visits have no exact location\n(recorded from 2 Oct midday), so the map\n"
                 "groups them at their country's centre.", fontsize=7, color=FAINT, va="top", linespacing=1.4)
    return _png(fig)


# ── donut ─────────────────────────────────────────────────────────────────────
@_safe
def donut(parts: list[tuple[str, float, str]], centre: str, caption: str,
          value_fmt=None) -> bytes | None:
    """parts: (label, value, colour). Legend on the right with each part's
    share, and its value too when `value_fmt` is given (e.g. rupees)."""
    parts = [(l, float(v), c) for l, v, c in parts if v and float(v) > 0]
    total = sum(v for _, v, _ in parts)
    if not total:
        return None
    _style()
    fig, ax = plt.subplots(figsize=(WIDTH_IN, 2.1))
    ax.set_position([0.0, 0.02, 0.42, 0.96])
    ax.pie([v for _, v, _ in parts], colors=[c for *_, c in parts], startangle=90, counterclock=False,
           wedgeprops={"width": 0.32, "edgecolor": "white", "linewidth": 2})
    ax.text(0, 0.08, centre, ha="center", va="center", fontsize=15, fontweight="bold", color=INK)
    ax.text(0, -0.2, caption, ha="center", va="center", fontsize=7, color=MUTED)
    ax.set_aspect("equal")
    leg = fig.add_axes([0.46, 0.05, 0.54, 0.9])
    leg.axis("off")
    n = len(parts)
    step = min(0.2, 0.9 / max(n, 1))   # six rows still fit beside the ring
    for i, (label, value, colour) in enumerate(parts):
        y = 0.5 + (n - 1) / 2 * step - i * step
        leg.scatter(0.02, y, s=60, color=colour)
        leg.text(0.08, y, label, va="center", fontsize=9, color=INK)
        share = f"{value / total:.0%}"
        leg.text(0.98, y, f"{value_fmt(value)} · {share}" if value_fmt else share,
                 va="center", ha="right", fontsize=9, color=MUTED)
    leg.set_xlim(0, 1)
    leg.set_ylim(0, 1)
    return _png(fig)


# ── 14-day trend ──────────────────────────────────────────────────────────────
@_safe
def trend(daily: list[dict[str, Any]]) -> bytes | None:
    """Visitors per day as columns, Atlas chats as a line."""
    if not daily or not any(d.get("visitors") or d.get("chats") for d in daily):
        return None
    _style()
    days = [d["day"] for d in daily]
    visitors = [int(d.get("visitors") or 0) for d in daily]
    chats = [int(d.get("chats") or 0) for d in daily]
    fig, ax = plt.subplots(figsize=(WIDTH_IN, 1.7))
    x = range(len(days))
    ax.bar(x, visitors, color="#d9dee5", width=0.7, label="Visitors", zorder=2)
    ax.plot(x, chats, color=CHAT, linewidth=1.8, marker="o", markersize=3, label="Chats with Atlas", zorder=3)
    ax.set_xticks(list(x)[::2], [f"{int(d[8:])} {_MONTHS[int(d[5:7]) - 1]}" for d in days][::2])
    ax.tick_params(length=0, labelsize=7)
    ax.yaxis.grid(True, color=LINE, linewidth=0.6)
    ax.set_axisbelow(True)
    ax.spines["left"].set_visible(False)
    ax.legend(loc="upper left", frameon=False, fontsize=7, ncol=2, bbox_to_anchor=(0, 1.18))
    return _png(fig)


_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ── spend pace ────────────────────────────────────────────────────────────────
@_safe
def spend_pace(daily: list[float], budget: float, forecast: float, days_in_month: int,
               symbol: str = "₹") -> bytes | None:
    """Cumulative spend so far, the budget's straight-line pace, and a dashed
    forecast to month end."""
    if not daily:
        return None
    _style()
    cum, run = [], 0.0
    for v in daily:
        run += float(v or 0)
        cum.append(run)
    n = len(cum)
    over = forecast > budget
    fig, ax = plt.subplots(figsize=(WIDTH_IN, 1.8))
    ax.plot([0, days_in_month], [0, budget], color=FAINT, linewidth=1, linestyle=(0, (2, 2)), label="Budget pace")
    ax.plot(range(1, n + 1), cum, color=INK, linewidth=2, label="Spent")
    ax.plot([n, days_in_month], [cum[-1], forecast], color=BAD if over else CHAT, linewidth=1.6,
            linestyle=(0, (4, 3)), label="Forecast")
    ax.axhline(budget, color=LINE, linewidth=0.8)
    ax.text(1, budget, f" budget {symbol}{budget:,.0f}", va="bottom", fontsize=7, color=MUTED)
    ax.set_xlim(0, days_in_month)
    ax.set_ylim(0, max(budget, forecast, cum[-1]) * 1.15)
    ax.set_xticks([1, 8, 15, 22, days_in_month])
    ax.tick_params(length=0, labelsize=7)
    ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"{symbol}{v:,.0f}"))
    ax.spines["left"].set_visible(False)
    ax.yaxis.grid(True, color=LINE, linewidth=0.6)
    ax.set_axisbelow(True)
    ax.legend(loc="upper left", frameon=False, fontsize=7, ncol=3, bbox_to_anchor=(0, 1.2))
    return _png(fig)
