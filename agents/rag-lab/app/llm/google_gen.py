from __future__ import annotations

import json
import math
import os
import time
from typing import Any, AsyncGenerator

DEFAULT_MODEL = "gemini-2.0-flash"
MAX_TOKENS = 2048
SYSTEM_PROMPT = (
    "You are a helpful assistant that answers questions grounded strictly in the provided context. "
    "Cite specific parts of the context when relevant. "
    "If the context does not contain enough information, say so clearly."
)


async def generate(
    query: str,
    context: str,
    mode: str,
    retrieval_fn,
    model: str = DEFAULT_MODEL,
    iteration_offset: int = 0,
) -> AsyncGenerator[dict[str, Any], None]:
    import google.generativeai as genai

    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY is not set")
    genai.configure(api_key=api_key)

    t0 = time.time()

    if mode == "linear":
        async for ev in _linear(genai, query, context, model, t0):
            yield ev
    else:
        async for ev in _agentic(genai, query, retrieval_fn, model, iteration_offset, t0):
            yield ev


async def _linear(genai, query, context, model, t0):
    gmodel = genai.GenerativeModel(model, system_instruction=SYSTEM_PROMPT)
    prompt = f"Context:\n{context}\n\nQuestion: {query}"
    response = gmodel.generate_content(prompt, stream=True)
    for chunk in response:
        text = chunk.text if hasattr(chunk, "text") else ""
        if text:
            yield {"type": "llm_token", "delta": text}
    yield {
        "type": "done",
        "usage": {"input": 0, "output": 0},
        "iterations": 1,
        "latencyMs": math.ceil((time.time() - t0) * 1000),
    }


async def _agentic(genai, query, retrieval_fn, model, iteration_offset, t0):
    from google.generativeai.types import FunctionDeclaration, Tool

    hybrid_tool = Tool(
        function_declarations=[
            FunctionDeclaration(
                name="hybrid_search",
                description="Search the corpus with hybrid retrieval.",
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "top_k": {"type": "integer"},
                    },
                    "required": ["query"],
                },
            )
        ]
    )

    gmodel = genai.GenerativeModel(
        model,
        system_instruction=SYSTEM_PROMPT,
        tools=[hybrid_tool],
    )
    chat = gmodel.start_chat()
    iteration = iteration_offset
    fused_results: list[dict] = []

    response = chat.send_message(query, stream=True)
    response.resolve()

    while True:
        iteration += 1
        fc = None
        text_parts = []

        for part in response.parts:
            if hasattr(part, "function_call") and part.function_call:
                fc = part.function_call
            elif hasattr(part, "text") and part.text:
                text_parts.append(part.text)

        if fc:
            args = dict(fc.args)
            tool_query = args.get("query", query)
            tool_top_k = int(args.get("top_k", 5))

            yield {"type": "tool_call", "iteration": iteration, "name": "hybrid_search", "args": args}

            gen = retrieval_fn(tool_query, tool_top_k, iteration)
            async for ev in gen:
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

            response = chat.send_message(
                {"role": "tool", "parts": [{"function_response": {"name": "hybrid_search", "response": {"result": result_text}}}]},
                stream=True,
            )
            response.resolve()

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
