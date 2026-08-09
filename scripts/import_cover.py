#!/usr/bin/env python3
"""Safely discover, validate, normalize, and store a library cover image."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import socket
import sys
import tempfile
import uuid
import warnings
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from PIL import Image, ImageOps, UnidentifiedImageError


CAT_ID_RE = re.compile(r"^CAT-\d{4,}$")
REDIRECT_CODES = {301, 302, 303, 307, 308}
MAX_REDIRECTS = 5
MAX_HTML_BYTES = 2 * 1024 * 1024
MAX_IMAGE_BYTES = 15 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_SIZE = (600, 900)
USER_AGENT = (
    "LibraryCoverImporter/1.0 (+https://github.com/nazarijshvetz1/library-covers)"
)
REQUEST_FINGERPRINT_VERSION = 1
MAX_STATUS_BYTES = 128 * 1024
RAW_BASE_URL = (
    "https://raw.githubusercontent.com/nazarijshvetz1/library-covers/main/covers"
)

Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


class CoverError(Exception):
    """Expected processing failure with a stable machine-readable status."""

    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class FetchedResource:
    url: str
    content_type: str
    body: bytes


Fetcher = Callable[[str], FetchedResource]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def normalize_request_parameters(
    *,
    cat_id: str,
    source_url: str,
    mode: str,
    overwrite: bool,
    dry_run: bool,
) -> dict[str, Any]:
    """Return the canonical behavior-affecting fields for one request."""

    return {
        "cat_id": str(cat_id or "").strip().upper(),
        "source_url": str(source_url or "").strip(),
        "mode": str(mode or "").strip(),
        "overwrite": bool(overwrite),
        "dry_run": bool(dry_run),
    }


def request_fingerprint(
    *,
    cat_id: str,
    source_url: str,
    mode: str,
    overwrite: bool,
    dry_run: bool,
) -> str:
    """Create a stable fingerprint for request-id idempotency checks."""

    parameters = normalize_request_parameters(
        cat_id=cat_id,
        source_url=source_url,
        mode=mode,
        overwrite=overwrite,
        dry_run=dry_run,
    )
    canonical = json.dumps(
        {
            "version": REQUEST_FINGERPRINT_VERSION,
            **parameters,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def validate_cat_id(cat_id: str, *, required: bool) -> str:
    cat_id = (cat_id or "").strip().upper()
    if not cat_id and not required:
        return ""
    if not CAT_ID_RE.fullmatch(cat_id):
        raise CoverError("invalid_cat_id", "Некоректний CAT-ID")
    return cat_id


def validate_request_id(request_id: str) -> str:
    try:
        return str(uuid.UUID(str(request_id)))
    except (ValueError, TypeError, AttributeError) as exc:
        raise CoverError("invalid_request_id", "Некоректний request_id") from exc


def _iter_resolved_ips(
    hostname: str,
    port: int,
    resolver: Callable[..., Iterable[tuple[Any, ...]]] = socket.getaddrinfo,
) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        records = resolver(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise CoverError(
            "url_unavailable", "Не вдалося визначити адресу сайту"
        ) from exc

    addresses: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for record in records:
        raw = record[4][0]
        try:
            address = ipaddress.ip_address(raw.split("%", 1)[0])
        except ValueError as exc:
            raise CoverError(
                "unsafe_url", "Сайт повернув некоректну IP-адресу"
            ) from exc
        addresses.append(address)
    if not addresses:
        raise CoverError("url_unavailable", "Для сайту не знайдено IP-адресу")
    return addresses


def validate_public_url(
    url: str,
    *,
    resolver: Callable[..., Iterable[tuple[Any, ...]]] = socket.getaddrinfo,
) -> str:
    url = (url or "").strip()
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError as exc:
        raise CoverError("invalid_url", "Некоректне посилання") from exc

    if parsed.scheme.lower() not in {"http", "https"}:
        raise CoverError("invalid_url", "Підтримуються лише HTTP та HTTPS посилання")
    if not parsed.hostname:
        raise CoverError("invalid_url", "У посиланні відсутня адреса сайту")
    if parsed.username or parsed.password:
        raise CoverError(
            "unsafe_url", "Посилання з логіном або паролем не підтримуються"
        )

    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise CoverError("unsafe_url", "Локальні адреси заборонені")
    effective_port = port or (443 if parsed.scheme.lower() == "https" else 80)
    if effective_port not in {80, 443}:
        raise CoverError("unsafe_url", "Дозволені лише стандартні HTTP/HTTPS порти")

    try:
        literal_ip = ipaddress.ip_address(hostname.split("%", 1)[0])
        addresses = [literal_ip]
    except ValueError:
        addresses = _iter_resolved_ips(hostname, effective_port, resolver)

    if any(not address.is_global for address in addresses):
        raise CoverError(
            "unsafe_url", "Приватні, локальні та службові адреси заборонені"
        )
    return url


def _read_limited(response: requests.Response, limit: int) -> bytes:
    content_length = response.headers.get("Content-Length")
    if content_length:
        try:
            if int(content_length) > limit:
                raise CoverError("file_too_large", "Файл перевищує дозволений розмір")
        except ValueError:
            pass

    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_content(chunk_size=64 * 1024):
        if not chunk:
            continue
        total += len(chunk)
        if total > limit:
            raise CoverError("file_too_large", "Файл перевищує дозволений розмір")
        chunks.append(chunk)
    return b"".join(chunks)


def fetch_resource(
    source_url: str,
    *,
    session_factory: Callable[[], requests.Session] = requests.Session,
    resolver: Callable[..., Iterable[tuple[Any, ...]]] = socket.getaddrinfo,
) -> FetchedResource:
    current_url = validate_public_url(source_url, resolver=resolver)
    session = session_factory()
    session.trust_env = False
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "image/avif,image/webp,image/png,image/jpeg,text/html;q=0.8,*/*;q=0.5",
    }

    try:
        for redirect_count in range(MAX_REDIRECTS + 1):
            validate_public_url(current_url, resolver=resolver)
            try:
                response = session.get(
                    current_url,
                    headers=headers,
                    allow_redirects=False,
                    stream=True,
                    timeout=(10, 20),
                )
            except requests.RequestException as exc:
                raise CoverError("url_unavailable", "Посилання недоступне") from exc

            with response:
                if response.status_code in REDIRECT_CODES:
                    if redirect_count >= MAX_REDIRECTS:
                        raise CoverError("too_many_redirects", "Забагато переадресацій")
                    location = response.headers.get("Location")
                    if not location:
                        raise CoverError("url_unavailable", "Переадресація без адреси")
                    current_url = validate_public_url(
                        urljoin(current_url, location), resolver=resolver
                    )
                    continue
                if response.status_code >= 400:
                    raise CoverError(
                        "url_unavailable",
                        f"Посилання повернуло HTTP {response.status_code}",
                    )

                content_type = response.headers.get("Content-Type", "")
                content_type = content_type.split(";", 1)[0].strip().lower()
                if content_type.startswith("image/"):
                    limit = MAX_IMAGE_BYTES
                elif content_type in {"text/html", "application/xhtml+xml", ""}:
                    limit = MAX_HTML_BYTES
                else:
                    raise CoverError(
                        "unsupported_format", "Непідтримуваний формат відповіді"
                    )
                body = _read_limited(response, limit)
                return FetchedResource(response.url or current_url, content_type, body)
    finally:
        session.close()

    raise CoverError("url_unavailable", "Не вдалося завантажити посилання")


def _json_ld_images(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        image = value.get("image")
        if isinstance(image, str):
            yield image
        elif isinstance(image, list):
            for item in image:
                if isinstance(item, str):
                    yield item
                elif isinstance(item, dict):
                    candidate = item.get("url") or item.get("contentUrl")
                    if isinstance(candidate, str):
                        yield candidate
        elif isinstance(image, dict):
            candidate = image.get("url") or image.get("contentUrl")
            if isinstance(candidate, str):
                yield candidate
        for nested in value.values():
            yield from _json_ld_images(nested)
    elif isinstance(value, list):
        for item in value:
            yield from _json_ld_images(item)


def discover_image_url(page_url: str, html: bytes) -> str:
    soup = BeautifulSoup(html, "html.parser")
    candidates: list[str] = []

    selectors = [
        ("meta", {"property": re.compile(r"^og:image$", re.I)}, "content"),
        ("meta", {"name": re.compile(r"^twitter:image(?::src)?$", re.I)}, "content"),
        ("link", {"rel": re.compile(r"image_src", re.I)}, "href"),
    ]
    for tag_name, attrs, attribute in selectors:
        for element in soup.find_all(tag_name, attrs=attrs):
            candidate = element.get(attribute)
            if isinstance(candidate, str) and candidate.strip():
                candidates.append(candidate.strip())

    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            payload = json.loads(script.string or script.get_text() or "")
        except (json.JSONDecodeError, TypeError):
            continue
        candidates.extend(_json_ld_images(payload))

    for candidate in candidates:
        absolute = urljoin(page_url, candidate)
        if urlparse(absolute).scheme.lower() in {"http", "https"}:
            return absolute
    raise CoverError("image_not_found", "На сторінці не знайдено обкладинку")


def find_cover(
    source_url: str,
    *,
    fetcher: Fetcher = fetch_resource,
) -> tuple[str, bytes]:
    source = fetcher(source_url)
    if source.content_type.startswith("image/"):
        return source.url, source.body
    if source.content_type not in {"text/html", "application/xhtml+xml", ""}:
        raise CoverError(
            "unsupported_format", "Посилання не містить HTML або зображення"
        )

    image_url = discover_image_url(source.url, source.body)
    image = fetcher(image_url)
    if not image.content_type.startswith("image/"):
        raise CoverError(
            "unsupported_format", "Знайдене посилання не повернуло зображення"
        )
    return image.url, image.body


def convert_to_jpeg(image_bytes: bytes) -> bytes:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(image_bytes)) as source:
                source.verify()
            with Image.open(BytesIO(image_bytes)) as source:
                image = ImageOps.exif_transpose(source)
                if image.width * image.height > MAX_IMAGE_PIXELS:
                    raise CoverError(
                        "file_too_large", "Зображення має надто багато пікселів"
                    )
                if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
                    rgba = image.convert("RGBA")
                    background = Image.new("RGB", rgba.size, "white")
                    background.paste(rgba, mask=rgba.getchannel("A"))
                    image = background
                else:
                    image = image.convert("RGB")
                image.thumbnail(MAX_SIZE, Image.Resampling.LANCZOS)
                output = BytesIO()
                image.save(
                    output,
                    "JPEG",
                    quality=82,
                    optimize=True,
                    progressive=True,
                )
                return output.getvalue()
    except CoverError:
        raise
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        Image.DecompressionBombError,
    ) as exc:
        raise CoverError(
            "unsupported_format", "Файл не є підтримуваним зображенням"
        ) from exc


def final_url_for(cat_id: str) -> str:
    return f"{RAW_BASE_URL}/{cat_id}.jpg"


def _atomic_write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        handle.write(content)
        temp_name = handle.name
    os.replace(temp_name, path)


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    content = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    _atomic_write_bytes(path, content)


def _request_status_path(repo_root: Path, request_id: str) -> Path:
    return repo_root / "cover-status" / "requests" / f"{request_id}.json"


def read_existing_request_status(
    repo_root: Path,
    *,
    request_id: str,
    cat_id: str,
    source_url: str,
    mode: str,
    overwrite: bool,
    dry_run: bool,
) -> dict[str, Any] | None:
    """Return an exact prior result or reject reuse of its request_id."""

    request_path = _request_status_path(repo_root, request_id)
    if not request_path.exists() and not request_path.is_symlink():
        return None

    conflict = CoverError(
        "request_id_conflict",
        "Цей request_id уже використано для іншого запиту",
    )
    try:
        if request_path.is_symlink() or not request_path.is_file():
            raise conflict
        size = request_path.stat().st_size
        if size <= 0 or size > MAX_STATUS_BYTES:
            raise conflict
        stored = json.loads(request_path.read_text("utf-8"))
    except CoverError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise conflict from exc

    if not isinstance(stored, dict):
        raise conflict
    if stored.get("request_id") != request_id:
        raise conflict
    if not isinstance(stored.get("success"), bool):
        raise conflict
    if not isinstance(stored.get("status"), str):
        raise conflict
    if stored.get("fingerprint_version") != REQUEST_FINGERPRINT_VERSION:
        raise conflict
    if not isinstance(stored.get("overwrite"), bool):
        raise conflict
    if not isinstance(stored.get("dry_run"), bool):
        raise conflict
    if not all(
        isinstance(stored.get(field), str)
        for field in ("cat_id", "source_url", "mode", "request_fingerprint")
    ):
        raise conflict

    stored_fingerprint = request_fingerprint(
        cat_id=stored["cat_id"],
        source_url=stored["source_url"],
        mode=stored["mode"],
        overwrite=stored["overwrite"],
        dry_run=stored["dry_run"],
    )
    expected_fingerprint = request_fingerprint(
        cat_id=cat_id,
        source_url=source_url,
        mode=mode,
        overwrite=overwrite,
        dry_run=dry_run,
    )
    if stored["request_fingerprint"] != stored_fingerprint:
        raise conflict
    if stored_fingerprint != expected_fingerprint:
        raise conflict
    return stored


def write_status_files(repo_root: Path, payload: dict[str, Any], mode: str) -> None:
    request_id = validate_request_id(payload["request_id"])
    request_path = _request_status_path(repo_root, request_id)
    _atomic_write_json(request_path, payload)
    cat_id = payload.get("cat_id") or ""
    if mode == "commit" and CAT_ID_RE.fullmatch(cat_id):
        _atomic_write_json(repo_root / "cover-status" / f"{cat_id}.json", payload)


def build_status(
    *,
    cat_id: str,
    request_id: str,
    source_url: str,
    success: bool,
    status: str,
    message: str,
    image_source_url: str = "",
    final_url: str = "",
    mode: str,
    overwrite: bool,
    dry_run: bool,
) -> dict[str, Any]:
    parameters = normalize_request_parameters(
        cat_id=cat_id,
        source_url=source_url,
        mode=mode,
        overwrite=overwrite,
        dry_run=dry_run,
    )
    payload: dict[str, Any] = {
        "cat_id": parameters["cat_id"],
        "request_id": request_id,
        "success": success,
        "status": status,
        "message": message,
        "source_url": parameters["source_url"],
        "updated_at": utc_now(),
        "mode": parameters["mode"],
        "overwrite": parameters["overwrite"],
        "dry_run": parameters["dry_run"],
        "fingerprint_version": REQUEST_FINGERPRINT_VERSION,
        "request_fingerprint": request_fingerprint(**parameters),
    }
    if image_source_url:
        payload["image_source_url"] = image_source_url
    if final_url:
        payload["final_url"] = final_url
    return payload


def process_request(
    *,
    repo_root: Path,
    cat_id: str,
    source_url: str,
    request_id: str,
    mode: str,
    overwrite: bool,
    dry_run: bool,
    fetcher: Fetcher = fetch_resource,
) -> dict[str, Any]:
    request_id = validate_request_id(request_id)
    if mode not in {"preview", "commit"}:
        raise CoverError("invalid_mode", "Непідтримуваний режим обробки")
    cat_id = validate_cat_id(cat_id, required=(mode == "commit"))
    validate_public_url(source_url)

    image_source_url, original = find_cover(source_url, fetcher=fetcher)
    jpeg = convert_to_jpeg(original)
    final_url = final_url_for(cat_id) if cat_id else ""

    if mode == "preview":
        return build_status(
            cat_id=cat_id,
            request_id=request_id,
            source_url=source_url,
            success=True,
            status="preview_ready",
            message="Обкладинку знайдено — перевірте та підтвердьте",
            image_source_url=image_source_url,
            mode=mode,
            overwrite=overwrite,
            dry_run=dry_run,
        )

    cover_path = repo_root / "covers" / f"{cat_id}.jpg"
    if cover_path.exists() and not overwrite:
        return build_status(
            cat_id=cat_id,
            request_id=request_id,
            source_url=source_url,
            success=True,
            status="already_exists",
            message="Файл уже існує",
            image_source_url=image_source_url,
            final_url=final_url,
            mode=mode,
            overwrite=overwrite,
            dry_run=dry_run,
        )

    if not dry_run:
        _atomic_write_bytes(cover_path, jpeg)
    return build_status(
        cat_id=cat_id,
        request_id=request_id,
        source_url=source_url,
        success=True,
        status="dry_run_completed" if dry_run else "completed",
        message="Dry run завершено" if dry_run else "Обкладинку додано",
        image_source_url=image_source_url,
        final_url=final_url,
        mode=mode,
        overwrite=overwrite,
        dry_run=dry_run,
    )


def run_and_record(
    *,
    repo_root: Path,
    cat_id: str,
    source_url: str,
    request_id: str,
    mode: str,
    overwrite: bool,
    dry_run: bool,
    fetcher: Fetcher = fetch_resource,
) -> dict[str, Any]:
    safe_request_id = validate_request_id(request_id)
    parameters = normalize_request_parameters(
        cat_id=cat_id,
        source_url=source_url,
        mode=mode,
        overwrite=overwrite,
        dry_run=dry_run,
    )
    try:
        existing = read_existing_request_status(
            repo_root,
            request_id=safe_request_id,
            **parameters,
        )
    except CoverError as exc:
        return build_status(
            request_id=safe_request_id,
            success=False,
            status=exc.status,
            message=exc.message,
            **parameters,
        )
    if existing is not None:
        return existing

    safe_cat_id = parameters["cat_id"]
    try:
        payload = process_request(
            repo_root=repo_root,
            cat_id=safe_cat_id,
            source_url=parameters["source_url"],
            request_id=safe_request_id,
            mode=parameters["mode"],
            overwrite=parameters["overwrite"],
            dry_run=parameters["dry_run"],
            fetcher=fetcher,
        )
    except CoverError as exc:
        payload = build_status(
            cat_id=safe_cat_id,
            request_id=safe_request_id,
            source_url=parameters["source_url"],
            success=False,
            status=exc.status,
            message=exc.message,
            mode=parameters["mode"],
            overwrite=parameters["overwrite"],
            dry_run=parameters["dry_run"],
        )
    write_status_files(repo_root, payload, parameters["mode"])
    return payload


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cat-id", default="")
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--mode", choices=("preview", "commit"), default="commit")
    parser.add_argument("--overwrite", default="false")
    parser.add_argument("--dry-run", default="false")
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        payload = run_and_record(
            repo_root=args.repo_root.resolve(),
            cat_id=args.cat_id,
            source_url=args.source_url,
            request_id=args.request_id,
            mode=args.mode,
            overwrite=parse_bool(args.overwrite),
            dry_run=parse_bool(args.dry_run),
        )
    except CoverError as exc:
        print(
            json.dumps({"success": False, "status": exc.status, "message": exc.message})
        )
        return 2
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload.get("success") else 2


if __name__ == "__main__":
    sys.exit(main())
