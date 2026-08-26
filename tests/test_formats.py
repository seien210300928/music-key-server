"""四个格式的最小往返测试。"""

from __future__ import annotations

from pathlib import Path

from musickey.formats.base import DecodeOptions
from musickey.formats.kgm import KgmDecoder
from musickey.formats.kwm import KwmDecoder
from musickey.formats.ncm import NcmDecoder
from musickey.formats.qmc import QmcDecoder

from builders import (
    PLAIN,
    build_kgm,
    build_kwm,
    build_ncm,
    build_qmc_v1,
    build_qmc_v2,
    build_stag,
    load_kgm_pub_key,
    make_ekey_v1,
    make_ekey_v2,
)


def _write(tmp_path: Path, name: str, data: bytes) -> Path:
    path = tmp_path / name
    path.write_bytes(data)
    return path


def test_ncm_roundtrip(tmp_path):
    result = NcmDecoder().decode(_write(tmp_path, "sample.ncm", build_ncm(PLAIN, b"0123456789abcdef")), DecodeOptions())
    assert result.payload == PLAIN
    assert result.container == "mp3"
    assert result.tags["title"] == "合成测试"


def test_qmc_v1_roundtrip(tmp_path):
    result = QmcDecoder().decode(_write(tmp_path, "sample.tkm", build_qmc_v1(PLAIN)), DecodeOptions())
    assert result.payload == PLAIN
    assert result.container == "mp3"


def test_qmc_v2_map_and_rc4(tmp_path):
    master = bytes(range(24))
    path = _write(tmp_path, "sample.mgg", build_qmc_v2(PLAIN, master, make_ekey_v1(master)))
    assert QmcDecoder().decode(path, DecodeOptions()).payload == PLAIN

    master = bytes((index * 7 + 3) & 0xFF for index in range(512))
    path = _write(tmp_path, "sample.mflac", build_qmc_v2(PLAIN, master, make_ekey_v2(master)))
    assert QmcDecoder().decode(path, DecodeOptions()).payload == PLAIN


def test_qmc_stag_with_ekey(tmp_path):
    master = bytes(range(24))
    path = _write(tmp_path, "sample.mflac", build_stag(PLAIN, master))
    assert QmcDecoder().decode(path, DecodeOptions(ekey=make_ekey_v1(master))).payload == PLAIN


def test_kgm_roundtrip(tmp_path):
    pub = load_kgm_pub_key()
    result = KgmDecoder().decode(_write(tmp_path, "sample.kgm", build_kgm(PLAIN, pub)), DecodeOptions())
    assert result.payload == PLAIN
    assert result.container == "mp3"


def test_kwm_roundtrip(tmp_path):
    result = KwmDecoder().decode(_write(tmp_path, "sample.kwm", build_kwm(PLAIN)), DecodeOptions())
    assert result.payload == PLAIN
    assert result.container == "mp3"
