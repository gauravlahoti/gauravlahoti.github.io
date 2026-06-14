# ruff: noqa
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

import os

from google.adk.agents import Agent
from google.adk.apps import App
from google.genai import types

from app import corpus_live
from app import tools as portfolio_tools
from app.fallback_model import FallbackGemini
from app.guardrails import after_model_callback, before_model_callback
from app.instruction import SYSTEM_INSTRUCTION

# Auth path is gated on whether GEMINI_API_KEY is set. In production on Cloud
# Run, the key is wired in from Secret Manager via `--secrets` and we use the
# AI Studio free tier. For local dev with `gcloud auth application-default
# login`, fall back to Vertex AI (test quota; same `gemini-flash-latest`).
if os.getenv("GEMINI_API_KEY"):
    os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "False"
else:
    import google.auth

    _, project_id = google.auth.default()
    os.environ["GOOGLE_CLOUD_PROJECT"] = project_id
    os.environ["GOOGLE_CLOUD_LOCATION"] = "global"
    os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "True"


# Corpus retrieval is served by LIVE tools, not frozen skills. Each retrieval
# tool reads `app/corpus_live.py`, which fetches the canonical JSON from
# gauravlahoti.dev/content/*.json with a short TTL (bundled snapshot as the
# offline fallback). So any edit to the site's content — profile, work history,
# projects, posts, certs, live agents — reflects in Atlas within the TTL with
# NO redeploy. The model calls each tool on demand (same token-efficient,
# progressive-disclosure shape the skills had, but always current). All tools
# are registered at the AGENT level so they land in the executable tools_dict
# (declaration-only registration raised "Tool not found" at execution).
# Warm the live-corpus cache at import so the first user request is fast.
corpus_live.prime()

_tools = [
    portfolio_tools.get_profile,
    portfolio_tools.get_work_history,
    portfolio_tools.get_projects,
    portfolio_tools.get_recent_posts,
    portfolio_tools.get_certifications,
    portfolio_tools.get_live_agents,
    portfolio_tools.get_site_stats,
    portfolio_tools.send_resume,
    portfolio_tools.send_note_to_gaurav,
]

root_agent = Agent(
    name="root_agent",
    # Free-tier model cascade: each model has its own daily free quota, so on a
    # 429 RESOURCE_EXHAUSTED we fall back to the next instead of failing the
    # visitor. Keeps the widget on the AI Studio free tier (no Vertex/paid).
    # See app/fallback_model.py.
    model=FallbackGemini(
        model="gemini-3.5-flash",
        fallback_models=["gemini-2.5-flash", "gemini-2.5-flash-lite"],
        retry_options=types.HttpRetryOptions(attempts=1),
    ),
    instruction=SYSTEM_INSTRUCTION,
    tools=_tools,
    before_model_callback=before_model_callback,
    after_model_callback=after_model_callback,
    generate_content_config=types.GenerateContentConfig(
        # Cap covers thinking + visible reply. Bumped to 4096 once we started
        # injecting the live corpus into system_instruction (every-turn
        # grounding) — thinking tokens jumped from ~300 to ~1700, and the
        # earlier 1800 cap was clipping replies to MAX_TOKENS mid-sentence.
        max_output_tokens=4096,
        temperature=0.2,
        # Disable Gemini's built-in safety filters — the portfolio agent has
        # its own input/output guardrails (see guardrails.py: prompt-injection
        # short-circuit, URL allowlist, email redaction). Default filters can
        # false-positive on enterprise security topics that legitimately come
        # up in Gaurav's work (zero-trust, DLP, IAM).
        safety_settings=[
            types.SafetySetting(
                category=types.HarmCategory.HARM_CATEGORY_HARASSMENT,
                threshold=types.HarmBlockThreshold.OFF,
            ),
            types.SafetySetting(
                category=types.HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                threshold=types.HarmBlockThreshold.OFF,
            ),
            types.SafetySetting(
                category=types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                threshold=types.HarmBlockThreshold.OFF,
            ),
            types.SafetySetting(
                category=types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                threshold=types.HarmBlockThreshold.OFF,
            ),
        ],
    ),
)

app = App(
    root_agent=root_agent,
    name="app",
)
