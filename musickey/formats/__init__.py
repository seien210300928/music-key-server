"""格式注册与自动识别。"""

from __future__ import annotations

from pathlib import Path

from ..errors import UnsupportedError
from .base import DecodeOptions, Decoder
from .kgm import KgmDecoder, KGM_MAGIC, VPR_MAGIC
from .kwm import KwmDecoder
from .ncm import MAGIC as NCM_MAGIC
from .ncm import NcmDecoder
from .qmc import QmcDecoder, parse_footer


DECODERS: tuple[Decoder, ...] = (NcmDecoder(), QmcDecoder(), KgmDecoder(), KwmDecoder())

# 精确匹配优先，长后缀（如 .kgm.flac）放在前面
_EXT_INDEX: dict[str, Decoder] = {}
for _decoder in DECODERS:
    for _ext in sorted(_decoder.extensions, key=len, reverse=True):
        _EXT_INDEX[_ext] = _decoder


def _exported_variants(name: str) -> tuple[str, ...]:
    lower = name.lower()
    for ext in sorted(_EXT_INDEX, key=len, reverse=True):
        if lower.endswith(ext):
            return (ext,)
    return ()


def decoder_for(path: Path) -> Decoder:
    """优先按完整后缀识别，不能识别时使用魔数/尾包嗅探。"""
    variants = _exported_variants(path.name)
    if variants:
        return _EXT_INDEX[variants[0]]
    if path.suffix.lower() in _EXT_INDEX:
        return _EXT_INDEX[path.suffix.lower()]

    with path.open("rb") as fp:
        head = fp.read(16)
        size = path.stat().st_size
        tail: bytes | None = None
        if size >= 12:
            fp.seek(max(0, size - 4096))
            tail = fp.read(4096)
    if head[:8] == NCM_MAGIC:
        return _EXT_INDEX[".ncm"]
    if head[:16] in (KGM_MAGIC, VPR_MAGIC):
        return _EXT_INDEX[".kgm"]
    if tail and parse_footer(tail) is not None:
        return _EXT_INDEX[".mflac"]
    raise UnsupportedError(f"{path.name}: 无法识别的加密格式（扩展名 {path.suffix or '未知'}）")


def pick_decoder(path: Path) -> Decoder:
    """兼容旧名称。"""
    return decoder_for(path)


def supported_extensions() -> frozenset[str]:
    return frozenset(_EXT_INDEX)


def supported_summary() -> dict[str, str]:
    return {
        decoder.name: ", ".join(sorted(decoder.extensions))
        for decoder in DECODERS
    }
