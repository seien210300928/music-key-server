"""QQ 音乐 QMC 流式解密器（v1 静态密钥 / v2 Map/RC4）。"""

from __future__ import annotations

import base64
import sqlite3
from pathlib import Path
from typing import BinaryIO

from ..ciphers import derive_master_key, qmc1_transform, qmc1_transform_file, qmc2_stream_file
from ..ciphers import make_qmc2_stream
from ..errors import FormatError, KeyMissingError, UnsupportedError
from ..model import DecodeResult, sniff_container
from .base import DecodeOptions, Decoder

V1_STATIC_KEY = bytes(
    [
        0xC3, 0x4A, 0xD6, 0xCA, 0x90, 0x67, 0xF7, 0x52, 0xD8, 0xA1, 0x66, 0x62, 0x9F, 0x5B, 0x09, 0x00,
        0xC3, 0x5E, 0x95, 0x23, 0x9F, 0x13, 0x11, 0x7E, 0xD8, 0x92, 0x3F, 0xBC, 0x90, 0xBB, 0x74, 0x0E,
        0xC3, 0x47, 0x74, 0x3D, 0x90, 0xAA, 0x3F, 0x51, 0xD8, 0xF4, 0x11, 0x84, 0x9F, 0xDE, 0x95, 0x1D,
        0xC3, 0xC6, 0x09, 0xD5, 0x9F, 0xFA, 0x66, 0xF9, 0xD8, 0xF0, 0xF7, 0xA0, 0x90, 0xA1, 0xD6, 0xF3,
        0xC3, 0xF3, 0xD6, 0xA1, 0x90, 0xA0, 0xF7, 0xF0, 0xD8, 0xF9, 0x66, 0xFA, 0x9F, 0xD5, 0x09, 0xC6,
        0xC3, 0x1D, 0x95, 0xDE, 0x9F, 0x84, 0x11, 0xF4, 0xD8, 0x51, 0x3F, 0xAA, 0x90, 0x3D, 0x74, 0x47,
        0xC3, 0x0E, 0x74, 0xBB, 0x90, 0xBC, 0x3F, 0x92, 0xD8, 0x7E, 0x11, 0x13, 0x9F, 0x23, 0x95, 0x5E,
        0xC3, 0x00, 0x09, 0x5B, 0x9F, 0x62, 0x66, 0xA1, 0xD8, 0x52, 0xF7, 0x67, 0x90, 0xCA, 0xD6, 0x4A,
    ]
)

V1_EXTS = {
    ".tkm",
    ".bkcmp3",
    ".bkcm4a",
    ".bkcflac",
    ".bkcwav",
    ".bkcape",
    ".bkcogg",
    ".bkcwma",
    ".666c6163",
    ".6d7033",
    ".6f6767",
    ".6d3461",
    ".776176",
}
V2_EXTS = {
    ".mflac",
    ".mflac0",
    ".mgg",
    ".mgg0",
    ".mgg1",
    ".mggl",
    ".mmp4",
    ".qmcflac",
    ".qmcogg",
    ".qmc0",
    ".qmc2",
    ".qmc3",
    ".qmc4",
    ".qmc6",
    ".qmc8",
}
MAX_EKEY_LEN = 0x500
MUSICEX_BLOCK = 0xC0
FOOTER_SAMPLE = 4096


class Footer:
    __slots__ = ("size", "ekey", "kind", "resource_id", "mid", "media_filename")

    def __init__(self, size: int, ekey: str | None, kind: str, **extra):
        self.size = size
        self.ekey = ekey
        self.kind = kind
        self.resource_id = extra.get("resource_id")
        self.mid = extra.get("mid")
        self.media_filename = extra.get("media_filename")


def _is_base64_text(value: bytes) -> bool:
    return bool(value) and all(char in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=" for char in value)


def _read_utf16le(data: bytes) -> str:
    result = []
    for index in range(0, len(data) - 1, 2):
        lo, hi = data[index], data[index + 1]
        if lo == 0 and hi == 0:
            break
        if hi == 0 and 0 < lo < 128:
            result.append(chr(lo))
        else:
            break
    return "".join(result)


def parse_footer(tail: bytes) -> Footer | None:
    """解析 QMC 文件尾部（QTag / STag / MusicEx / PcV1Legacy）。"""
    if len(tail) < 8:
        return None

    if tail.endswith(b"STag"):
        body = tail[:-4]
        payload, size_bytes = body[:-4], body[-4:]
        payload_len = int.from_bytes(size_bytes, "big")
        if len(payload) < payload_len:
            raise FormatError("STag 长度不一致")
        parts = payload[len(payload) - payload_len :].decode("utf-8", "replace").split(",")
        if len(parts) != 3 or parts[1] != "2" or not parts[0].isdigit():
            raise FormatError("STag 内容非法")
        return Footer(payload_len + 8, None, "STag", resource_id=int(parts[0]), mid=parts[2])

    if tail.endswith(b"QTag"):
        body = tail[:-4]
        payload, size_bytes = body[:-4], body[-4:]
        payload_len = int.from_bytes(size_bytes, "big")
        if len(payload) < payload_len:
            raise FormatError("QTag 长度不一致")
        parts = payload[len(payload) - payload_len :].decode("utf-8", "replace").split(",")
        if len(parts) != 3 or parts[2] != "2" or not parts[1].isdigit():
            raise FormatError("QTag 内容非法")
        ekey = parts[0]
        if not _is_base64_text(ekey.encode("latin-1")):
            raise FormatError("QTag EKey 非法")
        return Footer(payload_len + 8, ekey, "QTag", resource_id=int(parts[1]))

    if tail.endswith(b"musicex\x00"):
        payload = tail[:-8]
        if len(payload) < 4:
            raise FormatError("MusicEx 过短")
        data, version_bytes = payload[:-4], payload[-4:]
        if int.from_bytes(version_bytes, "little") != 1:
            raise UnsupportedError("MusicEx 版本不支持")
        if len(data) < 4:
            raise FormatError("MusicEx 过短")
        inner_src, len_bytes = data[:-4], data[-4:]
        payload_len = int.from_bytes(len_bytes, "little")
        if payload_len != MUSICEX_BLOCK:
            raise FormatError(f"MusicEx 长度非法 0x{payload_len:X}")
        inner = inner_src[len(inner_src) - (payload_len - 0x10) :]
        mid = _read_utf16le(inner[12 : 12 + 60])
        media_filename = _read_utf16le(inner[12 + 60 : 12 + 60 + 100])
        return Footer(MUSICEX_BLOCK + 12, None, "MusicEx", mid=mid, media_filename=media_filename)

    payload, size_bytes = tail[:-4], tail[-4:]
    payload_len = int.from_bytes(size_bytes, "little")
    if payload_len > MAX_EKEY_LEN:
        return None
    if len(payload) < payload_len:
        raise FormatError("PcV1Legacy 长度不一致")
    ekey_bytes = payload[len(payload) - payload_len :]
    zero = ekey_bytes.find(b"\x00")
    if zero != -1:
        ekey_bytes = ekey_bytes[:zero]
    if not _is_base64_text(ekey_bytes):
        raise FormatError("PcV1Legacy EKey 非法")
    return Footer(payload_len + 4, ekey_bytes.decode("latin-1"), "PcV1Legacy")


def read_footer(path: Path) -> Footer | None:
    size = path.stat().st_size
    if size < 12:
        return None
    with path.open("rb") as fp:
        fp.seek(max(0, size - FOOTER_SAMPLE))
        tail = fp.read(FOOTER_SAMPLE)
    return parse_footer(tail)


_DB_TABLES = (
    ("audio_file_ekey_table", "file_path", "ekey"),
    ("EKeyFileInfo", "filePath", "eKey"),
    ("p2p_cache_info_table", "file_id", "ekey"),
)


def list_ekeys(db_path: Path, find: str | None = None) -> list[tuple[str, str]]:
    """列出 QQ 音乐安卓端密钥库中的条目。"""
    if not db_path.exists():
        raise FileNotFoundError(f"密钥库不存在: {db_path}")
    result: list[tuple[str, str]] = []
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table, path_col, key_col in _DB_TABLES:
            if table not in tables:
                continue
            for path, ekey in conn.execute(f"SELECT {path_col}, {key_col} FROM {table}"):
                if path is None or ekey is None:
                    continue
                base = Path(str(path)).name
                if find and find not in base and find not in str(path):
                    continue
                result.append((base, str(ekey).strip()))
    finally:
        conn.close()
    return result


def lookup_ekey(db_path: Path, *names: str | None) -> str | None:
    candidates = [Path(str(name)).name for name in names if name]
    candidates += [str(name) for name in names if name]
    if not db_path.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return None
    try:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table, path_col, key_col in _DB_TABLES:
            if table not in tables:
                continue
            for path, ekey in conn.execute(f"SELECT {path_col}, {key_col} FROM {table}"):
                if path is None or ekey is None:
                    continue
                path_text = str(path)
                if Path(path_text).name in candidates:
                    return str(ekey).strip()
                for candidate in candidates:
                    if len(candidate) >= 8 and candidate in path_text:
                        return str(ekey).strip()
    finally:
        conn.close()
    return None


class QmcDecoder(Decoder):
    name = "QQ 音乐 QMC"
    extensions = frozenset(V1_EXTS | V2_EXTS)

    def decode_to(
        self,
        path: Path,
        out: BinaryIO,
        opts: DecodeOptions,
        progress=None,
    ) -> DecodeResult:
        ext = path.suffix.lower()
        size = path.stat().st_size
        if ext in V1_EXTS:
            return self._decode_v1(path, out, size, progress)

        footer = None
        try:
            footer = read_footer(path)
        except Exception:
            footer = None
        if footer is None:
            if self._is_static_v1(path):
                return self._decode_v1(path, out, size, progress)
            raise FormatError(f"{path.name}: 未找到 QMC 尾包或静态密钥特征")

        ekey = footer.ekey or opts.ekey
        if not ekey and opts.ekey_db is not None:
            ekey = lookup_ekey(
                opts.ekey_db,
                path.name,
                footer.mid,
                footer.media_filename,
                str(footer.resource_id) if footer.resource_id else None,
            )
        if not ekey:
            raise KeyMissingError(
                f"{path.name}: {footer.kind} 类型无内嵌密钥。"
                "请提供 EKey、player_process_db 密钥库，或使用含内嵌密钥的旧版客户端文件。"
            )
        master = derive_master_key(ekey.encode("latin-1"))
        stream = make_qmc2_stream(master)
        audio_length = size - footer.size
        if audio_length <= 0:
            raise FormatError(f"{path.name}: QMC 音频长度非法")
        with path.open("rb") as fp:
            first = fp.read(64)
            first_decoded = stream.decrypt(first, 0)
            container = sniff_container(first_decoded)
            out.write(first_decoded)
            qmc2_stream_file(
                fp,
                audio_length,
                out,
                stream,
                start_offset=len(first),
                progress=progress,
            )
        return DecodeResult(container=container, source=f"qmc-v2:{footer.kind}")

    def _decode_v1(self, path: Path, out: BinaryIO, size: int, progress) -> DecodeResult:
        with path.open("rb") as fp:
            first = fp.read(64)
            first_decoded = qmc1_transform(first, V1_STATIC_KEY)
            container = sniff_container(first_decoded)
            out.write(first_decoded)
            progress_inner = (
                (lambda done, total, phase: progress(len(first) + done, size, phase))
                if progress
                else None
            )
            qmc1_transform_file(
                fp,
                size,
                out,
                V1_STATIC_KEY,
                offset_start=len(first),
                progress=progress_inner,
            )
        return DecodeResult(container=container, source="qmc-v1")

    @staticmethod
    def _is_static_v1(path: Path) -> bool:
        try:
            with path.open("rb") as fp:
                return sniff_container(qmc1_transform(fp.read(64), V1_STATIC_KEY)) != "bin"
        except Exception:
            return False
