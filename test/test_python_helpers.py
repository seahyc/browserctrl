import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


PYTHON_ROOT = Path(__file__).resolve().parents[1] / "python"
sys.path.insert(0, str(PYTHON_ROOT))

from chrome_cdp.helpers import helpers_for, init_workspace, load_helper


class HelperWorkspaceTests(unittest.TestCase):
    def symlink_or_skip_if_unsupported(self, link, target, **kwargs):
        try:
            link.symlink_to(target, **kwargs)
        except OSError as error:
            if os.name == "nt" and getattr(error, "winerror", None) == 1314:
                self.skipTest("Windows did not grant the symlink privilege required by this test")
            raise

    def test_init_workspace_is_the_only_api_that_creates_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "workspace"
            self.assertEqual(helpers_for("https://example.com", root), [])
            self.assertFalse(root.exists())

            self.assertEqual(init_workspace(root), root)
            self.assertTrue((root / "domain-skills").is_dir())
            self.assertTrue((root / "task_helpers").is_dir())

    def test_environment_selects_default_workspace(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "from-environment"
            with patch.dict(os.environ, {"CDP_HELPER_WORKSPACE": str(root)}):
                self.assertEqual(init_workspace(), root)

    def test_helpers_for_matches_only_the_exact_host_and_sorts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = init_workspace(temporary)
            exact = root / "domain-skills" / "example.com"
            lookalike = root / "domain-skills" / "notexample.com"
            subdomain = root / "domain-skills" / "shop.example.com"
            exact.mkdir()
            lookalike.mkdir()
            subdomain.mkdir()
            (exact / "z-last.md").write_text("last", encoding="utf-8")
            (exact / "SKILL.md").write_text("main", encoding="utf-8")
            (exact / "ignore.txt").write_text("ignore", encoding="utf-8")
            (lookalike / "wrong.md").write_text("wrong", encoding="utf-8")
            (subdomain / "other.md").write_text("other", encoding="utf-8")

            self.assertEqual(
                helpers_for("https://EXAMPLE.com:443/path", root),
                [exact / "SKILL.md", exact / "z-last.md"],
            )

    def test_load_helper_imports_explicit_simple_name(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = init_workspace(temporary)
            source = root / "task_helpers" / "page_title.py"
            source.write_text(
                "def page_title(client, target):\n"
                "    return client.send(target, 'Runtime.evaluate', "
                "expression='document.title', returnByValue=True)\n",
                encoding="utf-8",
            )

            module = load_helper("page_title", root)
            calls = []

            class Client:
                def send(self, *args, **kwargs):
                    calls.append((args, kwargs))
                    return {"result": "Example"}

            self.assertEqual(
                module.page_title(Client(), "target-1"), {"result": "Example"}
            )
            self.assertEqual(
                calls,
                [
                    (
                        ("target-1", "Runtime.evaluate"),
                        {"expression": "document.title", "returnByValue": True},
                    )
                ],
            )

    def test_load_helper_rejects_invalid_and_traversal_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = init_workspace(temporary)
            for name in ("../escape", "nested/helper", "hyphen-name", "", "."):
                with self.subTest(name=name):
                    with self.assertRaises(ValueError):
                        load_helper(name, root)

    def test_load_helper_refuses_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = init_workspace(Path(temporary) / "workspace")
            outside = Path(temporary) / "outside.py"
            outside.write_text("VALUE = 'outside'\n", encoding="utf-8")
            self.symlink_or_skip_if_unsupported(root / "task_helpers" / "linked.py", outside)

            with self.assertRaises(ValueError):
                load_helper("linked", root)

    def test_load_helper_refuses_symlinked_helper_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "workspace"
            root.mkdir()
            outside = base / "outside"
            outside.mkdir()
            (outside / "linked.py").write_text("VALUE = 'outside'\n", encoding="utf-8")
            self.symlink_or_skip_if_unsupported(
                root / "task_helpers", outside, target_is_directory=True
            )

            with self.assertRaises(ValueError):
                load_helper("linked", root)

    def test_load_helper_reports_missing_file_without_creating_workspace(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "absent"
            with self.assertRaises(FileNotFoundError):
                load_helper("missing", root)
            self.assertFalse(root.exists())


if __name__ == "__main__":
    unittest.main()
