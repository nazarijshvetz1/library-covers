#!/usr/bin/env python3
"""Safely import one base64-encoded cover photo submitted by the private site."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image

from import_cover import CoverError, convert_to_jpeg, final_url_for, utc_now


MAX_DECODED_BYTES = 10 * 1024 * 1024
MAX_BASE64_BYTES = 14 * 1024 * 1024
IMPORT_NAME_RE = re.compile(
    r"^(CAT-\d{4,})--"
    r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-"
    r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})--"
    r"(ow[01])\.jpg\.b64$"
)


class SitePhotoError(Exception):
    """Expected, safely recordable site-photo failure."""

    def __init__(self, status_code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


@dataclass(frozen=True)
class SitePhotoRequest:
    input_path: Path
    relative_path: str
    cat_id: str
    request_id: str
    overwrite: bool


def _safe_repo_directory(
    repo_root: Path,
    parts: tuple[str, ...],
    *,
    create: bool,
) -> Path:
    """Walk a fixed repository path without following symlinked directories."""

    current = repo_root
    for part in parts:
        current = current / part
        try:
            current_stat = current.lstat()
        except FileNotFoundError:
            if not create:
                raise SitePhotoError(
                    "invalid_import_path",
                    "Не знайдено дозволену папку імпорту",
                )
            try:
                current.mkdir()
            except OSError as exc:
                raise SitePhotoError(
                    "unsafe_repository_path",
                    "Не вдалося створити безпечну службову папку",
                ) from exc
            continue
        except OSError as exc:
            raise SitePhotoError(
                "unsafe_repository_path",
                "Не вдалося перевірити службову папку",
            ) from exc
        if stat.S_ISLNK(current_stat.st_mode) or not stat.S_ISDIR(current_stat.st_mode):
            raise SitePhotoError(
                "unsafe_repository_path",
                "Службова папка не може бути файлом або symlink",
            )
    return current


def _canonical_uuid(value: str) -> str:
    import uuid

    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise SitePhotoError(
            "invalid_request_id", "Некоректний request_id у назві файла"
        ) from exc


def parse_site_import_path(repo_root: Path, input_path: Path) -> SitePhotoRequest:
    """Validate that input is one regular file directly inside imports/site."""

    root = repo_root.resolve()
    expected_parent = _safe_repo_directory(root, ("imports", "site"), create=False)
    if ".." in input_path.parts:
        raise SitePhotoError("invalid_import_path", "Шлях імпорту не може містити ..")
    candidate = input_path if input_path.is_absolute() else root / input_path

    try:
        candidate_parent = candidate.parent.resolve()
    except OSError as exc:
        raise SitePhotoError(
            "invalid_import_path", "Не вдалося перевірити шлях імпорту"
        ) from exc
    if candidate_parent != expected_parent:
        raise SitePhotoError(
            "invalid_import_path",
            "Файл має бути безпосередньо в imports/site",
        )

    try:
        file_stat = candidate.lstat()
    except FileNotFoundError as exc:
        raise SitePhotoError("import_not_found", "Файл імпорту не знайдено") from exc
    except OSError as exc:
        raise SitePhotoError(
            "invalid_import_path", "Не вдалося прочитати файл імпорту"
        ) from exc
    if candidate.is_symlink() or not stat.S_ISREG(file_stat.st_mode):
        raise SitePhotoError(
            "invalid_import_path", "Файл імпорту має бути звичайним файлом"
        )

    match = IMPORT_NAME_RE.fullmatch(candidate.name)
    if not match:
        raise SitePhotoError(
            "invalid_import_name",
            "Назва має формат CAT-XXXX--UUID--ow0.jpg.b64 або CAT-XXXX--UUID--ow1.jpg.b64",
        )

    cat_id, raw_request_id, overwrite_marker = match.groups()
    request_id = _canonical_uuid(raw_request_id)
    relative_path = candidate.relative_to(root).as_posix()
    return SitePhotoRequest(
        input_path=candidate,
        relative_path=relative_path,
        cat_id=cat_id,
        request_id=request_id,
        overwrite=overwrite_marker == "ow1",
    )


def decode_site_photo(path: Path) -> bytes:
    """Decode strict base64 after bounding both encoded and decoded sizes."""

    size = path.stat().st_size
    if size <= 0:
        raise SitePhotoError("invalid_base64", "Файл base64 порожній")
    if size > MAX_BASE64_BYTES:
        raise SitePhotoError("file_too_large", "Закодований файл перевищує 14 МБ")

    encoded = path.read_bytes()
    try:
        compact = b"".join(encoded.split())
        if not compact or len(compact) > 4 * ((MAX_DECODED_BYTES + 2) // 3):
            raise SitePhotoError("file_too_large", "Фотографія перевищує 10 МБ")
        decoded = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise SitePhotoError(
            "invalid_base64", "Файл містить некоректні дані base64"
        ) from exc

    if not decoded:
        raise SitePhotoError("invalid_base64", "Файл base64 не містить фотографії")
    if len(decoded) > MAX_DECODED_BYTES:
        raise SitePhotoError("file_too_large", "Фотографія перевищує 10 МБ")
    return decoded


def _atomic_write(path: Path, content: bytes) -> None:
    if not path.parent.is_dir():
        raise OSError("Target directory is unavailable")
    temp_name = ""
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
            temp_name = handle.name
        os.replace(temp_name, path)
    finally:
        if temp_name:
            try:
                Path(temp_name).unlink(missing_ok=True)
            except OSError:
                pass


def _write_status(repo_root: Path, request_id: str, payload: dict[str, Any]) -> None:
    status_dir = _safe_repo_directory(
        repo_root,
        ("cover-status", "requests"),
        create=True,
    )
    status_path = status_dir / f"{request_id}.json"
    content = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    _atomic_write(status_path, content)


def _read_existing_status(
    repo_root: Path,
    request: SitePhotoRequest,
) -> dict[str, Any] | None:
    """Return an exact prior result or reject reuse of its request_id."""

    status_dir = _safe_repo_directory(
        repo_root,
        ("cover-status", "requests"),
        create=True,
    )
    status_path = status_dir / f"{request.request_id}.json"
    if not status_path.exists():
        return None
    try:
        status_stat = status_path.lstat()
        if status_path.is_symlink() or not stat.S_ISREG(status_stat.st_mode):
            raise ValueError("status is not a regular file")
        if status_stat.st_size <= 0 or status_stat.st_size > 64 * 1024:
            raise ValueError("status size is invalid")
        value = json.loads(status_path.read_text("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise SitePhotoError(
            "request_id_conflict",
            "Для цього request_id уже існує неперевірений результат",
        ) from exc

    matches = (
        isinstance(value, dict)
        and value.get("source") == "site_photo"
        and value.get("request_id") == request.request_id
        and value.get("cat_id") == request.cat_id
        and value.get("import_path") == request.relative_path
        and value.get("overwrite") is request.overwrite
        and isinstance(value.get("success"), bool)
        and isinstance(value.get("status"), str)
    )
    if not matches:
        raise SitePhotoError(
            "request_id_conflict",
            "Цей request_id уже використано для іншого імпорту",
        )
    if value.get("success") is True:
        expected_hash = value.get("output_sha256")
        try:
            covers_dir = _safe_repo_directory(repo_root, ("covers",), create=False)
            cover_path = covers_dir / f"{request.cat_id}.jpg"
            current_hash = hashlib.sha256(cover_path.read_bytes()).hexdigest()
        except (OSError, SitePhotoError) as exc:
            raise SitePhotoError(
                "request_id_conflict",
                "Збережений успіх не відповідає поточній обкладинці",
            ) from exc
        if not isinstance(expected_hash, str) or current_hash != expected_hash:
            raise SitePhotoError(
                "request_id_conflict",
                "Збережений успіх не відповідає поточній обкладинці",
            )
    return value


def build_site_status(
    request: SitePhotoRequest,
    *,
    success: bool,
    status_code: str,
    message: str,
    final_url: str = "",
    output_sha256: str = "",
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "cat_id": request.cat_id,
        "request_id": request.request_id,
        "success": success,
        "status": status_code,
        "message": message,
        "source": "site_photo",
        "source_url": "",
        "import_path": request.relative_path,
        "overwrite": request.overwrite,
        "mode": "commit",
        "dry_run": False,
        "updated_at": utc_now(),
    }
    if final_url:
        result["final_url"] = final_url
    if output_sha256:
        result["output_sha256"] = output_sha256
    return result


def process_site_photo(repo_root: Path, request: SitePhotoRequest) -> dict[str, Any]:
    decoded = decode_site_photo(request.input_path)
    try:
        jpeg = convert_to_jpeg(decoded)
    except CoverError as exc:
        if isinstance(exc.__cause__, Image.DecompressionBombError):
            raise SitePhotoError(
                "file_too_large", "Зображення має надто багато пікселів"
            ) from exc
        raise SitePhotoError(exc.status, exc.message) from exc
    except Image.DecompressionBombWarning as exc:
        raise SitePhotoError(
            "file_too_large", "Зображення має надто багато пікселів"
        ) from exc

    output_sha256 = hashlib.sha256(jpeg).hexdigest()
    covers_dir = _safe_repo_directory(repo_root, ("covers",), create=True)
    cover_path = covers_dir / f"{request.cat_id}.jpg"
    final_url = final_url_for(request.cat_id)

    if cover_path.is_symlink() or (cover_path.exists() and not cover_path.is_file()):
        raise SitePhotoError(
            "unsafe_repository_path",
            "Ціль обкладинки не є звичайним файлом",
        )
    if cover_path.exists() and not request.overwrite:
        try:
            existing = cover_path.read_bytes()
        except OSError as exc:
            raise SitePhotoError(
                "cover_unavailable", "Не вдалося перевірити наявну обкладинку"
            ) from exc
        if existing == jpeg:
            return build_site_status(
                request,
                success=True,
                status_code="already_applied",
                message="Ця фотографія вже збережена; повторний файл не створено",
                final_url=final_url,
                output_sha256=output_sha256,
            )
        raise SitePhotoError(
            "already_exists",
            "Обкладинка вже існує; для свідомої заміни використайте ow1",
        )

    _atomic_write(cover_path, jpeg)
    return build_site_status(
        request,
        success=True,
        status_code="completed",
        message="Фотографію обкладинки додано",
        final_url=final_url,
        output_sha256=output_sha256,
    )


def run_site_import(*, repo_root: Path, input_path: Path) -> dict[str, Any]:
    """Process one validated request, persist its result, then consume the import file."""

    root = repo_root.resolve()
    request = parse_site_import_path(root, input_path)
    existing_result = _read_existing_status(root, request)
    if existing_result is not None:
        request.input_path.unlink()
        return existing_result
    try:
        result = process_site_photo(root, request)
    except SitePhotoError as exc:
        result = build_site_status(
            request,
            success=False,
            status_code=exc.status_code,
            message=exc.message,
        )

    # Persist the result first. If this fails, the import remains available for a retry.
    _write_status(root, request.request_id, result)
    request.input_path.unlink()
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = run_site_import(repo_root=args.repo_root, input_path=args.input)
    except SitePhotoError as exc:
        print(
            json.dumps(
                {"success": False, "status": exc.status_code, "message": exc.message},
                ensure_ascii=False,
            )
        )
        return 2
    except OSError as exc:
        print(
            json.dumps(
                {"success": False, "status": "io_error", "message": str(exc)},
                ensure_ascii=False,
            )
        )
        return 2

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
