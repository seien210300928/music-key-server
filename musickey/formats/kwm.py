"""酷我音乐 KWM 流式解密器（老版 1024 字节头 + 32 字节循环密钥）。"""

from __future__ import annotations

from pathlib import Path
from typing import BinaryIO

from ..errors import FormatError
from ..model import DecodeResult, sniff_container
from .base import DecodeOptions, Decoder

HEADER_LEN = 1024
KEY_LEN = 32
MAX_SCAN_CHUNKS = 2048


def _try_key(data: bytes, key: bytes) -> str:
    probe = bytes(value ^ key[index & (KEY_LEN - 1)] for index, value in enumerate(data))
    stripped = probe.lstrip(b"\x00")[:64]
    return sniff_container(stripped)


class KwmDecoder(Decoder):
    name = "酷我音乐 KWM"
    extensions = frozenset({".kwm"})

    def decode_to(
        self,
        path: Path,
        out: BinaryIO,
        opts: DecodeOptions,
        progress=None,
    ) -> DecodeResult:
        if path.stat().st_size < HEADER_LEN + KEY_LEN * 2:
            raise FormatError(f"{path.name}: 文件过短")
        with path.open("rb") as fp:
            header = fp.read(HEADER_LEN)
            # 读取少量数据用于恢复密钥，避免加载整个音频文件。
            scan_size = min(path.stat().st_size - HEADER_LEN, MAX_SCAN_CHUNKS * KEY_LEN)
            scan_data = fp.read(scan_size)
            key = self._recover_key(scan_data)

            fp.seek(HEADER_LEN)
            first = fp.read(64)
            first_decoded = bytes(
                value ^ key[index & (KEY_LEN - 1)] for index, value in enumerate(first)
            )
            container = sniff_container(first_decoded.lstrip(b"\x00")[:64])
            out.write(first_decoded)
            position = 64
            remaining = path.stat().st_size - HEADER_LEN - 64
            while remaining:
                chunk = fp.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                decoded = bytearray(len(chunk))
                for index, value in enumerate(chunk):
                    decoded[index] = value ^ key[(position + index) & (KEY_LEN - 1)]
                out.write(decoded)
                position += len(chunk)
                remaining -= len(chunk)
                if progress:
                    progress(position, path.stat().st_size - HEADER_LEN, "decrypt")
        return DecodeResult(container=container, source="kwm")

    @staticmethod
    def _recover_key(body: bytes) -> bytes:
        candidates: list[bytes] = []
        prev = body[:KEY_LEN]
        for index in range(1, len(body) // KEY_LEN):
            chunk = body[index * KEY_LEN : (index + 1) * KEY_LEN]
            if chunk == prev:
                candidates.append(chunk)
            prev = chunk
        if prev:
            candidates.append(prev[KEY_LEN // 2 :] + prev[: KEY_LEN // 2])

        for key in candidates:
            if _try_key(body[:4096], key) != "bin":
                return key
        for index in range(min(64, len(body) // KEY_LEN)):
            key = body[index * KEY_LEN : (index + 1) * KEY_LEN]
            if _try_key(body[:4096], key) != "bin":
                return key
        return candidates[0] if candidates else bytes(KEY_LEN)
