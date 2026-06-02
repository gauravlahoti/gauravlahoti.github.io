from __future__ import annotations

import io


def extract_text(content: bytes, filename: str) -> str:
    """Return plain text from uploaded bytes; supports txt/md and PDF."""
    fname = filename.lower()
    if fname.endswith(".pdf"):
        return _extract_pdf(content)
    # txt / md / anything else — decode as UTF-8
    return content.decode("utf-8", errors="replace")


def _extract_pdf(content: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(content))
    parts: list[str] = []
    for page in reader.pages:
        text = page.extract_text() or ""
        if text.strip():
            parts.append(text)
    return "\n\n".join(parts)
