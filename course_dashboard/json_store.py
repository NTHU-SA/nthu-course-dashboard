"""Preserve existing JSON on serialization, write, or replacement failure."""

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def write_json_atomic(
    data: Any,
    path: Path,
    *,
    ensure_ascii: bool = False,
    indent: int | None = 4,
    sort_keys: bool = False,
    ensure_dir: bool = True,
    trailing_newline: bool = False,
) -> None:
    if path.exists():
        with path.open(encoding="utf-8") as file:
            json.load(file)
    if ensure_dir:
        path.parent.mkdir(parents=True, exist_ok=True)

    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as file:
            temporary_path = Path(file.name)
            json.dump(
                data,
                file,
                ensure_ascii=ensure_ascii,
                indent=indent,
                sort_keys=sort_keys,
                allow_nan=False,
            )
            if trailing_newline:
                file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
