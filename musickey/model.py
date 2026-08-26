"""核心数据模型与容器嗅探。"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


KNOWN_CONTAINERS = ("flac", "mp3", "ogg", "m4a", "wav")
OUTPUT_EXTENSIONS = {
    "flac": "flac",
    "mp3": "mp3",
    "ogg": "ogg",
    "m4a": "m4a",
    "wav": "wav",
}

_MAGIC = (
    (b"fLaC", "flac"),
    (b"OggS", "ogg"),
    (b"ID3", "mp3"),
    (b"RIFF", "wav"),
)


def sniff_container(head: bytes) -> str:
    """根据文件头识别音频容器；无法识别时返回 ``bin``。"""
    for magic, name in _MAGIC:
        if head.startswith(magic):
            if magic == b"RIFF" and len(head) >= 12 and head[8:12] != b"WAVE":
                continue
            return name
    if len(head) >= 8 and head[4:8] == b"ftyp":
        return "m4a"
    if len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0:
        return "mp3"
    return "bin"


@dataclass(slots=True)
class DecodeResult:
    """一次解码的结果。

    ``payload`` 仅在直接调用 ``Decoder.decode`` 的兼容路径中携带；
    正常批量/网页流程使用流式接口 ``decode_to``，避免大文件占用内存。
    """

    container: str
    tags: dict[str, str] = field(default_factory=dict)
    cover: bytes | None = None
    source: str = ""
    payload: bytes | None = None

    @property
    def suggested_extension(self) -> str:
        return OUTPUT_EXTENSIONS.get(self.container, "bin")


@dataclass(slots=True)
class FileOutcome:
    """单个文件的处理结果。"""

    input: Path
    output: Path | None = None
    status: str = "ok"
    note: str = ""
    source: str = ""
    container: str = ""
    size: int = 0

    @property
    def ok(self) -> bool:
        return self.status == "ok"
