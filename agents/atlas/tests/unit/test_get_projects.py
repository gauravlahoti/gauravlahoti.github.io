"""`get_projects(domain=)` must match the domain ids its docstring offers.

The docstring tells the model to pass ids like "cloud-architecture", but the
filter used to compare against labels like "Cloud-Native Architecture", so
an id never matched, the tool returned [] and the model told visitors Gaurav
had no cloud projects.
"""

from __future__ import annotations

import pytest

from app import corpus_live, tools

GRAPH = {
    "nodes": [
        {"id": "cloud-architecture", "type": "domain", "label": "Cloud-Native Architecture"},
        {"id": "agentic-ai", "type": "domain", "label": "Agentic AI"},
        {"id": "deloitte", "type": "company", "label": "Deloitte"},
        {"id": "gcp", "type": "skill", "label": "Google Cloud"},
        {"id": "fabric", "type": "project", "label": "Fiber Broadband Fabric"},
        {"id": "l2c", "type": "project", "label": "Lead-to-Cash"},
    ],
    "edges": [
        {"source": "fabric", "target": "cloud-architecture"},
        {"source": "fabric", "target": "deloitte"},
        {"source": "fabric", "target": "gcp"},
        {"source": "l2c", "target": "agentic-ai"},
    ],
}


@pytest.fixture(autouse=True)
def fixed_graph(monkeypatch):
    async def get_graph():
        return GRAPH

    monkeypatch.setattr(corpus_live, "get_graph", get_graph)


def _labels(projects):
    return [p["label"] for p in projects]


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", ["cloud-architecture", "Cloud Architecture", "cloud-native architecture", "CLOUD"])
async def test_domain_id_or_label_matches(domain):
    assert _labels(await tools.get_projects(domain=domain)) == ["Fiber Broadband Fabric"]


@pytest.mark.asyncio
async def test_skill_and_project_name_still_match():
    assert _labels(await tools.get_projects(domain="google cloud")) == ["Fiber Broadband Fabric"]
    assert _labels(await tools.get_projects(domain="lead to cash")) == ["Lead-to-Cash"]


@pytest.mark.asyncio
async def test_no_match_returns_everything_instead_of_nothing():
    assert _labels(await tools.get_projects(domain="quantum")) == ["Fiber Broadband Fabric", "Lead-to-Cash"]


@pytest.mark.asyncio
async def test_no_filter_returns_everything_with_company_resolved():
    projects = await tools.get_projects()
    assert _labels(projects) == ["Fiber Broadband Fabric", "Lead-to-Cash"]
    assert projects[0]["company"] == "Deloitte"
    assert projects[0]["domains"] == ["Cloud-Native Architecture"]
