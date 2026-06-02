HYBRID_SEARCH_TOOL = {
    "name": "hybrid_search",
    "description": (
        "Search the ingested document corpus using hybrid retrieval (dense semantic + BM25 lexical, "
        "fused with Reciprocal Rank Fusion). Use this to find relevant chunks before answering. "
        "You may call it multiple times with different queries to gather more context."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query to retrieve relevant chunks",
            },
            "top_k": {
                "type": "integer",
                "description": "Number of results to return (default 5)",
                "default": 5,
            },
        },
        "required": ["query"],
    },
}
