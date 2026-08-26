"""解码器公共基类与流式接口。"""

from __future__ import annotations

import io
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO, Callable

from ..model import DecodeResult

ProgressFn = Callable[[int, int, str], None]


@dataclass(slots=True)
class DecodeOptions:
    """解码时可提供的外部密钥材料。"""

    ekey: str | None = None
    ekey_db: Path | None = None
    kgm_key: Path | None = None
    extra: dict = field(default_factory=dict)


class Decoder(ABC):
    """所有格式解码器的公共接口。

    子类只需要实现流式 ``decode_to``；兼容的同名 ``decode`` 方法会调用它并
    将结果读到内存，供测试和轻量用途使用。
    """

    name: str = "?"
    extensions: frozenset[str] = frozenset()

    @abstractmethod
    def decode_to(
        self,
        path: Path,
        out: BinaryIO,
        opts: DecodeOptions,
        progress: ProgressFn | None = None,
    ) -> DecodeResult:
        """把解密后的音频字节流写入 ``out``，返回元数据与容器信息。"""
        raise NotImplementedError

    def decode(self, path: Path, opts: DecodeOptions) -> DecodeResult:
        """兼容接口：返回含 ``payload`` 的完整结果。"""
        buffer = io.BytesIO()
        result = self.decode_to(path, buffer, opts)
        result.payload = buffer.getvalue()
        return result
