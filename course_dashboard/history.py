"""Build reproducible course observations from a published Git branch."""

import hashlib
import json
import re
import subprocess
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

DAY_CODES = "MTWRFSU"
PERIOD_CODES = "01234n56789abcd"
SLOT_PATTERN = re.compile(r"([MTWRFSU])([0-9nabcd])")
NUMBER_FIELDS = ("credit", "size_limit", "freshman_reservation", "student_count")


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        encoding="utf-8",
        check=False,
    )
    if result.returncode:
        raise ValueError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def parse_boundary(value: str | None, *, end: bool = False) -> datetime | None:
    if value is None:
        return None
    # Date-only arguments describe Taipei calendar days.
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        result = datetime.fromisoformat(f"{value}T00:00:00+08:00")
        return result + timedelta(days=1) if end else result
    result = datetime.fromisoformat(value)
    if result.tzinfo is None:
        raise ValueError("Date-times require an explicit timezone offset")
    return result


def numeric(value: str, *, integer: bool) -> tuple[int | float | None, str]:
    if not value.strip():
        return None, "unknown"
    try:
        number = Decimal(value)
    except InvalidOperation:
        return None, "invalid"
    if not number.is_finite() or number < 0:
        return None, "invalid"
    if integer and (number != number.to_integral_value() or number > 2**53 - 1):
        return None, "invalid"
    if not integer and number > 2**53 - 1:
        return None, "invalid"
    return (int(number) if integer else float(number)), (
        "zero" if number == 0 else "positive"
    )


def normalize(rows: Any, semester: str) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        raise ValueError("Course snapshot must be a list")
    courses = []
    identities = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Course record must be an object")
        if any(not isinstance(value, str) for value in row.values()):
            raise ValueError("Normalized course fields must be strings")
        item = {key: value.strip() for key, value in row.items()}
        identity = item.get("id", "")
        if not identity.startswith(semester) or not identity[5:].strip():
            raise ValueError(f"Invalid {semester} course identity: {identity!r}")
        if not (item.get("chinese_title") or item.get("english_title")):
            raise ValueError(f"Course {identity!r} has no title")
        if identity in identities:
            raise ValueError(f"Duplicate course identity: {identity!r}")
        identities.add(identity)
        unit_match = re.fullmatch(r"[0-9]{5}\s*([A-Za-z]+)\s*[0-9]+", identity)
        item["unit"] = unit_match[1] if unit_match else "未辨識"
        issues = [] if unit_match else ["unit"]
        for field in NUMBER_FIELDS:
            number, state = numeric(item.get(field, ""), integer=field != "credit")
            item[f"{field}_value"] = number
            item[f"{field}_state"] = state
            if state == "invalid":
                issues.append(field)
        schedule = re.sub(r"\s+", "", item.get("time", ""))
        matches = SLOT_PATTERN.findall(schedule)
        if schedule and "".join(day + period for day, period in matches) != schedule:
            item["slots"] = []
            issues.append("time")
        else:
            item["slots"] = sorted({day + period for day, period in matches})
        item["issues"] = issues
        courses.append(item)
    return sorted(courses, key=lambda course: course["id"])


def canonical(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def compare(
    before: dict[str, dict[str, Any]], after: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    changes = []
    for identity in sorted(before.keys() | after.keys()):
        old, new = before.get(identity), after.get(identity)
        if old is None:
            changes.append({"id": identity, "kind": "added", "fields": []})
        elif new is None:
            changes.append({"id": identity, "kind": "removed", "fields": []})
        else:
            fields = [
                key
                for key in sorted(old.keys() | new.keys())
                if key not in {"unit", "slots", "issues"}
                and not key.endswith(("_value", "_state"))
                and old.get(key, "") != new.get(key, "")
            ]
            if fields:
                changes.append({"id": identity, "kind": "changed", "fields": fields})
    return changes


def summarize(courses: list[dict[str, Any]]) -> dict[str, Any]:
    capacity = [
        course["size_limit_value"]
        for course in courses
        if course["size_limit_state"] == "positive"
    ]
    return {
        "courses": len(courses),
        "capacity": sum(capacity),
        "capacity_known": len(capacity),
        "capacity_unknown": sum(c["size_limit_state"] == "unknown" for c in courses),
        "capacity_zero": sum(c["size_limit_state"] == "zero" for c in courses),
        "invalid_records": sum(bool(c["issues"]) for c in courses),
        "missing_time": sum(not c.get("time") for c in courses),
        "invalid_time": sum("time" in c["issues"] for c in courses),
    }


def build_history(
    repo: Path,
    *,
    ref: str = "origin/data",
    semester: str = "11510",
    since: str | None = None,
    until: str | None = None,
) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9]{5}", semester):
        raise ValueError("Semester must contain exactly five ASCII digits")
    if semester != "11510":
        raise ValueError("Only semester 11510 is supported")
    start, stop = parse_boundary(since), parse_boundary(until, end=True)
    if start and stop and start >= stop:
        raise ValueError("--since must precede --until")
    if git(repo, "rev-parse", "--is-shallow-repository").strip() == "true":
        raise ValueError("Full Git history required; fetch with --unshallow first")
    sha = git(
        repo, "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}"
    ).strip()
    current_path = f"courses/semesters/{semester}.json"
    old_path = f"data/{current_path}"
    paths = [current_path, old_path]
    entries = git(
        repo,
        "log",
        "--first-parent",
        "--reverse",
        "--format=%H|%cI",
        sha,
        "--",
        *paths,
    ).splitlines()
    observations = []
    previous_content = None
    seen_semester = False
    for entry in entries:
        commit, timestamp = entry.split("|")
        instant = datetime.fromisoformat(timestamp)
        if stop and instant >= stop:
            continue
        available = set(
            git(repo, "ls-tree", "-r", "--name-only", commit, "--", *paths).splitlines()
        )
        path = next((candidate for candidate in paths if candidate in available), None)
        if path is None:
            if seen_semester:
                raise ValueError(f"{commit}: all course sources disappeared")
            continue
        try:
            source = json.loads(git(repo, "show", f"{commit}:{path}"))
            courses = normalize(source, semester)
        except (ValueError, TypeError) as error:
            raise ValueError(f"{commit}:{path}: {error}") from error
        if not courses and not seen_semester:
            continue
        seen_semester = True
        content = canonical(courses)
        if content == previous_content:
            continue
        previous_content = content
        observations.append(
            {
                "sha": commit,
                "time": timestamp,
                "path": path,
                "fingerprint": hashlib.sha256(content.encode("utf-8")).hexdigest(),
                "courses": courses,
            }
        )
    if not observations:
        raise ValueError(f"No {semester} course observations in the requested history")
    if start:
        prior = [
            snapshot
            for snapshot in observations
            if datetime.fromisoformat(snapshot["time"]) < start
        ]
        selected = [
            snapshot
            for snapshot in observations
            if datetime.fromisoformat(snapshot["time"]) >= start
        ]
        observations = ([prior[-1]] if prior else []) + selected
    if not observations:
        raise ValueError("No observations in the requested period")
    versions: list[dict[str, Any]] = []
    version_index: dict[str, int] = {}
    snapshots = []
    previous = {}
    for observation in observations:
        courses = observation.pop("courses")
        indices = []
        current = {course["id"]: course for course in courses}
        for course in courses:
            key = canonical(course)
            if key not in version_index:
                version_index[key] = len(versions)
                versions.append(course)
            indices.append(version_index[key])
        snapshots.append(
            {
                **observation,
                "indices": indices,
                "summary": summarize(courses),
                "changes": compare(previous, current) if snapshots else [],
                "baseline": not snapshots,
            }
        )
        previous = current
    return {
        "schema_version": 1,
        "semester": semester,
        "ref": ref,
        "source_sha": sha,
        "generated_at": datetime.now(UTC).isoformat(),
        "since": since,
        "until": until,
        "days": list(DAY_CODES),
        "periods": list(PERIOD_CODES),
        "versions": versions,
        "snapshots": snapshots,
    }
