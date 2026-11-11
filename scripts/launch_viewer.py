"""Launch the bundled interactive CalcGO structure viewer."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parent.parent
VIEWER_DIR = SKILL_ROOT / "assets" / "structure-viewer"
SERVER = VIEWER_DIR / "server.py"


def main() -> int:
    parser = argparse.ArgumentParser(description="Launch the bundled structure viewer.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8090)
    browser_group = parser.add_mutually_exclusive_group()
    browser_group.add_argument("--browser", dest="open_browser", action="store_true")
    browser_group.add_argument("--no-browser", dest="open_browser", action="store_false")
    parser.set_defaults(open_browser=False)
    parser.add_argument("--print-path", action="store_true", help="only print viewer path")
    args = parser.parse_args()

    if args.print_path:
        print(VIEWER_DIR)
        return 0
    if not SERVER.is_file():
        print(f"ERROR: bundled viewer is missing: {SERVER}", file=sys.stderr)
        return 2

    command = [
        sys.executable,
        str(SERVER),
        "--host",
        args.host,
        "--port",
        str(args.port),
    ]
    if not args.open_browser:
        command.append("--no-browser")
    try:
        return subprocess.call(command, cwd=str(VIEWER_DIR))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
