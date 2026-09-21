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

from google.adk.apps import App

# Pulse runs on Vertex AI against `adk-deploy-trail`, the same project Atlas
# uses, via ADC — in production the Cloud Run service account, locally
# `gcloud auth application-default login`. It used to prefer an AI Studio key
# when one was present, but that tier throttles on a shared spend cap and took
# the digest down with it. The project is pinned rather than read from ADC so a
# stray local gcloud config can't silently point Pulse somewhere else. This
# block runs at import (app/__init__.py imports this module) so the env is set
# before the agent's first model call.
PULSE_VERTEX_PROJECT = "adk-deploy-trail"
PULSE_VERTEX_LOCATION = "global"

os.environ["GOOGLE_CLOUD_PROJECT"] = PULSE_VERTEX_PROJECT
os.environ["GOOGLE_CLOUD_LOCATION"] = PULSE_VERTEX_LOCATION
os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "True"

from app.ambient_agent import ambient_agent

# Pulse's root agent is the ambient digest agent. The App name stays "app"
# (it matches agent_directory); the Cloud Run service is named "pulse" at deploy.
root_agent = ambient_agent

app = App(
    root_agent=root_agent,
    name="app",
)
