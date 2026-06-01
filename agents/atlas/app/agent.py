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
from pathlib import Path

from google.adk.agents import Agent
from google.adk.apps import App
from google.adk.models import Gemini
from google.adk.skills import load_skill_from_dir
from google.adk.tools.skill_toolset import SkillToolset
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


# Corpus retrieval is served through ADK Skills (Spec 37): the bundled
# `app/skills/<name>/SKILL.md` files are loaded at import. `SkillToolset`
# auto-injects a lightweight skill menu (list_skills) into context and exposes
# `load_skill` so the model pulls one domain's curated data on demand — instead
# of the old per-turn full-corpus dump. Action tools (send_resume,
# send_note_to_gaurav) ride along as additional_tools. Skills are static,
# rebuilt at deploy via `make corpus` (scripts/build_skills.py).
_SKILLS_DIR = Path(__file__).parent / "skills"
_skills = [
    load_skill_from_dir(p)
    for p in sorted(_SKILLS_DIR.iterdir())
    if p.is_dir()
]
skill_toolset = SkillToolset(
    skills=_skills,
    additional_tools=[
        portfolio_tools.send_resume,
        portfolio_tools.send_note_to_gaurav,
    ],
)

root_agent = Agent(
    name="root_agent",
    model=Gemini(
        model="gemini-3.5-flash",
        retry_options=types.HttpRetryOptions(attempts=3),
    ),
    instruction=SYSTEM_INSTRUCTION,
    tools=[skill_toolset],
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
