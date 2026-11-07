from __future__ import annotations

import ast
import json
import re
import uuid
from typing import Any

class PlanValidationError(ValueError):
    pass

STEP_KINDS = {"normal", "ai", "condition", "wait"}
KNOWN_CAPABILITIES = {
    "ai.generate",
    "browser.control",
    "clipboard.read",
    "clipboard.write",
    "code.execute",
    "desktop.control",
    "document.read",
    "document.write",
    "filesystem.delete",
    "filesystem.move",
    "filesystem.open",
    "filesystem.read",
    "filesystem.write",
    "network.download",
    "network.request",
    "process.control",
    "process.inspect",
}

def extract_json_object(value: str) -> dict[str, Any]:
    text = value.strip().removeprefix("\ufeff")
    if text.startswith("```"):
        text = re.sub(r"^```[A-Za-z0-9_+.-]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    decoder = json.JSONDecoder()
    for index, character in enumerate(text):
        if character != "{":
            continue
        try:
            parsed, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise PlanValidationError("The automation compiler did not return a JSON object.")

def clean_python_code(value: Any) -> str:
    code = str(value or "").strip().removeprefix("\ufeff")
    code = re.sub(r"^```(?:python|py)?\s*", "", code, flags=re.IGNORECASE)
    code = re.sub(r"\s*```$", "", code)
    return code.strip()

def _main_function(tree: ast.AST) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    for node in getattr(tree, "body", []):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "main":
            return node
    return None

def validate_python_program(code: str) -> str:
    if not code or len(code.encode("utf-8")) > 500_000:
        raise PlanValidationError("The generated Python program is empty or too large.")
    try:
        tree = ast.parse(code, filename="<omniagent-automation>")
    except SyntaxError as error:
        raise PlanValidationError(
            f"Generated Python has invalid syntax at line {error.lineno}: {error.msg}"
        ) from error
    main = _main_function(tree)
    if main is None or not main.args.args:
        raise PlanValidationError("Generated Python must define main(ctx).")
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [alias.name for alias in node.names]
            if any(name.split(".", 1)[0] in {"sitecustomize", "usercustomize"} for name in names):
                raise PlanValidationError("Generated Python imports a forbidden interpreter hook.")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"eval", "exec"}:
            raise PlanValidationError("Generated Python may not dynamically eval or exec additional code.")
    return code

def _string_list(value: Any, maximum: int, item_length: int) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value[:maximum]:
        normalized = str(item).strip()[:item_length]
        if normalized and normalized not in result:
            result.append(normalized)
    return result

def normalize_plan(
    payload: dict[str, Any],
    *,
    instruction: str,
    requested_step_type: str = "normal",
    force_run: bool = False,
) -> dict[str, Any]:
    mode = str(payload.get("mode") or ("run" if force_run else "reply")).strip().lower()
    if force_run:
        mode = "run"
    if mode not in {"reply", "run"}:
        raise PlanValidationError("Automation plan mode must be reply or run.")
    public_message = str(
        payload.get("public_message")
        or payload.get("message")
        or ("Alright — I’m on it." if mode == "run" else "")
    ).strip()[:1_000]
    if mode == "reply":
        if not public_message:
            raise PlanValidationError("A conversational reply cannot be empty.")
        return {
            "schema_version": "1.0",
            "plan_id": f"pyplan_{uuid.uuid4().hex}",
            "mode": "reply",
            "public_message": public_message,
            "title": str(payload.get("title") or "Conversation").strip()[:200],
            "kind": "normal",
            "instruction": instruction,
            "capabilities": [],
            "requires_approval": False,
        }

    kind = str(payload.get("kind") or requested_step_type or "normal").strip().lower()
    aliases = {
        "action": "normal",
        "normal step": "normal",
        "ai generation": "ai",
        "ai_task": "ai",
        "condition (if/when)": "condition",
        "wait condition": "wait",
    }
    kind = aliases.get(kind, kind)
    if kind not in STEP_KINDS:
        kind = "normal"
    code = validate_python_program(clean_python_code(payload.get("code")))
    capabilities = [
        capability
        for capability in _string_list(payload.get("capabilities"), 40, 100)
        if capability in KNOWN_CAPABILITIES
    ]
    if "code.execute" not in capabilities:
        capabilities.append("code.execute")
    timeout_seconds = max(5, min(3_600, int(payload.get("timeout_seconds") or 300)))
    max_attempts = max(1, min(3, int(payload.get("max_attempts") or 2)))
    return {
        "schema_version": "1.0",
        "plan_id": str(payload.get("plan_id") or f"pyplan_{uuid.uuid4().hex}")[:100],
        "mode": "run",
        "title": str(payload.get("title") or "Complete requested automation").strip()[:200],
        "public_message": public_message or "Alright — I’m on it.",
        "kind": kind,
        "instruction": instruction,
        "code": code,
        "capabilities": capabilities,
        "requires_approval": bool(payload.get("requires_approval")),
        "approval_reason": str(payload.get("approval_reason") or "").strip()[:1_000],
        "timeout_seconds": timeout_seconds,
        "max_attempts": max_attempts,
        "expected_outputs": _string_list(payload.get("expected_outputs"), 100, 500),
        "success_criteria": _string_list(payload.get("success_criteria"), 100, 1_000),
        "estimated_duration_ms": max(
            1_000, min(3_600_000, int(payload.get("estimated_duration_ms") or timeout_seconds * 500))
        ),
    }
