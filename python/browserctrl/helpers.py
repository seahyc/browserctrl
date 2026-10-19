"""Opt-in discovery and loading for Chrome CDP task helpers.

Domain documents are returned as paths for callers to inspect as untrusted
guidance.  Python task helpers are imported only when a caller names one
explicitly; this module never derives executable code from page content.
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
import re
import sys
from types import ModuleType
from urllib.parse import urlsplit




def _default_workspace() -> Path:
    """Where browserctrl keeps its data on this system, plus helpers/ (same rule as the Node side)."""
    env = os.environ
    root = env.get("BROWSERCTRL_HOME") or env.get("CDP_HOME")
    if root:
        return Path(root) / "helpers"
    home = Path.home()
    if sys.platform == "win32":
        base = Path(env.get("LOCALAPPDATA") or home / "AppData" / "Local") / "browserctrl"
    elif sys.platform == "darwin":
        base = home / "Library" / "Application Support" / "browserctrl"
    else:
        base = Path(env.get("XDG_DATA_HOME") or home / ".local" / "share") / "browserctrl"
    old = home / ".local" / "share" / "chrome-cdp" / "helpers"
    # Keep using the old folder when it exists and the new one does not.
    return old if old.exists() and not (base / "helpers").exists() else base / "helpers"
_SIMPLE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _workspace_path(workspace: os.PathLike[str] | str | None) -> Path:
    if workspace is None:
        workspace = os.environ.get("BROWSERCTRL_HELPER_WORKSPACE") or os.environ.get("CDP_HELPER_WORKSPACE") or _default_workspace()
    return Path(workspace).expanduser()


def init_workspace(workspace: os.PathLike[str] | str | None = None) -> Path:
    """Create and return the helper workspace and its standard directories."""

    root = _workspace_path(workspace)
    (root / "domain-skills").mkdir(parents=True, exist_ok=True)
    (root / "task_helpers").mkdir(parents=True, exist_ok=True)
    return root


def helpers_for(
    url: str, workspace: os.PathLike[str] | str | None = None
) -> list[Path]:
    """Return Markdown guidance files for the URL's exact host.

    This function performs discovery only.  It does not create the workspace,
    read the documents, or treat their contents as trusted instructions.
    """

    host = urlsplit(url).hostname
    if not host:
        return []

    directory = _workspace_path(workspace) / "domain-skills" / host
    if not directory.is_dir():
        return []

    # SKILL.md is already included by the glob.  The set keeps the contract
    # deduplicated if discovery rules grow later.
    return sorted({path for path in directory.glob("*.md") if path.is_file()})


def load_helper(
    name: str, workspace: os.PathLike[str] | str | None = None
) -> ModuleType:
    """Import one explicitly named Python task helper from the workspace."""

    if not isinstance(name, str) or not _SIMPLE_NAME.fullmatch(name):
        raise ValueError("helper name must be a simple Python identifier")

    root = _workspace_path(workspace)
    helper_directory = root / "task_helpers"
    candidate = helper_directory / f"{name}.py"

    if helper_directory.is_symlink():
        raise ValueError("task_helpers directory must not be a symbolic link")
    if candidate.is_symlink():
        raise ValueError("helper file must not be a symbolic link")

    resolved_directory = helper_directory.resolve(strict=False)
    resolved_candidate = candidate.resolve(strict=False)
    try:
        resolved_candidate.relative_to(resolved_directory)
    except ValueError as error:
        raise ValueError("helper path escapes the task_helpers directory") from error

    if not resolved_candidate.is_file():
        raise FileNotFoundError(resolved_candidate)

    module_key = hashlib.sha256(os.fsencode(resolved_candidate)).hexdigest()
    module_name = f"_browserctrl_task_helper_{module_key}"
    spec = importlib.util.spec_from_file_location(module_name, resolved_candidate)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load helper: {name}")

    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(module_name, None)
        raise
    return module
