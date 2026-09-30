"""Generate the standalone course dashboard from external published Git history."""

import argparse
import hashlib
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path

from course_dashboard.history import build_history, canonical, git
from course_dashboard.json_store import write_json_atomic

LOGGER = logging.getLogger(__name__)
ASSETS = Path(__file__).resolve().parent / "dashboard"
MARKER = ".course-dashboard"


def publish(bundle: dict, output: Path, *, assets: Path = ASSETS) -> None:
    if output.is_symlink() or (
        output.exists() and (not output.is_dir() or not (output / MARKER).is_file())
    ):
        raise ValueError(f"Refusing to replace an unowned output directory: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".course-dashboard-stage-", dir=output.parent))
    backup = None
    published = False
    try:
        filename = (
            f"courses-{hashlib.sha256(canonical(bundle).encode()).hexdigest()}.json"
        )
        write_json_atomic(bundle, stage / filename, indent=None)
        for name in ("index.html", "styles.css", "app.js"):
            shutil.copyfile(assets / name, stage / name)
        write_json_atomic({"file": filename}, stage / "manifest.json")
        (stage / MARKER).write_text("Generated course dashboard\n", encoding="utf-8")
        if json.loads((stage / filename).read_text(encoding="utf-8")) != bundle:
            raise ValueError("Dashboard JSON failed round-trip validation")
        if output.exists():
            backup = Path(
                tempfile.mkdtemp(prefix=".course-dashboard-backup-", dir=output.parent)
            )
            backup.rmdir()
            os.replace(output, backup)
        try:
            os.replace(stage, output)
        except OSError:
            if backup is not None:
                try:
                    os.replace(backup, output)
                except OSError as error:
                    raise OSError(
                        f"Rollback failed; previous dashboard retained at {backup}"
                    ) from error
                backup = None
            raise
        published = True
    finally:
        if stage.exists():
            shutil.rmtree(stage)
        if backup is not None and published:
            shutil.rmtree(backup)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-dir",
        type=Path,
        required=True,
        help="External full-history checkout of NTHU-SA/NTHU-Data-Scraper's data ref",
    )
    parser.add_argument("--ref", default="origin/data")
    parser.add_argument("--semester", choices=["11510"], default="11510")
    parser.add_argument("--since", help="Taipei date or timezone-aware ISO datetime")
    parser.add_argument(
        "--until", help="Inclusive Taipei date or exclusive ISO datetime"
    )
    parser.add_argument("--output", type=Path, default=Path("site"))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    try:
        repo = args.source_dir.resolve()
        source_root = Path(git(repo, "rev-parse", "--show-toplevel").strip()).resolve()
        if source_root == Path(__file__).resolve().parent:
            raise ValueError("--source-dir must be an external source repository")
        if args.output.is_symlink():
            raise ValueError("--output must not be a symlink")
        output = args.output.resolve()
        if output == source_root or source_root.is_relative_to(output):
            raise ValueError("--output must not replace the source repository")
        if output.is_relative_to(source_root):
            raise ValueError("--output must be outside the source repository")
        bundle = build_history(
            repo,
            ref=args.ref,
            semester=args.semester,
            since=args.since,
            until=args.until,
        )
        publish(bundle, output)
        LOGGER.info(
            "Generated %s: %s snapshots, %s latest courses",
            output,
            len(bundle["snapshots"]),
            bundle["snapshots"][-1]["summary"]["courses"],
        )
    except (ValueError, OSError) as error:
        LOGGER.error("Dashboard generation failed: %s", error)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
