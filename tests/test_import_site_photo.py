from __future__ import annotations

import base64
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
import import_site_photo as site_photo  # noqa: E402


def image_bytes(fmt: str = "PNG", size=(1200, 600), color=(30, 100, 180, 255)) -> bytes:
    mode = "RGBA" if len(color) == 4 else "RGB"
    image = Image.new(mode, size, color)
    if fmt.upper() in {"JPEG", "JPG"}:
        image = image.convert("RGB")
    output = BytesIO()
    image.save(output, fmt)
    return output.getvalue()


def make_import(
    repo_root: Path,
    content: bytes,
    *,
    cat_id: str = "CAT-9001",
    request_id: str | None = None,
    overwrite: bool = False,
) -> tuple[Path, str]:
    request_id = request_id or str(uuid.uuid4())
    marker = "ow1" if overwrite else "ow0"
    path = repo_root / "imports" / "site" / f"{cat_id}--{request_id}--{marker}.jpg.b64"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path, request_id


def read_request_status(repo_root: Path, request_id: str) -> dict:
    path = repo_root / "cover-status" / "requests" / f"{request_id}.json"
    return json.loads(path.read_text("utf-8"))


def test_valid_photo_is_converted_recorded_and_consumed(tmp_path):
    import_path, request_id = make_import(
        tmp_path,
        base64.b64encode(image_bytes("PNG")),
    )

    result = site_photo.run_site_import(repo_root=tmp_path, input_path=import_path)

    cover_path = tmp_path / "covers" / "CAT-9001.jpg"
    assert result == read_request_status(tmp_path, request_id)
    assert result["success"] is True
    assert result["status"] == "completed"
    assert result["final_url"].endswith("/covers/CAT-9001.jpg")
    assert result["import_path"] == f"imports/site/{import_path.name}"
    assert len(result["output_sha256"]) == 64
    assert not import_path.exists()
    assert not (tmp_path / "cover-status" / "CAT-9001.json").exists()
    with Image.open(cover_path) as image:
        assert image.format == "JPEG"
        assert image.mode == "RGB"
        assert image.size == (600, 300)
        assert image.info.get("progressive") or image.info.get("progression")


@pytest.mark.parametrize(
    ("content", "expected_status"),
    [
        (b"not base64!", "invalid_base64"),
        (base64.b64encode(b"not an image"), "unsupported_format"),
        (b"", "invalid_base64"),
    ],
)
def test_expected_decode_errors_create_status_and_consume_import(
    tmp_path,
    content,
    expected_status,
):
    import_path, request_id = make_import(tmp_path, content)

    result = site_photo.run_site_import(repo_root=tmp_path, input_path=import_path)

    assert result["success"] is False
    assert result["status"] == expected_status
    assert read_request_status(tmp_path, request_id) == result
    assert not import_path.exists()
    assert not (tmp_path / "covers" / "CAT-9001.jpg").exists()


def test_oversized_encoded_file_is_not_read_or_left_pending(tmp_path):
    import_path, request_id = make_import(tmp_path, b"placeholder")
    import_path.write_bytes(b"x" * (site_photo.MAX_BASE64_BYTES + 1))

    result = site_photo.run_site_import(repo_root=tmp_path, input_path=import_path)

    assert result["success"] is False
    assert result["status"] == "file_too_large"
    assert read_request_status(tmp_path, request_id) == result
    assert not import_path.exists()


def test_decompression_bomb_is_recorded_as_file_too_large(tmp_path, monkeypatch):
    monkeypatch.setattr(cover.Image, "MAX_IMAGE_PIXELS", 50)
    import_path, request_id = make_import(
        tmp_path,
        base64.b64encode(image_bytes(size=(20, 20))),
    )

    result = site_photo.run_site_import(repo_root=tmp_path, input_path=import_path)

    assert result["success"] is False
    assert result["status"] == "file_too_large"
    assert read_request_status(tmp_path, request_id) == result
    assert not import_path.exists()


def test_ow0_blocks_a_different_existing_cover(tmp_path):
    cover_path = tmp_path / "covers" / "CAT-9001.jpg"
    cover_path.parent.mkdir(parents=True)
    original = cover.convert_to_jpeg(image_bytes(color=(200, 30, 40, 255)))
    cover_path.write_bytes(original)
    import_path, request_id = make_import(
        tmp_path,
        base64.b64encode(image_bytes(color=(20, 200, 40, 255))),
    )

    result = site_photo.run_site_import(repo_root=tmp_path, input_path=import_path)

    assert result["success"] is False
    assert result["status"] == "already_exists"
    assert cover_path.read_bytes() == original
    assert read_request_status(tmp_path, request_id) == result
    assert not import_path.exists()


def test_ow1_explicitly_replaces_an_existing_cover(tmp_path):
    cover_path = tmp_path / "covers" / "CAT-9001.jpg"
    cover_path.parent.mkdir(parents=True)
    original = cover.convert_to_jpeg(image_bytes(color=(200, 30, 40, 255)))
    cover_path.write_bytes(original)
    import_path, request_id = make_import(
        tmp_path,
        base64.b64encode(image_bytes(color=(20, 200, 40, 255))),
        overwrite=True,
    )

    result = site_photo.run_site_import(repo_root=tmp_path, input_path=import_path)

    assert result["success"] is True
    assert result["status"] == "completed"
    assert result["overwrite"] is True
    assert cover_path.read_bytes() != original
    assert read_request_status(tmp_path, request_id) == result


def test_retry_reconciles_cover_written_before_status(tmp_path):
    source = image_bytes(color=(20, 200, 40, 255))
    converted = cover.convert_to_jpeg(source)
    cover_path = tmp_path / "covers" / "CAT-9001.jpg"
    cover_path.parent.mkdir(parents=True)
    cover_path.write_bytes(converted)
    import_path, request_id = make_import(tmp_path, base64.b64encode(source))

    result = site_photo.run_site_import(repo_root=tmp_path, input_path=import_path)

    assert result["success"] is True
    assert result["status"] == "already_applied"
    assert cover_path.read_bytes() == converted
    assert read_request_status(tmp_path, request_id) == result
    assert not import_path.exists()


def test_retry_with_existing_exact_status_is_consumed_without_reprocessing(tmp_path):
    request_id = str(uuid.uuid4())
    first_path, _ = make_import(
        tmp_path,
        base64.b64encode(image_bytes(color=(20, 200, 40, 255))),
        request_id=request_id,
    )
    first = site_photo.run_site_import(repo_root=tmp_path, input_path=first_path)
    original_cover = (tmp_path / "covers" / "CAT-9001.jpg").read_bytes()
    retry_path, _ = make_import(
        tmp_path,
        base64.b64encode(image_bytes(color=(240, 20, 40, 255))),
        request_id=request_id,
    )

    retried = site_photo.run_site_import(repo_root=tmp_path, input_path=retry_path)

    assert retried == first
    assert (tmp_path / "covers" / "CAT-9001.jpg").read_bytes() == original_cover
    assert not retry_path.exists()


def test_success_status_is_not_reused_when_cover_changed_afterward(tmp_path):
    request_id = str(uuid.uuid4())
    first_path, _ = make_import(
        tmp_path,
        base64.b64encode(image_bytes(color=(20, 200, 40, 255))),
        request_id=request_id,
    )
    first = site_photo.run_site_import(repo_root=tmp_path, input_path=first_path)
    (tmp_path / "covers" / "CAT-9001.jpg").write_bytes(b"changed later")
    retry_path, _ = make_import(
        tmp_path,
        base64.b64encode(image_bytes(color=(20, 200, 40, 255))),
        request_id=request_id,
    )

    with pytest.raises(site_photo.SitePhotoError) as error:
        site_photo.run_site_import(repo_root=tmp_path, input_path=retry_path)

    assert error.value.status_code == "request_id_conflict"
    assert read_request_status(tmp_path, request_id) == first
    assert retry_path.exists()


def test_reused_request_id_for_another_cat_is_rejected_without_overwriting_status(
    tmp_path,
):
    request_id = str(uuid.uuid4())
    first_path, _ = make_import(
        tmp_path,
        base64.b64encode(image_bytes()),
        request_id=request_id,
    )
    first = site_photo.run_site_import(repo_root=tmp_path, input_path=first_path)
    conflict_path, _ = make_import(
        tmp_path,
        base64.b64encode(image_bytes()),
        cat_id="CAT-9002",
        request_id=request_id,
    )

    with pytest.raises(site_photo.SitePhotoError) as error:
        site_photo.run_site_import(repo_root=tmp_path, input_path=conflict_path)

    assert error.value.status_code == "request_id_conflict"
    assert read_request_status(tmp_path, request_id) == first
    assert conflict_path.exists()
    assert not (tmp_path / "covers" / "CAT-9002.jpg").exists()


def test_path_traversal_is_rejected_without_deleting_external_file(tmp_path):
    request_id = str(uuid.uuid4())
    outside = tmp_path / "outside" / f"CAT-9001--{request_id}--ow0.jpg.b64"
    outside.parent.mkdir()
    outside.write_bytes(base64.b64encode(image_bytes()))

    with pytest.raises(site_photo.SitePhotoError) as error:
        site_photo.run_site_import(
            repo_root=tmp_path,
            input_path=Path("imports/site/../../outside") / outside.name,
        )

    assert error.value.status_code == "invalid_import_path"
    assert outside.exists()
    assert not (tmp_path / "cover-status" / "requests" / f"{request_id}.json").exists()


def test_unsafe_cover_directory_is_recorded_without_writing_outside(tmp_path):
    (tmp_path / "covers").write_text("not a directory", "utf-8")
    import_path, request_id = make_import(
        tmp_path,
        base64.b64encode(image_bytes()),
    )

    result = site_photo.run_site_import(repo_root=tmp_path, input_path=import_path)

    assert result["success"] is False
    assert result["status"] == "unsafe_repository_path"
    assert read_request_status(tmp_path, request_id) == result
    assert not import_path.exists()
    assert (tmp_path / "covers").read_text("utf-8") == "not a directory"


@pytest.mark.parametrize(
    "name",
    [
        "CAT-9--11111111-1111-4111-8111-111111111111--ow0.jpg.b64",
        "CAT-9001--not-a-uuid--ow0.jpg.b64",
        "CAT-9001--11111111-1111-4111-8111-111111111111--ow2.jpg.b64",
        "CAT-9001--11111111-1111-4111-8111-111111111111--ow1.jpg.b64.exe",
    ],
)
def test_invalid_import_names_are_rejected_before_processing(tmp_path, name):
    safe_name = Path(name).name
    path = tmp_path / "imports" / "site" / safe_name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64encode(image_bytes()))

    with pytest.raises(site_photo.SitePhotoError) as error:
        site_photo.run_site_import(repo_root=tmp_path, input_path=path)

    assert error.value.status_code == "invalid_import_name"
    assert path.exists()


def test_workflow_is_isolated_to_site_import_path():
    workflow = (ROOT / ".github" / "workflows" / "import-site-photo.yml").read_text(
        "utf-8"
    )
    assert "imports/site/*.jpg.b64" in workflow
    assert "scripts/import_site_photo.py" in workflow
    assert "contents: write" in workflow
    assert "git add --all -- covers cover-status/requests imports/site" in workflow
    assert "import-base64-cover.yml" not in workflow
