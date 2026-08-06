from __future__ import annotations

import json
import sys
import uuid
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import import_cover as cover  # noqa: E402


PUBLIC = "https://93.184.216.34"


def image_bytes(fmt="JPEG", size=(80, 120), color=(20, 80, 160, 255)):
    mode = "RGBA" if len(color) == 4 else "RGB"
    image = Image.new(mode, size, color)
    if fmt.upper() in {"JPG", "JPEG"}:
        image = image.convert("RGB")
    output = BytesIO()
    image.save(output, fmt)
    return output.getvalue()


def request_id():
    return str(uuid.uuid4())


def fake_fetcher(mapping):
    def fetch(url):
        value = mapping[url]
        if isinstance(value, Exception):
            raise value
        return value

    return fetch


def resource(url, content_type, body):
    return cover.FetchedResource(url, content_type, body)


def process(tmp_path, fetcher, **overrides):
    params = {
        "repo_root": tmp_path,
        "cat_id": "CAT-9001",
        "source_url": f"{PUBLIC}/source",
        "request_id": request_id(),
        "mode": "commit",
        "overwrite": False,
        "dry_run": False,
        "fetcher": fetcher,
    }
    params.update(overrides)
    return cover.process_request(**params)


def test_direct_jpg_url(tmp_path):
    url = f"{PUBLIC}/cover.jpg"
    result = process(
        tmp_path,
        fake_fetcher({url: resource(url, "image/jpeg", image_bytes())}),
        source_url=url,
    )
    assert result["status"] == "completed"
    assert (tmp_path / "covers" / "CAT-9001.jpg").exists()


def test_direct_png_url_is_converted_to_real_jpeg(tmp_path):
    url = f"{PUBLIC}/cover.png"
    result = process(
        tmp_path,
        fake_fetcher({url: resource(url, "image/png", image_bytes("PNG"))}),
        source_url=url,
    )
    assert result["success"] is True
    with Image.open(tmp_path / "covers" / "CAT-9001.jpg") as image:
        assert image.format == "JPEG"
        assert image.mode == "RGB"


@pytest.mark.parametrize(
    "html,candidate",
    [
        (b'<meta property="og:image" content="/media/cover.jpg">', "/media/cover.jpg"),
        (b'<meta name="twitter:image" content="/twitter.png">', "/twitter.png"),
    ],
)
def test_html_metadata_sources(tmp_path, html, candidate):
    page = f"{PUBLIC}/book/page"
    image_url = f"{PUBLIC}{candidate}"
    fetcher = fake_fetcher(
        {
            page: resource(page, "text/html", html),
            image_url: resource(image_url, "image/png", image_bytes("PNG")),
        }
    )
    result = process(tmp_path, fetcher, source_url=page)
    assert result["image_source_url"] == image_url


def test_relative_og_image_uses_page_url():
    page = f"{PUBLIC}/catalog/item/"
    html = b'<meta property="og:image" content="../images/book.jpg">'
    assert cover.discover_image_url(page, html) == f"{PUBLIC}/catalog/images/book.jpg"


def test_json_ld_image_is_supported():
    page = f"{PUBLIC}/book"
    html = b'<script type="application/ld+json">{"@type":"Book","image":{"url":"/j.jpg"}}</script>'
    assert cover.discover_image_url(page, html) == f"{PUBLIC}/j.jpg"


@pytest.mark.parametrize("url", ["not-a-url", "file:///tmp/book.jpg", "ftp://example.com/x"])
def test_invalid_url(url):
    with pytest.raises(cover.CoverError) as error:
        cover.validate_public_url(url)
    assert error.value.status == "invalid_url"


def test_404_is_recorded_as_error(tmp_path):
    url = f"{PUBLIC}/missing"
    result = cover.run_and_record(
        repo_root=tmp_path,
        cat_id="CAT-9001",
        source_url=url,
        request_id=request_id(),
        mode="commit",
        overwrite=False,
        dry_run=False,
        fetcher=fake_fetcher({url: cover.CoverError("url_unavailable", "HTTP 404")}),
    )
    assert result["success"] is False
    assert result["status"] == "url_unavailable"


def test_html_without_image(tmp_path):
    url = f"{PUBLIC}/plain"
    result = cover.run_and_record(
        repo_root=tmp_path,
        cat_id="CAT-9001",
        source_url=url,
        request_id=request_id(),
        mode="commit",
        overwrite=False,
        dry_run=False,
        fetcher=fake_fetcher({url: resource(url, "text/html", b"<h1>Book</h1>")}),
    )
    assert result["status"] == "image_not_found"


def test_invalid_file_instead_of_image(tmp_path):
    url = f"{PUBLIC}/fake.jpg"
    result = cover.run_and_record(
        repo_root=tmp_path,
        cat_id="CAT-9001",
        source_url=url,
        request_id=request_id(),
        mode="commit",
        overwrite=False,
        dry_run=False,
        fetcher=fake_fetcher({url: resource(url, "image/jpeg", b"not an image")}),
    )
    assert result["status"] == "unsupported_format"


def test_file_over_limit_error_is_preserved(tmp_path):
    url = f"{PUBLIC}/huge.jpg"
    result = cover.run_and_record(
        repo_root=tmp_path,
        cat_id="CAT-9001",
        source_url=url,
        request_id=request_id(),
        mode="commit",
        overwrite=False,
        dry_run=False,
        fetcher=fake_fetcher({url: cover.CoverError("file_too_large", "too large")}),
    )
    assert result["status"] == "file_too_large"


def test_cat_id_path_traversal_is_rejected(tmp_path):
    url = f"{PUBLIC}/cover.jpg"
    with pytest.raises(cover.CoverError) as error:
        process(
            tmp_path,
            fake_fetcher({url: resource(url, "image/jpeg", image_bytes())}),
            cat_id="../CAT-9001",
            source_url=url,
        )
    assert error.value.status == "invalid_cat_id"


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost/image.jpg",
        "http://127.0.0.1/image.jpg",
        "http://10.0.0.1/image.jpg",
        "http://172.16.1.1/image.jpg",
        "http://192.168.1.1/image.jpg",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/image.jpg",
        "http://[fc00::1]/image.jpg",
    ],
)
def test_local_and_private_urls_are_blocked(url):
    with pytest.raises(cover.CoverError) as error:
        cover.validate_public_url(url)
    assert error.value.status == "unsafe_url"


def test_existing_file_is_not_overwritten_by_default(tmp_path):
    path = tmp_path / "covers" / "CAT-9001.jpg"
    path.parent.mkdir()
    path.write_bytes(b"original")
    url = f"{PUBLIC}/cover.jpg"
    result = process(
        tmp_path,
        fake_fetcher({url: resource(url, "image/jpeg", image_bytes())}),
        source_url=url,
    )
    assert result["status"] == "already_exists"
    assert path.read_bytes() == b"original"


def test_overwrite_replaces_existing_file(tmp_path):
    path = tmp_path / "covers" / "CAT-9001.jpg"
    path.parent.mkdir()
    path.write_bytes(b"original")
    url = f"{PUBLIC}/cover.jpg"
    result = process(
        tmp_path,
        fake_fetcher({url: resource(url, "image/jpeg", image_bytes())}),
        source_url=url,
        overwrite=True,
    )
    assert result["status"] == "completed"
    assert path.read_bytes() != b"original"


def test_transparent_png_gets_white_background():
    png = image_bytes("PNG", size=(10, 10), color=(255, 0, 0, 0))
    jpeg = cover.convert_to_jpeg(png)
    with Image.open(BytesIO(jpeg)) as image:
        pixel = image.getpixel((5, 5))
    assert all(channel > 245 for channel in pixel)


def test_aspect_ratio_is_preserved():
    jpeg = cover.convert_to_jpeg(image_bytes(size=(1200, 600), color=(10, 20, 30)))
    with Image.open(BytesIO(jpeg)) as image:
        assert image.size == (600, 300)


def test_success_status_json_is_created(tmp_path):
    rid = request_id()
    url = f"{PUBLIC}/cover.jpg"
    result = cover.run_and_record(
        repo_root=tmp_path,
        cat_id="CAT-9001",
        source_url=url,
        request_id=rid,
        mode="commit",
        overwrite=False,
        dry_run=False,
        fetcher=fake_fetcher({url: resource(url, "image/jpeg", image_bytes())}),
    )
    saved = json.loads((tmp_path / "cover-status" / "requests" / f"{rid}.json").read_text("utf-8"))
    latest = json.loads((tmp_path / "cover-status" / "CAT-9001.json").read_text("utf-8"))
    assert saved == result == latest


def test_error_status_json_is_created(tmp_path):
    rid = request_id()
    url = f"{PUBLIC}/page"
    result = cover.run_and_record(
        repo_root=tmp_path,
        cat_id="CAT-9001",
        source_url=url,
        request_id=rid,
        mode="commit",
        overwrite=False,
        dry_run=False,
        fetcher=fake_fetcher({url: resource(url, "text/html", b"<html></html>")}),
    )
    saved = json.loads((tmp_path / "cover-status" / "requests" / f"{rid}.json").read_text("utf-8"))
    assert result["success"] is False
    assert saved["status"] == "image_not_found"


def test_preview_does_not_require_cat_id_or_write_cover(tmp_path):
    url = f"{PUBLIC}/cover.jpg"
    result = process(
        tmp_path,
        fake_fetcher({url: resource(url, "image/jpeg", image_bytes())}),
        source_url=url,
        cat_id="",
        mode="preview",
    )
    assert result["status"] == "preview_ready"
    assert not (tmp_path / "covers").exists()


def test_dry_run_does_not_replace_cover(tmp_path):
    url = f"{PUBLIC}/cover.jpg"
    result = process(
        tmp_path,
        fake_fetcher({url: resource(url, "image/jpeg", image_bytes())}),
        source_url=url,
        dry_run=True,
    )
    assert result["status"] == "dry_run_completed"
    assert not (tmp_path / "covers" / "CAT-9001.jpg").exists()
