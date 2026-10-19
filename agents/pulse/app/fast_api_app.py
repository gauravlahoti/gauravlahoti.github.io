# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import logging
import os

import google.auth
from fastapi import FastAPI
from google.adk.cli.fast_api import get_fast_api_app
from google.cloud import logging as google_cloud_logging

from app.api import register_routes
from app.app_utils.telemetry import setup_telemetry
from app.app_utils.typing import Feedback
from app.route_allowlist import RouteAllowlist, dev_routes_enabled

setup_telemetry()
_, project_id = google.auth.default()
logging_client = google_cloud_logging.Client()
# Same fix as atlas/app/fast_api_app.py: without this, constructing the
# client alone never attaches a handler to Python's root logger, so every
# app_utils module's logger.info() was silently discarded.
logging_client.setup_logging(log_level=logging.INFO)
logger = logging_client.logger(__name__)
allow_origins = (
    os.getenv("ALLOW_ORIGINS", "").split(",") if os.getenv("ALLOW_ORIGINS") else None
)

# Artifact bucket for ADK (created by Terraform, passed via env var)
logs_bucket_name = os.environ.get("LOGS_BUCKET_NAME")

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# In-memory session configuration - no persistent storage
session_service_uri = None

artifact_service_uri = f"gs://{logs_bucket_name}" if logs_bucket_name else None

# ADK's developer surface (dev UI, /run_sse, session CRUD, /builder/save, ...)
# is opt-in for local dev only. Unset means closed. See app/route_allowlist.py.
_DEV_ROUTES = dev_routes_enabled()

app: FastAPI = get_fast_api_app(
    agents_dir=AGENT_DIR,
    web=_DEV_ROUTES,
    artifact_service_uri=artifact_service_uri,
    allow_origins=allow_origins,
    session_service_uri=session_service_uri,
    otel_to_cloud=True,
)
app.title = "pulse"
app.description = "Pulse — ambient weekly-digest agent"

# Pulse's own routes (POST /api/ambient/run, POST /api/ambient/metrics,
# GET /healthz), called by Cloud Scheduler. ADK's native routes (/run_sse etc.)
# are still registered, but the allowlist at the bottom of this file 404s them
# in prod.
register_routes(app)


@app.post("/feedback")
def collect_feedback(feedback: Feedback) -> dict[str, str]:
    """Collect and log feedback.

    Args:
        feedback: The feedback data to log

    Returns:
        Success message
    """
    logger.log_struct(feedback.model_dump(), severity="INFO")
    return {"status": "success"}


# Outermost middleware, so it runs before routing. Every route above that
# isn't in ALLOWED_ROUTES (including /feedback) 404s in prod.
if not _DEV_ROUTES:
    app.add_middleware(RouteAllowlist)


# Main execution
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
