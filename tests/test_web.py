"""网页 API 端到端测试（使用 Flask test client 与后台任务队列）。"""

from __future__ import annotations

import io
import time
import zipfile

from musickey.web import JobManager, create_app
from musickey.tags import read_metadata

from builders import (
    PLAIN,
    build_kgm,
    build_kwm,
    build_ncm,
    build_qmc_v1,
    build_qmc_v2,
    load_kgm_pub_key,
    make_ekey_v1,
)


def _wait(client, job_id: str, timeout: float = 12):
    deadline = time.time() + timeout
    while time.time() < deadline:
        response = client.get(f"/api/jobs/{job_id}")
        job = response.get_json()["job"]
        if job["status"] in ("done", "failed", "cancelled"):
            return job
        time.sleep(0.12)
    raise TimeoutError("任务超时")


def test_web_roundtrip(tmp_path):
    manager = JobManager(workers=2)
    app = create_app(manager)
    client = app.test_client()

    health = client.get("/api/health")
    assert health.status_code == 200
    assert ".kgm.flac" in health.get_json()["formats"]

    cases = [
        ("song.ncm", build_ncm(PLAIN, b"0123456789abcdef")),
        ("song.tkm", build_qmc_v1(PLAIN)),
        ("song.mgg", build_qmc_v2(PLAIN, bytes(range(24)), make_ekey_v1(bytes(range(24))))),
        ("song.kgm", build_kgm(PLAIN, load_kgm_pub_key())),
        ("song.kwm", build_kwm(PLAIN)),
    ]
    expected = [PLAIN] * len(cases)
    ids = []
    for (name, data), expect in zip(cases, expected):
        response = client.post(
            "/api/jobs",
            data={"file": (io.BytesIO(data), name), "format": "", "embed_cover": "0"},
            content_type="multipart/form-data",
        )
        assert response.status_code == 202, response.get_data(as_text=True)
        ids.append(response.get_json()["id"])
        job = _wait(client, response.get_json()["id"])
        assert job["status"] == "done", job
        download = client.get(f"/api/download/{response.get_json()['id']}")
        assert download.data == expect

    zip_response = client.get(f"/api/zip?ids={','.join(ids)}")
    assert zip_response.status_code == 200
    assert len(zipfile.ZipFile(io.BytesIO(zip_response.data)).namelist()) == len(cases)


def test_web_bad_file_rejected(tmp_path):
    manager = JobManager(workers=1)
    app = create_app(manager)
    client = app.test_client()
    response = client.post(
        "/api/jobs",
        data={"file": (io.BytesIO(b"NOT A REAL FILE"), "bad.ncm")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 202
    job = _wait(client, response.get_json()["id"])
    assert job["status"] == "failed"


def test_web_metadata_preserved(tmp_path):
    manager = JobManager(workers=1)
    app = create_app(manager)
    client = app.test_client()
    meta = {"format": "mp3", "musicName": "网页测试", "artist": [["歌手A", 1]], "album": "专辑A"}
    response = client.post(
        "/api/jobs",
        data={"file": (io.BytesIO(build_ncm(PLAIN, b"0123456789abcdef", meta)), "meta.ncm"), "embed_cover": "1"},
        content_type="multipart/form-data",
    )
    job = _wait(client, response.get_json()["id"])
    assert job["status"] == "done"
    assert job["tags"]["title"] == "网页测试"
    download = client.get(f"/api/download/{response.get_json()['id']}")
    output = tmp_path / "meta.mp3"
    output.write_bytes(download.data)
    tags, _ = read_metadata(output, "mp3")
    assert tags["title"] == "网页测试"
    assert tags["artist"] == "歌手A"
