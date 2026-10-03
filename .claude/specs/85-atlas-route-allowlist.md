# Spec 85: Atlas route allowlist

## Problem

`agents/atlas/app/fast_api_app.py` builds the app with ADK's
`get_fast_api_app(web=True)`, and `make deploy` passes `--allow-unauthenticated`.
That publishes ADK's whole developer surface next to the site's own routes.
Checked on 2026-10-02 with read-only GETs against the live service:
`/list-apps`, `/dev-ui/`, `/docs` and `/openapi.json` all return 200.

The ones that matter:

- `POST /run` and `POST /run_sse` run the agent with **no rate limit and no
  audit row**. Every guard in `api.py` (the daily chat bucket, IP hashing, the
  D1 audit log) sits on the site's own routes only, so anyone with curl gets
  unlimited Vertex spend.
- `POST /builder/save` writes agent files on the instance.
- Session CRUD, `/debug/trace/*`, eval runs, `/feedback`, and the `/run_live`
  websocket.

The service URL is not a secret. It's in `index.html`'s CSP, every visitor's
browser calls it, and `/openapi.json` lists every route. CORS doesn't help
either, because curl ignores it.

`web=False` alone isn't enough. It drops the static dev UI, but `/run_sse` and
the session APIs stay registered.

This was first written up as part of a broader zero-trust spec (68) that was
never merged. This spec carries only the allowlist, updated for the routes
added since (websocket chat, stream probes, live avatar).

## Fix

`app/route_allowlist.py`: plain ASGI middleware, added outermost, that

- passes the `(method, path)` pairs the site actually calls (`ALLOWED_ROUTES`:
  the `/api/*` routes, their `OPTIONS` preflight, and `GET /healthz`),
- passes the site's own websockets (`ALLOWED_WEBSOCKETS`: `/api/agent-chat-ws`,
  `/api/agent-live`, `/api/stream-probe-ws`),
- answers 404 to every other HTTP request and refuses every other websocket
  handshake.

It's plain ASGI, not `BaseHTTPMiddleware`, because the latter wraps the
response stream and `/api/agent-chat` is SSE.

`ATLAS_DEV_ROUTES=1` opens the full ADK surface (and `web=True`) for local dev.
Unset means closed, so a deploy that forgets it is safe. The two eval recipes
and the integration suite set it, because they drive ADK's own routes. `make
deploy` passes `--remove-env-vars ATLAS_DEV_ROUTES` so a hand-set value on the
service can't survive a deploy.

## Out of scope

- A dedicated least-privilege runtime service account for Atlas (it still runs
  as the default compute SA). Worth doing, as its own spec.
- Model Armor, Agent Gateway, the architecture diagram.

## Definition of done

- [ ] `uv run pytest tests/unit/test_route_allowlist.py` passes, including the
      check that every route and websocket `register_routes` adds is
      allowlisted.
- [ ] Locally, with the flag unset: `/run_sse`, `/docs`, `/openapi.json`,
      `/list-apps`, `/dev-ui/`, `/feedback` return 404; `/healthz` and
      `/api/agent-chat/warm` return 200; `/api/agent-chat-ws` accepts a
      websocket and `/run_live` refuses one.
- [ ] After `make deploy`, the same checks pass against the live service, and
      text chat, voice and the avatar still work on gauravlahoti.dev.
