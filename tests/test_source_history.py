"""Opt-in verification against the exact external SHA in a generated site."""

import json
import os
from pathlib import Path

import pytest

from course_dashboard.history import git, normalize, summarize


def test_generated_latest_equals_pinned_upstream():
    source = os.environ.get("COURSE_SOURCE_DIR")
    if not source:
        pytest.skip("Set COURSE_SOURCE_DIR after generating site to verify real data")
    site = Path("site")
    manifest = json.loads((site / "manifest.json").read_text(encoding="utf-8"))
    bundle = json.loads((site / manifest["file"]).read_text(encoding="utf-8"))
    repo = Path(source)
    sha = bundle["source_sha"]
    paths = ["courses/semesters/11510.json", "data/courses/semesters/11510.json"]
    available = git(
        repo, "ls-tree", "-r", "--name-only", sha, "--", *paths
    ).splitlines()
    path = next(path for path in paths if path in available)
    expected = normalize(json.loads(git(repo, "show", f"{sha}:{path}")), "11510")
    latest = bundle["snapshots"][-1]
    actual = [bundle["versions"][index] for index in latest["indices"]]
    assert actual == expected
    assert latest["summary"] == summarize(expected)
    assert bundle["snapshots"][0]["time"][:10] == "2026-06-15"
    assert git(repo, "rev-parse", "--is-shallow-repository").strip() == "false"
