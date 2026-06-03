from __future__ import annotations

import json
import math
import time
from typing import Any, AsyncGenerator

DEFAULT_MODEL = "gemini-2.5-flash"
MAX_TOKENS = 2048
SYSTEM_PROMPT = (
    "You are a retrieval-grounded assistant. Answer ONLY using the numbered context passages below. "
    "Cite specific parts of the context with inline numbers like [1], [2] right after each claim. "
    "IMPORTANT: Do NOT use your training knowledge. If the answer cannot be found in the provided "
    "context passages, respond with exactly: "
    "'The ingested document does not contain enough information to answer this question.' "
    "Never supplement with outside knowledge, even for definitions or background facts."
)


async def generate(
    query: str,
    context: str,
    mode: str,
    retrieval_fn,
    model: str = DEFAULT_MODEL,
    iteration_offset: int = 0,
    api_key: str | None = None,
) -> AsyncGenerator[dict[str, Any], None]:
    from google import genai
    from google.genai import types

    if not api_key:
        raise RuntimeError(
            "No API key provided. Enter your Google key or the owner passphrase in the UI."
        )

    client = genai.Client(api_key=api_key)
    t0 = time.time()

    if mode == "linear":
        async for ev in _linear(client, types, query, context, model, t0):
            yield ev
    else:
        async for ev in _agentic(client, types, query, retrieval_fn, model, iteration_offset, t0):
            yield ev


async def _linear(client, types, query, context, model, t0):
    prompt = f"Context:\n{context}\n\nQuestion: {query}"
    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        max_output_tokens=MAX_TOKENS,
    )
    for chunk in client.models.generate_content_stream(
        model=model,
        contents=prompt,
        config=config,
    ):
        text = chunk.text or ""
        if text:
            yield {"type": "llm_token", "delta": text}

    yield {
        "type": "done",
        "usage": {"input": 0, "output": 0},
        "iterations": 1,
        "latencyMs": math.ceil((time.time() - t0) * 1000),
    }


async def _agentic(client, types, query, retrieval_fn, model, iteration_offset, t0):
    hybrid_tool = types.Tool(function_declarations=[
        types.FunctionDeclaration(
            name="hybrid_search",
            description="Search the corpus with hybrid retrieval.",
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "query": types.Schema(type=types.Type.STRING),
                    "top_k": types.Schema(type=types.Type.INTEGER),
                },
                required=["query"],
            ),
        )
    ])

    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        max_output_tokens=MAX_TOKENS,
        tools=[hybrid_tool],
    )

    messages = [types.Content(role="user", parts=[types.Part.from_text(text=query)])]
    iteration = iteration_offset
    fused_results: list[dict] = []

    while True:
        iteration += 1
        response = client.models.generate_content(
            model=model,
            contents=messages,
            config=config,
        )

        candidate = response.candidates[0]
        messages.append(types.Content(role="model", parts=candidate.content.parts))

        # Collect function calls and text parts
        func_calls = [p for p in candidate.content.parts if p.function_call]
        text_parts = [p.text for p in candidate.content.parts if p.text]

        if func_calls:
            fc = func_calls[0].function_call
            args = dict(fc.args)
            tool_query = args.get("query", query)
            tool_top_k = int(args.get("top_k", 5))

            yield {"type": "tool_call", "iteration": iteration, "name": "hybrid_search", "args": args}

            async for ev in retrieval_fn(tool_query, tool_top_k, iteration):
                if ev.get("type") == "fused_results":
                    fused_results = ev.get("results", [])
                yield ev

            result_text = json.dumps(
                [{"rank": r["rank"], "text": r["text"][:500]} for r in fused_results]
            )
            yield {
                "type": "tool_result",
                "iteration": iteration,
                "count": len(fused_results),
                "topChunkIndices": [r["chunkIndex"] for r in fused_results],
            }

            messages.append(types.Content(
                role="user",
                parts=[types.Part.from_function_response(
                    name="hybrid_search",
                    response={"result": result_text},
                )],
            ))

        else:
            full = "".join(text_parts)
            for char in full:
                yield {"type": "llm_token", "delta": char}
            break

    yield {
        "type": "done",
        "usage": {"input": 0, "output": 0},
        "iterations": iteration,
        "latencyMs": math.ceil((time.time() - t0) * 1000),
    }
