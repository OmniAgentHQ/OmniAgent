from __future__ import annotations

import sys

from .context import execute_program
from .service import run_service

def main() -> int:
    arguments = sys.argv[1:]
    if arguments and arguments[0] == "--worker":
        if len(arguments) != 4:
            raise SystemExit("--worker requires program, context, and result paths.")
        return execute_program(arguments[1], arguments[2], arguments[3])
    return run_service()

if __name__ == "__main__":
    raise SystemExit(main())
