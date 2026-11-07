from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

class ProviderError(RuntimeError):
    pass

def _post_json(
    url: str,
    *,
    headers: dict[str, str],
    body: dict[str, Any],
    timeout: int,
) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:2_000]
        raise ProviderError(f"AI provider returned HTTP {error.code}: {detail}") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise ProviderError(f"AI provider connection failed: {error}") from error

def generate_text(provider: dict[str, Any], prompt: str, timeout: int = 180) -> str:
    name = str(provider.get("name") or provider.get("provider") or "").lower()
    secret = str(provider.get("api_key") or provider.get("secret") or "")
    if not secret:
        raise ProviderError("A verified AI provider key is required by the Python compiler.")
    if name == "openai":
        payload = _post_json(
            "https://api.openai.com/v1/responses",
            headers={"Authorization": f"Bearer {secret}"},
            body={
                "model": str(provider.get("model") or "gpt-5.4-mini"),
                "reasoning": {"effort": "high", "summary": "auto"},
                "text": {"verbosity": "medium"},
                "store": False,
                "input": prompt,
            },
            timeout=timeout,
        )
        direct = payload.get("output_text")
        if direct:
            return str(direct)
        pieces: list[str] = []
        for output in payload.get("output") or []:
            for content in output.get("content") or []:
                if content.get("text"):
                    pieces.append(str(content["text"]))
        if pieces:
            return "\n".join(pieces)
        raise ProviderError("OpenAI returned an empty compiler response.")
    if name in {"claude", "anthropic"}:
        payload = _post_json(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": secret,
                "anthropic-version": "2023-06-01",
            },
            body={
                "model": str(provider.get("model") or "claude-sonnet-4-6"),
                "max_tokens": int(provider.get("max_tokens") or 16_000),
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=timeout,
        )
        pieces = [
            str(item.get("text") or "")
            for item in payload.get("content") or []
            if item.get("type") == "text"
        ]
        text = "\n".join(piece for piece in pieces if piece).strip()
        if text:
            return text
        raise ProviderError("Claude returned an empty compiler response.")
    raise ProviderError(f"Unsupported AI provider: {provider.get('name') or provider.get('provider')}")

def generate_image(provider: dict[str, Any], prompt: str, timeout: int = 180) -> bytes:
    import base64

    name = str(provider.get("name") or provider.get("provider") or "").lower()
    secret = str(provider.get("api_key") or provider.get("secret") or "")
    if name != "openai" or not secret:
        raise ProviderError("Image generation requires a verified OpenAI key.")
    payload = _post_json(
        "https://api.openai.com/v1/images/generations",
        headers={"Authorization": f"Bearer {secret}"},
        body={
            "model": str(provider.get("image_model") or "gpt-image-1"),
            "prompt": prompt,
            "size": "1024x1024",
        },
        timeout=timeout,
    )
    encoded = (payload.get("data") or [{}])[0].get("b64_json")
    if not encoded:
        raise ProviderError("OpenAI returned no image bytes.")
    return base64.b64decode(encoded)
