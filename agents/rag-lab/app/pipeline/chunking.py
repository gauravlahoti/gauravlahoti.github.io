from __future__ import annotations

import math
import re
from typing import Any

_SEPARATORS = ["\n\n", "\n", ". ", " ", ""]

# Supported chunking strategies (id → label is owned by the frontend).
STRATEGIES = ("recursive", "fixed", "sentence", "paragraph")


def chunk_text(
    text: str,
    chunk_size: int = 800,
    chunk_overlap: int = 120,
    strategy: str = "recursive",
) -> list[dict[str, Any]]:
    """Split text into chunks using the chosen strategy. Returns chunk dicts."""
    if strategy == "fixed":
        pieces = _fixed(text, chunk_size, chunk_overlap)
    elif strategy == "sentence":
        pieces = _sentence(text, chunk_size, chunk_overlap)
    elif strategy == "paragraph":
        pieces = _paragraph(text, chunk_size, chunk_overlap)
    else:  # recursive (default)
        pieces = _split(text, chunk_size, chunk_overlap, _SEPARATORS)
    return _finalize(text, pieces, chunk_overlap)


def _finalize(text: str, pieces: list[str], chunk_overlap: int) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    offset = 0
    for i, piece in enumerate(pieces):
        start = text.find(piece, offset)
        if start == -1:
            start = offset
        end = start + len(piece)
        offset = max(offset, end - chunk_overlap)
        result.append(
            {
                "index": i,
                "text": piece,
                "start": start,
                "end": end,
                "tokenCount": math.ceil(len(piece) / 4),
            }
        )
    return result


def _fixed(text: str, size: int, overlap: int) -> list[str]:
    """Fixed-size character windows with a sliding overlap — no boundary awareness."""
    step = max(1, size - overlap)
    out = []
    for i in range(0, len(text), step):
        piece = text[i : i + size]
        if piece.strip():
            out.append(piece)
        if i + size >= len(text):
            break
    return out


def _sentence(text: str, size: int, overlap: int) -> list[str]:
    """Group whole sentences up to the size budget; carry a tail for overlap."""
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]
    chunks: list[str] = []
    cur: list[str] = []
    cur_len = 0
    for s in sentences:
        if cur and cur_len + len(s) + 1 > size:
            chunks.append(" ".join(cur))
            # carry trailing sentences worth ~overlap chars into the next chunk
            carry: list[str] = []
            carry_len = 0
            for prev in reversed(cur):
                if carry_len + len(prev) > overlap:
                    break
                carry.insert(0, prev)
                carry_len += len(prev) + 1
            cur = carry[:]
            cur_len = carry_len
        cur.append(s)
        cur_len += len(s) + 1
    if cur:
        chunks.append(" ".join(cur))
    return chunks


def _paragraph(text: str, size: int, overlap: int) -> list[str]:
    """Pack paragraphs (blank-line separated) up to the size budget."""
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    cur = ""
    for p in paras:
        if len(p) > size:
            # a single oversized paragraph → fall back to the recursive splitter
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.extend(_split(p, size, overlap, _SEPARATORS))
            continue
        candidate = (cur + "\n\n" + p) if cur else p
        if len(candidate) > size and cur:
            chunks.append(cur)
            cur = p
        else:
            cur = candidate
    if cur:
        chunks.append(cur)
    return chunks


def _split(text: str, size: int, overlap: int, separators: list[str]) -> list[str]:
    if len(text) <= size:
        return [text] if text.strip() else []

    sep = separators[0] if separators else ""
    remaining_seps = separators[1:] if separators else []

    if sep and sep in text:
        parts = text.split(sep)
    else:
        if remaining_seps:
            return _split(text, size, overlap, remaining_seps)
        # Hard split
        chunks: list[str] = []
        for i in range(0, len(text), size - overlap):
            chunk = text[i : i + size]
            if chunk.strip():
                chunks.append(chunk)
        return chunks

    # Merge parts back up to chunk_size with overlap
    chunks = []
    current = ""
    for part in parts:
        piece = (current + sep + part) if current else part
        if len(piece) <= size:
            current = piece
        else:
            if current.strip():
                # Current exceeds if we add this part — flush current
                sub = _split(current, size, overlap, remaining_seps) if len(current) > size else [current]
                chunks.extend(sub)
            current = part

    if current.strip():
        sub = _split(current, size, overlap, remaining_seps) if len(current) > size else [current]
        chunks.extend(sub)

    # Re-index with overlap stitching
    if overlap == 0 or len(chunks) <= 1:
        return chunks

    overlapped: list[str] = [chunks[0]]
    for i in range(1, len(chunks)):
        prev_tail = chunks[i - 1][-overlap:]
        overlapped.append(prev_tail + sep + chunks[i] if prev_tail else chunks[i])
    return overlapped
