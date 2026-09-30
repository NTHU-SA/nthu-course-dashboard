import json

import pytest

from course_dashboard import json_store


def test_atomic_json_preserves_previous_on_failure(tmp_path, monkeypatch):
    output = tmp_path / "bundle.json"
    json_store.write_json_atomic({"value": "old"}, output)
    original = output.read_bytes()

    def fail_replace(*args):
        raise OSError("simulated replacement failure")

    monkeypatch.setattr(json_store.os, "replace", fail_replace)
    with pytest.raises(OSError, match="replacement failure"):
        json_store.write_json_atomic({"value": "new"}, output)
    assert output.read_bytes() == original
    assert list(tmp_path.iterdir()) == [output]


def test_atomic_json_rejects_corrupt_existing_and_invalid_data(tmp_path):
    output = tmp_path / "bundle.json"
    output.write_text("{", encoding="utf-8")
    with pytest.raises(json.JSONDecodeError):
        json_store.write_json_atomic({}, output)
    assert output.read_text() == "{"
    output.unlink()
    with pytest.raises(ValueError, match="JSON compliant"):
        json_store.write_json_atomic({"value": float("inf")}, output)
    assert not list(tmp_path.iterdir())
