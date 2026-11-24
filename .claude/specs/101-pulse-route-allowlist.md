# Spec 86: Pulse route allowlist

## Problem

Pulse has the same open door spec 85 closed on Atlas. `agents/pulse/app/fast_api_app.py`
builds the app with `get_fast_api_app(web=True)`, and `make deploy` passes
`--allow-unauthenticated` so Cloud Scheduler can reach it. Checked on
2026-10-03 with read-only GETs: `/docs`, `/openapi.json` and `/dev-ui/` return
200, and the OpenAPI document lists 45 paths, including ADK's session CRUD,
eval runs and `/run_sse`.

Pulse's own routes check `x-internal-token`. ADK's check nothing. So anyone
with the URL could run Pulse's agent directly, and that agent can read visitor
analytics and send email.

## Fix

`agents/pulse/app/route_allowlist.py`, the same fail-closed ASGI middleware as
Atlas's, added outermost. It passes only:

- `POST /api/ambient/run` (the `portfolio-ambient-agent` job)
- `POST /api/ambient/metrics` (the `portfolio-ambient-metrics` job)
- `GET /healthz`

Every other request gets a 404. Nothing calls Pulse over a websocket, so every
websocket handshake is refused. No browser calls Pulse, so there's no CORS
preflight entry.

`PULSE_DEV_ROUTES=1` opens the full ADK surface (and `web=True`) for local
dev. Unset means closed. `make deploy` passes `--remove-env-vars
PULSE_DEV_ROUTES`.

The `/refresh-post-metrics` and `/run-ambient-digest` skills trigger the
scheduler jobs, so they keep working unchanged.

## Definition of done

- [ ] `uv run pytest tests/unit` passes in `agents/pulse`, including the check
      that every route `register_routes` adds is allowlisted.
- [ ] Locally, with the flag unset: `/run_sse`, `/docs`, `/openapi.json`,
      `/list-apps`, `/dev-ui/`, `/feedback`, session CRUD return 404;
      `/healthz` returns 200; `/api/ambient/*` reach their handler.
- [ ] After `make deploy`, the same checks pass live, and `gcloud scheduler
      jobs run portfolio-ambient-metrics` still lands a 200 in Pulse's logs.
