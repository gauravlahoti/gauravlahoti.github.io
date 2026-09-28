"""Spec 67: a certification is not project work. get_certifications marks
certs whose vendor appears nowhere in what Gaurav built, so the model can't
invent hands-on work from a credential (it said "integrated Azure OpenAI in
production" with only an Azure fundamentals cert on record)."""

from __future__ import annotations

import asyncio

from app import corpus_live, tools

PROFILE = {
    "experience": [{"company": "Deloitte", "summary": "Built integration fabrics on GCP with Apigee and Cloud Run."}],
    "certifications": [
        {"name": "Azure AI Fundamentals", "issuer": "Microsoft", "slug": "azure-ai-fundamentals"},
        {"name": "Associate Cloud Engineer", "issuer": "Google Cloud", "slug": "gcp-ace"},
    ],
}


def test_cert_without_matching_work_is_flagged(monkeypatch) -> None:
    async def profile():
        return PROFILE

    async def empty():
        return []

    monkeypatch.setattr(corpus_live, "get_profile", profile)
    monkeypatch.setattr(corpus_live, "get_graph", empty)
    monkeypatch.setattr(corpus_live, "get_agents", empty)
    certs = {c["slug"]: c for c in asyncio.run(tools.get_certifications())}
    # The cert's own name ("Azure ...") must not count as evidence.
    assert certs["azure-ai-fundamentals"]["handsOnWorkOnRecord"] is False
    assert "never claim" in certs["azure-ai-fundamentals"]["note"]
    assert certs["gcp-ace"]["handsOnWorkOnRecord"] is True
    assert "note" not in certs["gcp-ace"]
