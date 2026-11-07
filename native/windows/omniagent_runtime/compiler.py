from __future__ import annotations

import json
from typing import Any

from .capabilities import action_names
from .models import PlanValidationError, extract_json_object, normalize_plan
from .provider import generate_text

def _compiler_prompt(
    instruction: str,
    *,
    step_type: str,
    context: dict[str, Any],
    force_run: bool,
    validation_error: str = "",
    previous_response: str = "",
) -> str:
    actions = ", ".join(action_names())
    return "\n\n".join(
        item
        for item in [
            "You are the OmniAgent Python Automation Compiler.",
            "Translate the user's human-language request into a complete, executable Python program that solves the actual task intelligently.",
            "Return one strict JSON object and no Markdown.",
            (
                '{"mode":"run|reply","title":"short title","public_message":"natural acknowledgement or reply",'
                '"kind":"normal|ai|condition|wait","code":"complete Python source defining main(ctx)",'
                '"capabilities":["..."],"requires_approval":false,"approval_reason":"",'
                '"timeout_seconds":300,"max_attempts":2,"estimated_duration_ms":60000,'
                '"expected_outputs":["glob or absolute path"],"success_criteria":["concrete check"]}'
            ),
            (
                "If this is merely conversation and force_run is false, return mode=reply with no code. "
                "Otherwise return mode=run and a complete program."
            ),
            (
                "The program must define def main(ctx): or async def main(ctx):. "
                "It receives the exact instruction at ctx.instruction, the run folder at ctx.output_dir, "
                "the permanent workspace at ctx.workspace, prior values at ctx.data, and structured inputs at ctx.inputs."
            ),
            (
                "Prefer deterministic Python, standard libraries, installed automation libraries, semantic Windows UI Automation, "
                "direct APIs, and filesystem/process operations. Do not use physical mouse coordinates unless no semantic method exists."
            ),
            (
                "Bundled libraries available to generated programs include requests, BeautifulSoup (bs4), Pillow, psutil, "
                "openpyxl, python-docx (docx), python-pptx (pptx), pypdf, pywin32, and pywinauto."
            ),
            (
                "Available helpers include ctx.call(operation, **arguments), ctx.output_path(relative), ctx.write_text, "
                "ctx.write_bytes, ctx.read_text, ctx.artifact, ctx.progress, ctx.run, ctx.powershell, ctx.open_path, "
                "ctx.open_url, ctx.download, ctx.windows, ctx.window_controls, ctx.window_invoke, ctx.ai_text, and ctx.ai_image."
            ),
            f"Registered deterministic actions: {actions}",
            (
                "For web pages, use ctx.open_url to open an ordinary tab in the user's registered default browser. "
                "Never create a separate browser profile or attach through CDP. Interact with the visible browser "
                "through ctx.windows, ctx.window_controls, and ctx.window_invoke using semantic Windows UI Automation."
            ),
            (
                "Use ctx.ai_text or ctx.ai_image only when the requested content or judgment genuinely requires an AI model. "
                "Clean and transform AI output in Python before writing or inserting it."
            ),
            (
                "For software projects, generate all requested files, run appropriate validation/build commands when available, "
                "repair failures when feasible, and return the real output paths. Never respond with instructions telling the user how to do the work."
            ),
            (
                "Mark requires_approval=true only at the exact consequential action: actually sending a message, purchasing, "
                "publishing, deleting meaningful user data, submitting a consequential form, or entering a secret. Opening or "
                "reading an already signed-in app, navigating, drafting unsent text, and filling an unsent reply do not require "
                "approval. Never request approval merely because a browser is involved. A login, CAPTCHA, MFA, or credential "
                "checkpoint is a runtime blocker and must only be reported after it is visibly observed."
            ),
            (
                "Never hard-code an output folder when ctx.output_dir should be used. Preserve explicit user-supplied paths when the task targets them. "
                "Do not claim success in the program; return evidence and let the runtime verify it."
            ),
            f"Requested step type: {step_type}",
            f"Force executable run: {force_run}",
            f"Runtime context: {json.dumps(context, ensure_ascii=False, default=str)[:30_000]}",
            f"User instruction:\n{instruction}",
            f"Previous invalid compiler response:\n{previous_response[:60_000]}" if previous_response else "",
            f"Validation error to repair:\n{validation_error[:4_000]}" if validation_error else "",
        ]
        if item
    )

def compile_instruction(
    instruction: str,
    *,
    provider: dict[str, Any],
    step_type: str = "normal",
    context: dict[str, Any] | None = None,
    force_run: bool = False,
    maximum_attempts: int = 3,
) -> dict[str, Any]:
    previous = ""
    validation_error = ""
    for _attempt in range(max(1, min(3, maximum_attempts))):
        response = generate_text(
            provider,
            _compiler_prompt(
                instruction,
                step_type=step_type,
                context=context or {},
                force_run=force_run,
                validation_error=validation_error,
                previous_response=previous,
            ),
            timeout=240,
        )
        try:
            return normalize_plan(
                extract_json_object(response),
                instruction=instruction,
                requested_step_type=step_type,
                force_run=force_run,
            )
        except PlanValidationError as error:
            previous = response
            validation_error = str(error)
    raise PlanValidationError(validation_error or "The Python automation plan could not be validated.")

def repair_plan(
    plan: dict[str, Any],
    failure: dict[str, Any],
    *,
    provider: dict[str, Any],
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    prompt = "\n\n".join(
        [
            "Repair this failed OmniAgent Python automation.",
            "Return the same strict JSON schema as the original compiler. Return no Markdown.",
            "Preserve the user's intent, destinations, approval requirement, and successful behavior.",
            "Change the Python program to directly address the observed failure. Do not merely hide or ignore the error.",
            f"Original plan:\n{json.dumps(plan, ensure_ascii=False, default=str)[:100_000]}",
            f"Observed failure:\n{json.dumps(failure, ensure_ascii=False, default=str)[:30_000]}",
            f"Runtime context:\n{json.dumps(context or {}, ensure_ascii=False, default=str)[:30_000]}",
        ]
    )
    response = generate_text(provider, prompt, timeout=240)
    return normalize_plan(
        extract_json_object(response),
        instruction=str(plan.get("instruction") or ""),
        requested_step_type=str(plan.get("kind") or "normal"),
        force_run=True,
    )
