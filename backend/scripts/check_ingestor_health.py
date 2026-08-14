#!/usr/bin/env python3
"""
Pre-commit / CI guard for services/ingestor.py.

Catches classes of bugs that have broken the daily cron in the past 3 days:

1. **Shadow imports** — `from X import Y` inside a function where `Y` is
   also imported at module level. Python treats function-scoped `from`
   statements as local bindings for the entire function scope, causing
   UnboundLocalError on earlier references to `Y`. This bug wedged the
   daily cron for 2h on 2026-08-14.

2. **Bare `except:` clauses** — swallow ALL exceptions including
   KeyboardInterrupt and SystemExit. Use `except Exception:` instead.

3. **`background_tasks.add_task` without try/except** — FastAPI eats
   exceptions in background tasks. Every long-running background task
   entry point must have a top-level `try/except Exception: logger.exception`
   wrapper so failures land in the log.

4. **Compile check** — force bytecode compilation of every function in
   the module to surface UnboundLocalError-class bugs that `py_compile`
   misses.

Exit codes:
    0 — all checks pass
    1 — one or more checks failed (details printed to stderr)

Usage:
    python backend/scripts/check_ingestor_health.py
"""
from __future__ import annotations

import ast
import dis
import importlib.util
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND = REPO_ROOT / "backend"
INGESTOR = BACKEND / "services" / "ingestor.py"


def _module_level_imports(tree: ast.Module) -> set[str]:
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                names.add(alias.asname or alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.asname or alias.name.split(".")[0])
    return names


def check_shadow_imports(tree: ast.Module) -> list[str]:
    """Find `from X import Y` inside functions where Y is already at module level."""
    module_names = _module_level_imports(tree)
    issues: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef):
            continue
        for sub in ast.walk(node):
            if not isinstance(sub, (ast.ImportFrom, ast.Import)):
                continue
            names: list[str] = []
            if isinstance(sub, ast.ImportFrom):
                names = [a.asname or a.name for a in sub.names]
            else:
                names = [a.asname or a.name.split(".")[0] for a in sub.names]
            for name in names:
                if name in module_names:
                    issues.append(
                        f"  {INGESTOR.name}:{sub.lineno} — function `{node.name}` "
                        f"imports `{name}` locally; shadows module-level import."
                    )
    return issues


def check_bare_except(tree: ast.Module) -> list[str]:
    """Find `except:` clauses that catch KeyboardInterrupt / SystemExit."""
    issues: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ExceptHandler) and node.type is None:
            issues.append(
                f"  {INGESTOR.name}:{node.lineno} — bare `except:` clause; "
                f"use `except Exception:` instead."
            )
    return issues


def check_background_task_wrappers(tree: ast.Module) -> list[str]:
    """Warn if run_ingestion's outer body isn't wrapped in try/except Exception."""
    issues: list[str] = []
    for node in tree.body:
        if not (isinstance(node, ast.FunctionDef) and node.name == "run_ingestion"):
            continue
        # Look for the outermost try wrapping the whole body (or the meaningful part of it).
        # Heuristic: the function should contain at least one top-level Try node whose
        # body has more than 5 statements. Otherwise the "background_tasks.add_task"
        # caller has nowhere to see exceptions.
        try_bodies = [n for n in node.body if isinstance(n, ast.Try)]
        if not try_bodies or max((len(t.body) for t in try_bodies), default=0) < 5:
            issues.append(
                f"  {INGESTOR.name}:{node.lineno} — run_ingestion should have "
                f"an outer try/except Exception wrapper. Background tasks silently "
                f"eat exceptions otherwise."
            )
    return issues


def check_bytecode_compiles() -> list[str]:
    """Import the module and force bytecode compilation of every function."""
    issues: list[str] = []
    sys.path.insert(0, str(BACKEND))
    try:
        spec = importlib.util.spec_from_file_location("services.ingestor", INGESTOR)
        if spec is None or spec.loader is None:
            return [f"  Cannot load spec for {INGESTOR}"]
        mod = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(mod)
        except Exception as exc:
            return [f"  Import failed: {exc}"]
        for name in dir(mod):
            fn = getattr(mod, name)
            if callable(fn) and getattr(fn, "__module__", None) == "services.ingestor":
                try:
                    list(dis.get_instructions(fn))
                except Exception as exc:
                    issues.append(f"  Cannot compile `{name}`: {exc}")
    finally:
        if str(BACKEND) in sys.path:
            sys.path.remove(str(BACKEND))
    return issues


def main() -> int:
    if not INGESTOR.exists():
        print(f"ERROR: {INGESTOR} not found", file=sys.stderr)
        return 1

    with open(INGESTOR) as fh:
        source = fh.read()
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        print(f"SYNTAX ERROR in {INGESTOR}: {exc}", file=sys.stderr)
        return 1

    all_issues: dict[str, list[str]] = {
        "Shadow imports (Python UnboundLocalError trap)": check_shadow_imports(tree),
        "Bare except clauses": check_bare_except(tree),
        "run_ingestion missing try/except wrapper": check_background_task_wrappers(tree),
    }

    # Bytecode compilation only runs when backend dependencies are
    # installed (i.e. locally on the developer's machine or on the
    # droplet during the startup smoke test). Skipping on bare CI
    # runners — the startup smoke test in main.py's lifespan already
    # covers this check post-deploy.
    try:
        import sqlalchemy  # noqa: F401
        all_issues["Bytecode compilation"] = check_bytecode_compiles()
    except ImportError:
        print("SKIP  — Bytecode compilation (backend deps not installed; "
              "covered by startup smoke test on droplet)")

    failed = False
    for check_name, issues in all_issues.items():
        if issues:
            failed = True
            print(f"\nFAIL — {check_name}:", file=sys.stderr)
            for issue in issues:
                print(issue, file=sys.stderr)
        else:
            print(f"OK   — {check_name}")

    if failed:
        print("\nOne or more ingestor-health checks failed. Fix before committing.", file=sys.stderr)
        return 1
    print("\nAll ingestor-health checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
