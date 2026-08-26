"""合成加密样本构造器，用于验证四个格式的解密正确性。

样本均为人工构造的占位音频数据，不包含任何版权内容。
"""

from __future__ import annotations

import base64
import json
import lzma
import struct
from pathlib import Path

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

from musickey.ciphers import (
    EKEY_V2_KEY1,
    EKEY_V2_KEY2,
    TEA_DELTA,
    TEA_ROUNDS,
    compress_key,
    make_qmc2_stream,
    qmc1_transform,
    simple_key_8,
)
from musickey.formats.kgm import HEADER_LEN, KGM_MAGIC, MEND_TABLE
from musickey.formats.qmc import V1_STATIC_KEY

PLAIN = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 4096 + b"music-key-marker"
NCM_CORE_KEY = b"hzHRAmso5kInbaxW"
NCM_META_KEY = b"#14ljk_!\\]&0U<'("


def _f32(value: float) -> float:
    return struct.unpack("f", struct.pack("f", value))[0]


def _tea_mix(value, s, k1, k2):
    return ((((value << 4) & 0xFFFFFFFF) + k1) ^ ((value >> 5) + k2) ^ ((s + value) & 0xFFFFFFFF)) & 0xFFFFFFFF


def _tea_encrypt_block(block: int, words) -> int:
    hi = (block >> 32) & 0xFFFFFFFF
    lo = block & 0xFFFFFFFF
    s = 0
    for _ in range(TEA_ROUNDS):
        s = (s + TEA_DELTA) & 0xFFFFFFFF
        hi = (hi + _tea_mix(lo, s, words[0], words[1])) & 0xFFFFFFFF
        lo = (lo + _tea_mix(hi, s, words[2], words[3])) & 0xFFFFFFFF
    return (hi << 32) | lo


def tea_cbc_encrypt(plaintext: bytes, key16: bytes, salt: bytes) -> bytes:
    words = struct.unpack(">IIII", key16)
    out_len = 10 + len(plaintext)
    pad_len = (8 - (out_len & 7)) & 7
    header_len = 1 + pad_len + 2
    out_len += pad_len
    header = bytearray(16)
    header[:header_len] = salt[:header_len]
    header[0] = (header[0] & ~7) | pad_len
    copy_len = min(16 - header_len, len(plaintext))
    header[header_len : header_len + copy_len] = plaintext[:copy_len]
    rest = plaintext[copy_len:]
    iv1 = 0
    iv2 = 0
    out = bytearray(out_len)

    def round_enc(block: bytes) -> bytes:
        nonlocal iv1, iv2
        b = int.from_bytes(block, "big")
        iv2_next = (b ^ iv1) & 0xFFFFFFFFFFFFFFFF
        c = (_tea_encrypt_block(iv2_next, words) ^ iv2) & 0xFFFFFFFFFFFFFFFF
        iv1 = c
        iv2 = iv2_next
        return c.to_bytes(8, "big")

    out[0:8] = round_enc(bytes(header[0:8]))
    out[8:16] = round_enc(bytes(header[8:16]))
    pos = 16
    while len(rest) >= 8:
        out[pos : pos + 8] = round_enc(rest[:8])
        rest = rest[8:]
        pos += 8
    if rest:
        out[pos : pos + 8] = round_enc(rest + b"\x00" * (8 - len(rest)))
    return bytes(out[:out_len])


def make_ekey_v1(master_key: bytes, salt: bytes = b"\x00" * 10) -> str:
    header = master_key[:8]
    tea_key = bytearray()
    for sk, hk in zip(simple_key_8(), header):
        tea_key += bytes((sk, hk))
    cipher = tea_cbc_encrypt(master_key[8:], bytes(tea_key), salt)
    return base64.b64encode(header + cipher).decode()


def make_ekey_v2(master_key: bytes, salt: bytes = b"\x00" * 10) -> str:
    inner = make_ekey_v1(master_key, salt)
    layer = tea_cbc_encrypt(inner.encode(), EKEY_V2_KEY2, salt)
    layer = tea_cbc_encrypt(layer, EKEY_V2_KEY1, salt)
    prefix = base64.b64encode(b"QQMusic EncV2,Key:").decode()
    return prefix + base64.b64encode(layer).decode()


def build_ncm(plain: bytes, rc4_key: bytes, meta: dict | None = None, cover: bytes | None = None) -> bytes:
    meta = meta or {"format": "mp3", "musicName": "合成测试", "artist": [["测试歌手", 1]], "album": "测试专辑"}
    key_plain = pad(b"neteasecloudmusic" + rc4_key, 16)
    key_blob = bytes(value ^ 0x64 for value in AES.new(NCM_CORE_KEY, AES.MODE_ECB).encrypt(key_plain))
    meta_enc = AES.new(NCM_META_KEY, AES.MODE_ECB).encrypt(pad(b"music:" + json.dumps(meta, separators=(",", ":")).encode(), 16))
    meta_blob = bytes(value ^ 0x63 for value in (b"163 key(Don't modify):" + base64.b64encode(meta_enc)))
    if cover is None:
        image = struct.pack("<II", 0, 0)
    else:
        image = struct.pack("<II", len(cover), len(cover)) + cover
    sbox = bytearray(range(256))
    j = 0
    for index in range(256):
        j = (j + sbox[index] + rc4_key[index % len(rc4_key)]) & 0xFF
        sbox[index], sbox[j] = sbox[j], sbox[index]
    box = bytes(sbox[(sbox[index] + sbox[(index + sbox[index]) & 0xFF]) & 0xFF] for index in range(256))
    stream = (box * ((len(plain) + 256) // 256 + 2))[1 : 1 + len(plain)]
    audio = (int.from_bytes(plain, "little") ^ int.from_bytes(stream, "little")).to_bytes(len(plain), "little")
    out = bytearray(b"CTENFDAM\x00\x00")
    out += struct.pack("<I", len(key_blob)) + key_blob
    out += struct.pack("<I", len(meta_blob)) + meta_blob
    out += b"\x00" * 5
    out += image
    out += audio
    return bytes(out)


def build_qmc_v1(plain: bytes) -> bytes:
    return qmc1_transform(plain, V1_STATIC_KEY)


def build_qmc_v2(plain: bytes, master_key: bytes, ekey: str, tag: bytes = b"QTag", resource_id: int = 1) -> bytes:
    enc = make_qmc2_stream(master_key).decrypt(plain)
    footer = f"{ekey},{resource_id},2".encode() + struct.pack(">I", len(f"{ekey},{resource_id},2"))
    return enc + footer + tag


def build_stag(plain: bytes, master_key: bytes, resource_id: int = 123, media_mid: str = "003TestMid") -> bytes:
    enc = make_qmc2_stream(master_key).decrypt(plain)
    csv = f"{resource_id},2,{media_mid}".encode()
    return enc + csv + struct.pack(">I", len(csv)) + b"STag"


def build_kgm(plain: bytes, pub_key: bytes, crypto_test: bytes = bytes(range(16))) -> bytes:
    own_key = crypto_test + b"\x00"
    own_inv = []
    for key in own_key:
        table = [0] * 256
        for value in range(256):
            low = value & 0x0F
            high = (value >> 4) & 0x0F
            table[value] = (((high ^ low) << 4) | low) ^ key
        own_inv.append(table)
    enc = bytearray(len(plain))
    for index, value in enumerate(plain):
        public = pub_key[index >> 4]
        masked = value ^ _scramble(public ^ MEND_TABLE[index % len(MEND_TABLE)])
        enc[index] = own_inv[index % 17][masked]
    header = bytearray(HEADER_LEN)
    header[:16] = KGM_MAGIC
    struct.pack_into("<III", header, 0x10, HEADER_LEN, 3, 1)
    header[0x1C:0x2C] = crypto_test
    return bytes(header) + bytes(enc)


def _scramble(value: int) -> int:
    return value ^ ((value & 0x0F) << 4)


def build_kwm(plain: bytes, key: bytes = bytes(range(1, 33))) -> bytes:
    head = b"yeelion-kuwo" + b"\x00" * (1024 - len("yeelion-kuwo"))
    enc = bytes(value ^ key[index & 31] for index, value in enumerate(plain))
    return head + enc


def load_kgm_pub_key() -> bytes:
    return lzma.decompress(Path(__file__).resolve().parents[1].joinpath("musickey", "assets", "kugou_key.xz").read_bytes())
