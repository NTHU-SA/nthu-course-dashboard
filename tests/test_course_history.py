import json
import os
import subprocess
from datetime import datetime

import pytest

from course_dashboard.history import (
    build_history,
    compare,
    normalize,
    numeric,
    parse_boundary,
    summarize,
)


def course(identity="11510CS 101000", **fields):
    return {
        "id": identity,
        "chinese_title": "程式設計",
        "english_title": "Programming",
        "credit": "3",
        "size_limit": "40",
        "time": "M1M2",
        "language": "中",
        "lecturer": "測試教師",
        "suspend": "",
        **fields,
    }


def git(repo, *args, timestamp=None):
    env = os.environ.copy()
    if timestamp:
        env.update(GIT_AUTHOR_DATE=timestamp, GIT_COMMITTER_DATE=timestamp)
    return subprocess.check_output(
        ["git", "-C", str(repo), *args], encoding="utf-8", env=env
    ).strip()


@pytest.fixture
def history(tmp_path):
    git(tmp_path, "init", "--quiet")
    git(tmp_path, "config", "user.name", "Test")
    git(tmp_path, "config", "user.email", "test@example.test")

    def commit(rows, day, path="data/courses/semesters/11510.json", remove=None):
        file = tmp_path.joinpath(*path.split("/"))
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
        if remove:
            tmp_path.joinpath(*remove.split("/")).unlink()
        git(tmp_path, "add", "-A")
        git(
            tmp_path,
            "commit",
            "--quiet",
            "-m",
            day,
            timestamp=f"2026-06-{day}T12:00:00+08:00",
        )
        return git(tmp_path, "rev-parse", "HEAD")

    return tmp_path, commit


@pytest.mark.parametrize(
    "text,integer,expected",
    [
        ("", True, (None, "unknown")),
        ("  ", True, (None, "unknown")),
        ("0", True, (0, "zero")),
        ("40", True, (40, "positive")),
        ("0.5", False, (0.5, "positive")),
        ("40.0", True, (40, "positive")),
        ("0.5", True, (None, "invalid")),
        ("不限", True, (None, "invalid")),
        ("-1", True, (None, "invalid")),
        ("NaN", False, (None, "invalid")),
        ("Infinity", False, (None, "invalid")),
        ("9007199254740992", True, (None, "invalid")),
    ],
)
def test_numeric_semantics(text, integer, expected):
    assert numeric(text, integer=integer) == expected


def test_normalization_quality_and_unique_slots():
    normalized = normalize(
        [
            course(credit="0.5", time="M1 M1 Tn Ta Tb Tc Td T0", size_limit="0"),
            course("11510EE 102000", time="T2T3教室101", size_limit="不限"),
            course("11510GE 103000", time="", size_limit="", student_count=""),
        ],
        "11510",
    )
    by_id = {row["id"]: row for row in normalized}
    first = by_id["11510CS 101000"]
    assert first["unit"] == "CS"
    assert first["credit_value"] == 0.5
    assert first["size_limit_state"] == "zero"
    assert len(first["slots"]) == 7
    assert first["issues"] == []
    assert by_id["11510EE 102000"]["slots"] == []
    assert by_id["11510EE 102000"]["issues"] == ["size_limit", "time"]
    assert by_id["11510GE 103000"]["student_count_value"] is None
    summary = summarize(normalized)
    assert summary["capacity_known"] == 0
    assert summary["capacity_unknown"] == summary["capacity_zero"] == 1
    assert summary["invalid_time"] == summary["missing_time"] == 1


@pytest.mark.parametrize(
    "rows,message",
    [
        ([course(), course()], "Duplicate"),
        ([course("11520CS 101000")], "identity"),
        ([course(chinese_title="", english_title="")], "title"),
        ([course(credit=3)], "strings"),
        ({"id": "bad"}, "list"),
        ([None], "object"),
    ],
)
def test_invalid_snapshots_are_explicit(rows, message):
    with pytest.raises(ValueError, match=message):
        normalize(rows, "11510")


def test_path_migration_reorder_delta_and_reappearance(history):
    repo, commit = history
    first = course()
    second = course("11510EE 102000", size_limit="")
    baseline_sha = commit([first, second], "15")
    commit(
        [second, first],
        "16",
        path="courses/semesters/11510.json",
        remove="data/courses/semesters/11510.json",
    )
    changed_sha = commit(
        [course(size_limit="60", time="W3", language="英", lecturer="新教師")],
        "20",
        path="courses/semesters/11510.json",
    )
    commit([], "21", path="courses/semesters/11510.json")
    final_sha = commit([first], "25", path="courses/semesters/11510.json")
    bundle = build_history(repo, ref="HEAD")
    snapshots = bundle["snapshots"]
    assert bundle["source_sha"] == final_sha
    assert [s["sha"] for s in snapshots] == [
        baseline_sha,
        changed_sha,
        snapshots[2]["sha"],
        final_sha,
    ]
    assert len(snapshots) == 4
    assert snapshots[0]["baseline"]
    assert snapshots[0]["changes"] == []
    changed = snapshots[1]["changes"]
    assert changed[0]["fields"] == ["language", "lecturer", "size_limit", "time"]
    assert changed[1]["kind"] == "removed"
    assert snapshots[2]["summary"]["courses"] == 0
    assert snapshots[3]["changes"][0]["kind"] == "added"
    assert len(bundle["versions"]) == 3
    assert snapshots[0]["indices"][0] == snapshots[3]["indices"][0]
    assert snapshots[0]["summary"]["capacity"] == 40
    assert snapshots[0]["summary"]["capacity_known"] == 1


def test_period_includes_prior_baseline(history):
    repo, commit = history
    commit([course()], "15")
    commit([course(size_limit="50")], "20")
    commit([course(size_limit="60")], "25")
    result = build_history(repo, ref="HEAD", since="2026-06-18", until="2026-06-20")
    assert len(result["snapshots"]) == 2
    assert result["snapshots"][0]["summary"]["capacity"] == 40
    assert result["snapshots"][1]["summary"]["capacity"] == 50
    assert result["snapshots"][1]["changes"][0]["fields"] == ["size_limit"]
    result = build_history(repo, ref="HEAD", since="2026-06-26")
    assert len(result["snapshots"]) == 1
    assert result["snapshots"][0]["summary"]["capacity"] == 60
    with pytest.raises(ValueError, match="No .* observations"):
        build_history(repo, ref="HEAD", until="2026-06-01")
    with pytest.raises(ValueError, match="precede"):
        build_history(repo, ref="HEAD", since="2026-06-20", until="2026-06-19")


def test_first_parent_excludes_unpublished_side_branch(history):
    repo, commit = history
    baseline = commit([course()], "15")
    original_branch = git(repo, "branch", "--show-current")
    git(repo, "checkout", "--quiet", "-b", "side")
    side = commit([course(size_limit="999")], "16")
    git(repo, "checkout", "--quiet", original_branch)
    commit([course(size_limit="50")], "20")
    git(repo, "merge", "--quiet", "-s", "ours", "--no-ff", "-m", "merge side", "side")
    bundle = build_history(repo, ref="HEAD")
    assert len(bundle["snapshots"]) == 2
    assert bundle["snapshots"][0]["sha"] == baseline
    assert side not in [s["sha"] for s in bundle["snapshots"]]


def test_malformed_history_stops_generation(history):
    repo, commit = history
    commit([course()], "15")
    sha = commit([course(), course()], "16")
    with pytest.raises(ValueError, match=f"{sha}.*Duplicate"):
        build_history(repo, ref="HEAD")


def test_invalid_json_reports_commit_and_path(history):
    repo, commit = history
    commit([course()], "15")
    path = "data/courses/semesters/11510.json"
    (repo / path).write_text("{", encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "--quiet", "-m", "malformed JSON")
    sha = git(repo, "rev-parse", "HEAD")
    with pytest.raises(ValueError, match=f"{sha}:{path}"):
        build_history(repo, ref="HEAD")


def test_unrelated_raw_history_is_ignored(history):
    repo, commit = history
    commit(
        [{"科號": "11420CS 101000", "中文課名": "前一學期"}], "14", "data/courses.json"
    )
    commit(
        {"工作表1": [{"科號": "11510CS 101000", "中文課名": "程式設計", "人限": "40"}]},
        "15",
        "data/courses.json",
    )
    with pytest.raises(ValueError, match="No 11510 course observations"):
        build_history(repo, ref="HEAD")
    sha = commit([course()], "16")
    bundle = build_history(repo, ref="HEAD")
    assert len(bundle["snapshots"]) == 1
    assert bundle["snapshots"][0]["sha"] == sha
    assert bundle["snapshots"][0]["path"] == "data/courses/semesters/11510.json"


def test_missing_sources_fail_after_baseline(history):
    repo, commit = history
    commit([course()], "15")
    git(repo, "rm", "--quiet", "data/courses/semesters/11510.json")
    git(repo, "commit", "--quiet", "-m", "remove all course sources")
    with pytest.raises(ValueError, match="disappeared"):
        build_history(repo, ref="HEAD")


def test_boundary_timezone_and_compare():
    assert parse_boundary("2026-06-15") == datetime.fromisoformat(
        "2026-06-15T00:00:00+08:00"
    )
    assert parse_boundary("2026-06-15", end=True) == datetime.fromisoformat(
        "2026-06-16T00:00:00+08:00"
    )
    with pytest.raises(ValueError, match="timezone"):
        parse_boundary("2026-06-15T12:00:00")
    assert compare(
        {"a": {"id": "a", "size_limit": "", "size_limit_value": None}},
        {"a": {"id": "a", "size_limit": "0", "size_limit_value": 0}},
    ) == [{"id": "a", "kind": "changed", "fields": ["size_limit"]}]


def test_ref_and_semester_are_validated(history):
    repo, commit = history
    commit([course()], "15")
    with pytest.raises(ValueError, match="five"):
        build_history(repo, ref="HEAD", semester="../bad")
    with pytest.raises(ValueError, match="five"):
        build_history(repo, ref="HEAD", semester="１１５１０")
    with pytest.raises(ValueError, match="git .* failed"):
        build_history(repo, ref="--bad-ref")
    with pytest.raises(ValueError, match="Full Git history"):
        git(repo, "config", "core.repositoryformatversion", "0")
        # A real shallow clone supplies the Git shallow boundary, not a fake flag.
        (repo / ".git" / "shallow").write_text(git(repo, "rev-parse", "HEAD") + "\n")
        build_history(repo, ref="HEAD")
