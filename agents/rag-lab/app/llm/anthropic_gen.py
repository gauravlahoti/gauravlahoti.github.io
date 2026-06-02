from __future__ import annotations

import json
import math
import os
import time
from typing import Any, AsyncGenerator

from app.llm.tools import HYBRID_SEARCH_TOOL

DEFAULT_MODEL = "claude-sonnet-4-5"
MAX_TOKENS = 2048
SYSTEM_PROMPT = (
    "You are a helpful assistant that answers questions grounded strictly in the provided context. "
    "The context passages are numbered like [1], [2], [3]. "
    "When you use information from a passage, add an inline citation with its number, e.g. "
    "'The system uses cosine similarity [1].' Place the marker right after the claim it supports, "
    "and you may cite more than one (e.g. [1][3]). Only cite numbers that appear in the context. "
    "If the context does not contain enough information, say so clearly."
)


async def generate(
    query: str,
    context: str,
    mode: str,
    retrieval_fn,  # async callable(query, top_k) → (fused_results, events[])
    model: str = DEFAULT_MODEL,
    iteration_offset: int = 0,
    api_key: str | None = None,
) -> AsyncGenerator[dict[str, Any], None]:
    import anthropic

    api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "No Anthropic API key found. Provide a key in the UI or set ANTHROPIC_API_KEY in the server environment."
        )

    client = anthropic.Anthropic(api_key=api_key)
    t0 = time.time()

    if mode == "linear":
        async for ev in _linear(client, query, context, model, t0):
            yield ev
    else:
        async for ev in _agentic(client, query, retrieval_fn, model, iteration_offset, t0):
            yield ev


async def _linear(
    client,
    query: str,
    context: str,
    model: str,
    t0: float,
) -> AsyncGenerator[dict[str, Any], None]:
    import anthropic

    messages = [
        {
            "role": "user",
            "content": f"Context:\n{context}\n\nQuestion: {query}",
        }
    ]

    input_tokens = 0
    output_tokens = 0

    with client.messages.stream(
        model=model,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        messages=messages,
    ) as stream:
        for event in stream:
            if hasattr(event, "type"):
                if event.type == "content_block_delta":
                    delta = getattr(event.delta, "text", "")
                    if delta:
                        yield {"type": "llm_token", "delta": delta}
                elif event.type == "message_delta":
                    usage = getattr(event, "usage", None)
                    if usage:
                        output_tokens = getattr(usage, "output_tokens", 0)
                elif event.type == "message_start":
                    msg = getattr(event, "message", None)
                    if msg and hasattr(msg, "usage"):
                        input_tokens = getattr(msg.usage, "input_tokens", 0)

    yield {
        "type": "done",
        "usage": {"input": input_tokens, "output": output_tokens},
        "iterations": 1,
        "latencyMs": math.ceil((time.time() - t0) * 1000),
    }


async def _agentic(
    client,
    query: str,
    retrieval_fn,
    model: str,
    iteration_offset: int,
    t0: float,
) -> AsyncGenerator[dict[str, Any], None]:
    import anthropic

    messages = [{"role": "user", "content": query}]
    total_input = 0
    total_output = 0
    iteration = iteration_offset
    fused_results: list[dict] = []

    while True:
        iteration += 1
        thinking_buf = ""

        with client.messages.stream(
            model=model,
            max_tokens=MAX_TOKENS,
            system=SYSTEM_PROMPT,
            tools=[HYBRID_SEARCH_TOOL],
            messages=messages,
        ) as stream:
            full_response = None
            content_blocks: list[dict] = []
            current_block: dict | None = None

            for event in stream:
                if not hasattr(event, "type"):
                    continue

                if event.type == "message_start":
                    msg = getattr(event, "message", None)
                    if msg and hasattr(msg, "usage"):
                        total_input += getattr(msg.usage, "input_tokens", 0)

                elif event.type == "content_block_start":
                    block = getattr(event, "content_block", None)
                    if block:
                        btype = getattr(block, "type", "")
                        if btype == "text":
                            current_block = {"type": "text", "text": ""}
                        elif btype == "tool_use":
                            current_block = {
                                "type": "tool_use",
                                "id": getattr(block, "id", ""),
                                "name": getattr(block, "name", ""),
                                "input_json": "",
                            }

                elif event.type == "content_block_delta":
                    delta = getattr(event, "delta", None)
                    if delta and current_block:
                        dtype = getattr(delta, "type", "")
                        if dtype == "text_delta":
                            text = getattr(delta, "text", "")
                            current_block["text"] = current_block.get("text", "") + text
                            thinking_buf += text
                            yield {"type": "agent_thinking", "iteration": iteration, "delta": text}
                        elif dtype == "input_json_delta":
                            current_block["input_json"] = current_block.get("input_json", "") + getattr(delta, "partial_json", "")

                elif event.type == "content_block_stop":
                    if current_block:
                        if current_block["type"] == "tool_use":
                            try:
                                current_block["input"] = json.loads(current_block.pop("input_json", "{}"))
                            except json.JSONDecodeError:
                                current_block["input"] = {}
                        content_blocks.append(current_block)
                        current_block = None

                elif event.type == "message_delta":
                    usage = getattr(event, "usage", None)
                    if usage:
                        total_output += getattr(usage, "output_tokens", 0)
                    stop_reason = getattr(event.delta, "stop_reason", None)
                    if stop_reason:
                        full_response = {"stop_reason": stop_reason, "content": content_blocks}

        if full_response is None:
            break

        stop_reason = full_response.get("stop_reason")
        messages.append({"role": "assistant", "content": content_blocks})

        if stop_reason == "tool_use":
            tool_results = []
            for block in content_blocks:
                if block.get("type") != "tool_use":
                    continue
                tool_name = block.get("name")
                tool_input = block.get("input", {})
                tool_id = block.get("id")

                yield {
                    "type": "tool_call",
                    "iteration": iteration,
                    "name": tool_name,
                    "args": tool_input,
                }

                tool_query = tool_input.get("query", query)
                tool_top_k = tool_input.get("top_k", 5)

                # Run retrieval, streaming SSE events
                gen = retrieval_fn(tool_query, tool_top_k, iteration)
                async for ev in gen:
                    if ev.get("type") == "fused_results":
                        fused_results = ev.get("results", [])
                    yield ev

                # Build tool result content — numbered [n] so the model can cite inline
                result_text = json.dumps(
                    [
                        {"cite": n, "text": r["text"][:500]}
                        for n, r in enumerate(fused_results, start=1)
                    ]
                )
                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_id,
                        "content": result_text,
                    }
                )

                yield {
                    "type": "tool_result",
                    "iteration": iteration,
                    "count": len(fused_results),
                    "topChunkIndices": [r["chunkIndex"] for r in fused_results],
                }

            messages.append({"role": "user", "content": tool_results})

        else:
            # End of agentic loop — emit final answer tokens
            for block in content_blocks:
                if block.get("type") == "text":
                    text = block.get("text", "")
                    for char in text:
                        yield {"type": "llm_token", "delta": char}
            break

    yield {
        "type": "done",
        "usage": {"input": total_input, "output": total_output},
        "iterations": iteration,
        "latencyMs": math.ceil((time.time() - t0) * 1000),
    }
