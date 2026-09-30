import json
import subprocess

import pytest

import generate_course_dashboard as generator


def test_generated_output_replacement_and_roundtrip(tmp_path):
    output = tmp_path / "dashboard"
    bundle = {"schema_version": 1, "semester": "11510", "snapshots": [], "versions": []}
    generator.publish(bundle, output)
    manifest = json.loads((output / "manifest.json").read_text())
    assert json.loads((output / manifest["file"]).read_text(encoding="utf-8")) == bundle
    assert (output / "index.html").is_file()
    assert (output / "app.js").is_file()
    old_name = manifest["file"]
    bundle["semester"] = "11520"
    generator.publish(bundle, output)
    new_manifest = json.loads((output / "manifest.json").read_text())
    assert old_name != new_manifest["file"]
    assert not (output / old_name).exists()
    assert len(list(tmp_path.iterdir())) == 1


def test_unowned_output_is_not_deleted(tmp_path):
    output = tmp_path / "dashboard"
    output.mkdir()
    (output / "user.txt").write_text("keep")
    with pytest.raises(ValueError, match="unowned"):
        generator.publish({}, output)
    assert (output / "user.txt").read_text() == "keep"


def test_missing_assets_leave_old_output(tmp_path):
    output = tmp_path / "dashboard"
    generator.publish({"value": "old"}, output)
    original = (output / "manifest.json").read_bytes()
    with pytest.raises(FileNotFoundError):
        generator.publish({"value": "new"}, output, assets=tmp_path / "missing")
    assert (output / "manifest.json").read_bytes() == original
    assert len(list(tmp_path.iterdir())) == 1


def test_failed_publish_rolls_back(tmp_path, monkeypatch):
    output = tmp_path / "dashboard"
    generator.publish({"value": "old"}, output)
    original = (output / "manifest.json").read_bytes()
    replace = generator.os.replace

    def fail_stage(source, destination):
        if source.name.startswith(".course-dashboard-stage-") and destination == output:
            raise OSError("simulated publication failure")
        replace(source, destination)

    monkeypatch.setattr(generator.os, "replace", fail_stage)
    with pytest.raises(OSError, match="publication failure"):
        generator.publish({"value": "new"}, output)
    assert (output / "manifest.json").read_bytes() == original
    assert len(list(tmp_path.iterdir())) == 1


def test_failed_rollback_retains_recovery_directory(tmp_path, monkeypatch):
    output = tmp_path / "dashboard"
    generator.publish({"value": "old"}, output)
    original = (output / "manifest.json").read_bytes()
    replace = generator.os.replace

    def fail_publication_and_restore(source, destination):
        if destination == output:
            raise OSError("simulated replacement failure")
        replace(source, destination)

    monkeypatch.setattr(generator.os, "replace", fail_publication_and_restore)
    with pytest.raises(OSError, match="previous dashboard retained"):
        generator.publish({"value": "new"}, output)
    backups = list(tmp_path.glob(".course-dashboard-backup-*"))
    assert len(backups) == 1
    assert (backups[0] / "manifest.json").read_bytes() == original


def test_cli_errors_are_visible_and_do_not_write(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(
        "sys.argv",
        [
            "generate_course_dashboard.py",
            "--source-dir",
            str(generator.ASSETS.parent),
            "--output",
            str(tmp_path),
        ],
    )
    assert generator.main() == 1
    assert "external source repository" in caplog.text
    assert not list(tmp_path.iterdir())


def test_cli_uses_external_source_and_rejects_source_output(
    tmp_path, monkeypatch, caplog
):
    source = tmp_path / "source"
    source.mkdir()
    subprocess.run(["git", "init", "--quiet", str(source)], check=True)
    bundle = {"snapshots": [{"summary": {"courses": 1}}]}
    calls = []

    def build(repo, **kwargs):
        calls.append((repo, kwargs))
        return bundle

    monkeypatch.setattr(generator, "build_history", build)
    output = tmp_path / "site"
    monkeypatch.setattr(
        "sys.argv",
        [
            "generate_course_dashboard.py",
            "--source-dir",
            str(source),
            "--ref",
            "origin/data",
            "--output",
            str(output),
        ],
    )
    assert generator.main() == 0
    assert calls[0][0] == source.resolve()
    assert calls[0][1]["ref"] == "origin/data"
    assert (output / "manifest.json").is_file()
    calls.clear()
    monkeypatch.setattr(
        "sys.argv",
        [
            "generate_course_dashboard.py",
            "--source-dir",
            str(source),
            "--output",
            str(source / "site"),
        ],
    )
    assert generator.main() == 1
    assert "outside the source repository" in caplog.text
    assert not calls
    assert not (source / "site").exists()


def test_serialization_failure_keeps_previous_site(tmp_path):
    output = tmp_path / "site"
    generator.publish({"value": "old"}, output)
    original = (output / "manifest.json").read_bytes()
    with pytest.raises(ValueError, match="JSON compliant"):
        generator.publish({"value": float("nan")}, output)
    assert (output / "manifest.json").read_bytes() == original
    assert len(list(tmp_path.iterdir())) == 1
