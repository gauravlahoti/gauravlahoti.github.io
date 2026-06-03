from __future__ import annotations

import base64
import io
import re


def extract_text(content: bytes, filename: str) -> str:
    """Return plain text from uploaded bytes; supports txt/md and PDF."""
    fname = filename.lower()
    if fname.endswith(".pdf"):
        return _extract_pdf(content)
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


async def fetch_url(url: str) -> str:
    """Fetch a URL and return clean body text."""
    import urllib.request

    if not url.startswith(("http://", "https://")):
        raise ValueError("URL must start with http:// or https://")

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 RAGLab/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
        content_type = resp.headers.get("Content-Type", "")

    if "pdf" in content_type:
        return _extract_pdf(raw)

    html = raw.decode("utf-8", errors="replace")
    return _html_to_text(html)


def _html_to_text(html: str) -> str:
    """Extract readable body text from HTML, dropping nav/header/footer/aside noise."""
    # Drop non-content blocks entirely
    for tag in ("script", "style", "noscript", "nav", "header", "footer",
                "aside", "form", "iframe", "svg", "figure"):
        html = re.sub(
            rf"<{tag}[^>]*>.*?</{tag}>", " ", html,
            flags=re.DOTALL | re.IGNORECASE,
        )

    # Convert block elements to newlines so structure is preserved
    for tag in ("p", "div", "section", "article", "li", "h1", "h2", "h3",
                "h4", "h5", "h6", "br", "tr", "blockquote", "pre"):
        html = re.sub(rf"</?{tag}[^>]*>", "\n", html, flags=re.IGNORECASE)

    # Strip remaining tags
    html = re.sub(r"<[^>]+>", "", html)

    # Decode common HTML entities
    html = html.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">") \
               .replace("&nbsp;", " ").replace("&#39;", "'").replace("&quot;", '"')

    # Collapse whitespace
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in html.splitlines()]
    # Drop blank/very short lines (nav fragments, button labels, etc.)
    lines = [ln for ln in lines if len(ln) > 20]
    # Collapse runs of blank lines
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines))
    return text.strip()


async def extract_image_text(content: bytes, mime_type: str, api_key: str) -> str:
    """Use Gemini Vision to extract/describe text from an image."""
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    b64 = base64.b64encode(content).decode()
    prompt = (
        "Extract all text visible in this image verbatim. "
        "If there is no text, provide a detailed description of the image content "
        "suitable for embedding and retrieval."
    )
    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=[
            types.Part.from_bytes(data=base64.b64decode(b64), mime_type=mime_type),
            prompt,
        ],
    )
    return response.text.strip()
