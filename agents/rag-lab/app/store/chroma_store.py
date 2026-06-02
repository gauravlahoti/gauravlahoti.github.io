from __future__ import annotations

from pathlib import Path


COLLECTION_NAME = "rag_lab"
_CHROMA_PATH = str(Path(__file__).parent.parent.parent / ".chroma")


def get_or_create_collection(dim: int | None = None):
    """Return a Chroma collection, creating it fresh each session reset."""
    try:
        import chromadb
        client = chromadb.PersistentClient(path=_CHROMA_PATH)
    except Exception:
        import chromadb
        client = chromadb.EphemeralClient()

    # Always recreate to reset vector size constraint
    try:
        client.delete_collection(COLLECTION_NAME)
    except Exception:
        pass

    collection = client.create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
        embedding_function=None,  # we supply our own
    )
    return collection
