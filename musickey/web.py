"""本地网页服务：异步任务队列、流式进度与结果下载。

服务默认只监听 127.0.0.1；文件始终停留在本机临时目录，不经过任何远程服务器。
"""

from __future__ import annotations

import io
import json
import os
import queue
import shutil
import tempfile
import threading
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from flask import Flask, jsonify, request, send_file

from . import __version__
from .engine import BatchOptions, process_one
from .formats import supported_extensions
from .formats.base import DecodeOptions
from .model import OUTPUT_EXTENSIONS
from .resources import bundled_path
from .tags import read_metadata
from .transcode import TARGETS, resolve_ffmpeg

APP_NAME = "MusicKey"
STORE_ROOT = Path(tempfile.gettempdir()) / "musickey-web"


@dataclass(slots=True)
class Job:
    id: str
    name: str
    source_path: Path
    work_dir: Path
    target: str | None
    embed_cover: bool
    ekey: str | None
    ekey_db: Path | None = None
    status: str = "queued"
    progress: int = 0
    phase: str = "等待中"
    result_path: Path | None = None
    container: str = ""
    size: int = 0
    tags: dict[str, str] = field(default_factory=dict)
    has_cover: bool = False
    error: str = ""
    source: str = ""
    created: float = field(default_factory=time.time)
    cancel_event: threading.Event = field(default_factory=threading.Event)

    @property
    def output_name(self) -> str:
        stem = Path(self.name).stem
        ext = self.target or OUTPUT_EXTENSIONS.get(self.container, "bin")
        return f"{stem}.{ext}"


class JobManager:
    def __init__(self, workers: int = 2) -> None:
        self.workers = workers
        self._queue: queue.Queue[str] = queue.Queue()
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._threads: list[threading.Thread] = []
        self._started = False

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        STORE_ROOT.mkdir(parents=True, exist_ok=True)
        for index in range(self.workers):
            thread = threading.Thread(
                target=self._worker_loop,
                name=f"musickey-worker-{index + 1}",
                daemon=True,
            )
            thread.start()
            self._threads.append(thread)

    def _worker_loop(self) -> None:
        while True:
            job_id = self._queue.get()
            try:
                self._process(job_id)
            except Exception as exc:
                self._fail(job_id, f"{type(exc).__name__}: {exc}")
            finally:
                self._queue.task_done()

    def create(
        self,
        source: Path,
        original_name: str,
        target: str | None,
        embed_cover: bool,
        ekey: str | None,
        ekey_db: Path | None,
    ) -> Job:
        self.start()
        job_id = uuid.uuid4().hex
        work_dir = STORE_ROOT / job_id
        work_dir.mkdir(parents=True, exist_ok=True)
        job = Job(
            id=job_id,
            name=Path(original_name).name,
            source_path=source,
            work_dir=work_dir,
            target=target,
            embed_cover=embed_cover,
            ekey=ekey,
            ekey_db=ekey_db,
        )
        with self._lock:
            self._jobs[job_id] = job
        self._cleanup()
        self._queue.put(job_id)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def ids(self) -> list[str]:
        with self._lock:
            return list(self._jobs)

    def _process(self, job_id: str) -> None:
        job = self.get(job_id)
        if job is None:
            return
        if job.cancel_event.is_set():
            self._finish_cancelled(job)
            return
        job.status = "running"
        job.phase = "准备中"
        self._update_job(job)
        try:
            def callback(done: int, total: int, phase: str) -> None:
                percent = int(done / max(1, total) * 100)
                job.progress = percent
                job.phase = phase
                self._update_job(job)

            opts = BatchOptions(
                output_dir=job.work_dir,
                target=job.target,
                embed_cover=job.embed_cover,
                force=True,
                decode=DecodeOptions(ekey=job.ekey, ekey_db=job.ekey_db),
                jobs=1,
            )
            outcome = process_one(job.source_path, opts, callback, job.cancel_event)
            job.source = outcome.source
            job.container = outcome.container
            if outcome.status == "cancelled":
                job.status = "cancelled"
                job.error = outcome.note
            elif outcome.status != "ok" or outcome.output is None:
                job.status = "failed"
                job.error = outcome.note or "解码失败"
            else:
                job.result_path = outcome.output
                job.size = outcome.size
                job.status = "done"
                job.progress = 100
                job.phase = "完成"
                final_container = outcome.output.suffix.lstrip(".") or outcome.container
                job.container = final_container
                tags, cover = read_metadata(outcome.output, final_container)
                job.tags = tags
                job.has_cover = cover is not None
        except Exception as exc:
            job.status = "failed"
            job.error = f"{type(exc).__name__}: {exc}"
        finally:
            if job.cancel_event.is_set():
                with self._lock:
                    self._jobs.pop(job.id, None)
                shutil.rmtree(job.work_dir, ignore_errors=True)
            else:
                self._update_job(job)

    def _finish_cancelled(self, job: Job) -> None:
        job.status = "cancelled"
        job.error = "用户取消了任务"
        with self._lock:
            self._jobs.pop(job.id, None)
        shutil.rmtree(job.work_dir, ignore_errors=True)

    def _fail(self, job_id: str, message: str) -> None:
        job = self.get(job_id)
        if job:
            job.status = "failed"
            job.error = message
            self._update_job(job)

    def _update_job(self, job: Job) -> None:
        with self._lock:
            self._jobs[job.id] = job

    def remove(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            return False
        if job.status in ("queued", "running"):
            job.cancel_event.set()
            return True
        with self._lock:
            self._jobs.pop(job_id, None)
        shutil.rmtree(job.work_dir, ignore_errors=True)
        return True

    def clear(self) -> int:
        with self._lock:
            ids = list(self._jobs)
        count = 0
        for job_id in ids:
            job = self.get(job_id)
            if job and job.status in ("queued", "running"):
                job.cancel_event.set()
            elif job and self.remove(job_id):
                count += 1
        return count

    def _cleanup(self, ttl: int = 24 * 3600) -> None:
        cutoff = time.time() - ttl
        with self._lock:
            for job_id, job in list(self._jobs.items()):
                if job.created < cutoff and job.status not in ("running", "queued"):
                    self._jobs.pop(job_id, None)
                    shutil.rmtree(job.work_dir, ignore_errors=True)


_manager = JobManager(workers=2)


def _static_dir() -> Path:
    return bundled_path("webui")


def create_app(manager: JobManager | None = None) -> Flask:
    global _manager
    if manager is not None:
        _manager = manager
    app = Flask(__name__, static_folder=str(_static_dir()), static_url_path="/static")
    app.config.update(MAX_CONTENT_LENGTH=2 * 1024 * 1024 * 1024)

    @app.get("/")
    def index():
        return send_file(_static_dir() / "index.html")

    @app.get("/api/health")
    def health():
        return jsonify(
            {
                "ok": True,
                "version": __version__,
                "formats": sorted(supported_extensions()),
                "targets": list(TARGETS),
                "ffmpeg": resolve_ffmpeg() is not None,
            }
        )

    @app.post("/api/jobs")
    def create_job():
        if not request.files:
            return jsonify({"ok": False, "error": "缺少文件"}), 400
        upload = request.files.get("file")
        if upload is None or not upload.filename:
            return jsonify({"ok": False, "error": "缺少文件"}), 400
        target = (request.form.get("format") or "").strip() or None
        if target and target not in TARGETS:
            return jsonify({"ok": False, "error": "不支持的输出格式"}), 400
        embed_cover = request.form.get("embed_cover", "1") != "0"
        ekey = (request.form.get("ekey") or "").strip() or None

        job_id = uuid.uuid4().hex
        work_dir = STORE_ROOT / job_id
        work_dir.mkdir(parents=True, exist_ok=True)
        source = work_dir / f"source{Path(upload.filename).suffix}"
        upload.save(source)
        ekey_db = None
        db_upload = request.files.get("ekey_db")
        if db_upload and db_upload.filename:
            ekey_db = work_dir / "player_process_db"
            db_upload.save(ekey_db)
        job = _manager.create(source, upload.filename, target, embed_cover, ekey, ekey_db)
        return jsonify({"ok": True, "id": job.id}), 202

    @app.get("/api/jobs/<job_id>")
    def job_status(job_id: str):
        job = _manager.get(job_id)
        if not job:
            return jsonify({"ok": False, "error": "任务不存在"}), 404
        return jsonify(
            {
                "ok": True,
                "job": {
                    "id": job.id,
                    "name": job.name,
                    "status": job.status,
                    "progress": job.progress,
                    "phase": job.phase,
                    "output_name": job.output_name,
                    "container": job.container,
                    "size": job.size,
                    "tags": job.tags,
                    "has_cover": job.has_cover,
                    "error": job.error,
                    "source": job.source,
                },
            }
        )

    @app.delete("/api/jobs/<job_id>")
    def cancel_job(job_id: str):
        if _manager.remove(job_id):
            return jsonify({"ok": True})
        return jsonify({"ok": False, "error": "任务不存在"}), 404

    @app.get("/api/download/<job_id>")
    def download(job_id: str):
        job = _manager.get(job_id)
        if not job or not job.result_path:
            return jsonify({"ok": False, "error": "任务不存在"}), 404
        if not job.result_path.exists():
            return jsonify({"ok": False, "error": "结果已过期"}), 410
        return send_file(
            job.result_path,
            as_attachment=True,
            download_name=job.output_name,
            conditional=True,
        )

    @app.get("/api/audio/<job_id>")
    def audio(job_id: str):
        job = _manager.get(job_id)
        if not job or not job.result_path or not job.result_path.exists():
            return jsonify({"ok": False, "error": "音频不存在"}), 404
        mime = {
            "mp3": "audio/mpeg",
            "m4a": "audio/mp4",
            "flac": "audio/flac",
            "ogg": "audio/ogg",
            "wav": "audio/wav",
        }.get(job.container, "application/octet-stream")
        return send_file(job.result_path, mimetype=mime, conditional=True)

    @app.get("/api/cover/<job_id>")
    def cover(job_id: str):
        job = _manager.get(job_id)
        if not job or not job.result_path or not job.result_path.exists():
            return jsonify({"ok": False, "error": "无封面"}), 404
        _, data = read_metadata(job.result_path, job.container or job.target or "mp3")
        if not data:
            return jsonify({"ok": False, "error": "无封面"}), 404
        mime = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
        return send_file(io.BytesIO(data), mimetype=mime)

    @app.get("/api/zip")
    def zip_results():
        ids = [item for item in (request.args.get("ids") or "").split(",") if item]
        if not ids:
            return jsonify({"ok": False, "error": "未选择文件"}), 400
        buffer = io.BytesIO()
        added = 0
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for job_id in ids:
                job = _manager.get(job_id)
                if not job or not job.result_path or not job.result_path.exists():
                    continue
                stem, ext = Path(job.output_name).stem, Path(job.output_name).suffix
                arc_name = job.output_name
                suffix_index = 1
                while arc_name in archive.namelist():
                    arc_name = f"{stem} ({suffix_index}){ext}"
                    suffix_index += 1
                archive.write(job.result_path, arcname=arc_name)
                added += 1
        if not added:
            return jsonify({"ok": False, "error": "没有可打包的结果"}), 404
        buffer.seek(0)
        return send_file(buffer, as_attachment=True, download_name="musickey-unlocked.zip", mimetype="application/zip")

    @app.post("/api/clear")
    def clear():
        count = _manager.clear()
        return jsonify({"ok": True, "removed": count})

    @app.post("/api/shutdown")
    def shutdown():
        def _stop():
            time.sleep(0.25)
            os._exit(0)

        threading.Thread(target=_stop, daemon=True).start()
        return jsonify({"ok": True, "message": "正在退出"})

    return app


def run(host: str = "127.0.0.1", port: int = 8690, workers: int = 2) -> None:
    manager = JobManager(workers=workers)
    app = create_app(manager)
    print(f"{APP_NAME} v{__version__} 已启动: http://{host}:{port}")
    print("仅监听本机；文件不会离开你的电脑。按 Ctrl+C 退出。")
    app.run(host=host, port=port, debug=False, threaded=True)
