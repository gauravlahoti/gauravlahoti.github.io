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
from google.adk.models import Gemini
from google.genai import types

from app import tools as portfolio_tools
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


root_agent = Agent(
    name="root_agent",
    model=Gemini(
        model="gemini-2.5-flash",
        retry_options=types.HttpRetryOptions(attempts=3),
    ),
    instruction=SYSTEM_INSTRUCTION,
    tools=[
        portfolio_tools.get_profile,
        portfolio_tools.get_work_history,
        portfolio_tools.get_projects,
        portfolio_tools.get_recent_posts,
        portfolio_tools.get_certifications,
    ],
    before_model_callback=before_model_callback,
    after_model_callback=after_model_callback,
    generate_content_config=types.GenerateContentConfig(
        # ~2000 words. Most answers are 200–400 words; this is the hard cap.
        max_output_tokens=1500,
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
