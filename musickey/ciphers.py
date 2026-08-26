"""密码学基础件：XOR、QMC v1/v2、Tencent TEA 与 NCM 密钥流。

实现参考公开格式规范与 MIT 许可社区项目；这里的代码按可读性和流式处理
重新组织，批量音频不再需要一次性读入内存。
"""

from __future__ import annotations

import base64
import math
import struct
from typing import BinaryIO


KEY_LEN = 128
QMC1_BOUNDARY = 0x7FFF


def xor_repeat(data: bytearray, key: bytes, phase: int = 0, *, start: int = 0, length: int | None = None) -> None:
    """把 ``data[start:start+length]`` 与循环 key 就地异或。"""
    end = len(data) if length is None else start + length
    key_len = len(key)
    if key_len == 0:
        return
    shift = phase % key_len
    for index in range(start, end):
        data[index] ^= key[(shift + index - start) % key_len]


def xor_key_stream(data: bytes, key: bytes) -> bytes:
    """整段数据与循环密钥流异或，适用于小型块。"""
    if not data:
        return b""
    if not key:
        raise ValueError("密钥不能为空")
    reps = (len(data) + len(key) - 1) // len(key)
    stream = (key * reps)[: len(data)]
    return (int.from_bytes(data, "little") ^ int.from_bytes(stream, "little")).to_bytes(
        len(data), "little"
    )


# ---------------------------------------------------------------------------
# QMC v1
# ---------------------------------------------------------------------------


def qmc1_transform(data: bytes, key: bytes, offset_start: int = 0) -> bytes:
    """QMC v1 变换；绝对偏移 <= 0x7FFF 与 > 0x7FFF 使用不同取模规则。"""
    out = bytearray(data)
    pos = offset_start
    index = 0
    total = len(out)
    while index < total:
        if pos <= QMC1_BOUNDARY:
            take = min(QMC1_BOUNDARY + 1 - pos, total - index)
            phase = pos % KEY_LEN
        else:
            phase = (pos % QMC1_BOUNDARY) % KEY_LEN
            take = min(QMC1_BOUNDARY - (pos % QMC1_BOUNDARY), total - index)
        if phase:
            base = key[phase:] + key[:phase]
        else:
            base = key
        out[index : index + take] = xor_key_stream(bytes(out[index : index + take]), base)
        index += take
        pos += take
    return bytes(out)


def qmc1_transform_file(
    src: BinaryIO,
    src_total: int,
    dst: BinaryIO,
    key: bytes,
    offset_start: int = 0,
    chunk_size: int = 1024 * 1024,
    progress=None,
) -> None:
    """流式执行 QMC v1 变换，内存占用固定为 chunk_size。"""
    position = 0
    remaining = max(0, src_total - offset_start)
    while remaining:
        chunk = src.read(min(chunk_size, remaining))
        if not chunk:
            break
        dst.write(qmc1_transform(chunk, key, offset_start + position))
        position += len(chunk)
        remaining -= len(chunk)
        if progress:
            progress(position, src_total - offset_start, "decrypt")


# ---------------------------------------------------------------------------
# Tencent TEA
# ---------------------------------------------------------------------------

TEA_DELTA = 0x9E3779B9
TEA_ROUNDS = 16
TEA_SALT_LEN = 2
TEA_ZERO_LEN = 7


def _tea_mix(value: int, s: int, k1: int, k2: int) -> int:
    left = ((value << 4) & 0xFFFFFFFF) + k1
    right = (value >> 5) + k2
    mid = (s + value) & 0xFFFFFFFF
    return (left ^ mid ^ right) & 0xFFFFFFFF


def tea_decrypt_block(block: int, key_words: tuple[int, int, int, int]) -> int:
    hi = (block >> 32) & 0xFFFFFFFF
    lo = block & 0xFFFFFFFF
    s = (TEA_DELTA * TEA_ROUNDS) & 0xFFFFFFFF
    for _ in range(TEA_ROUNDS):
        lo = (lo - _tea_mix(hi, s, key_words[2], key_words[3])) & 0xFFFFFFFF
        hi = (hi - _tea_mix(lo, s, key_words[0], key_words[1])) & 0xFFFFFFFF
        s = (s - TEA_DELTA) & 0xFFFFFFFF
    return (hi << 32) | lo


def tea_cbc_decrypt(ciphertext: bytes, key16: bytes) -> bytes:
    """Tencent TEA 变种 CBC 解密。"""
    words = struct.unpack(">IIII", key16)
    if len(ciphertext) % 8 != 0 or len(ciphertext) < 10:
        raise ValueError(f"TEA: 非法密文长度 {len(ciphertext)}")
    iv_prev = 0
    iv_cur = 0
    plain = bytearray()
    for start in range(0, len(ciphertext), 8):
        block = int.from_bytes(ciphertext[start : start + 8], "big")
        mixed = (block ^ iv_cur) & 0xFFFFFFFFFFFFFFFF
        next_iv = tea_decrypt_block(mixed, words)
        chunk = (next_iv ^ iv_prev) & 0xFFFFFFFFFFFFFFFF
        plain += chunk.to_bytes(8, "big")
        iv_prev = block
        iv_cur = next_iv
    pad = plain[0] & 0b111
    body_start = 1 + pad + TEA_SALT_LEN
    body_end = len(ciphertext) - TEA_ZERO_LEN
    if any(plain[body_end:]):
        raise ValueError("TEA: 尾部校验失败")
    return bytes(plain[body_start:body_end])


# ---------------------------------------------------------------------------
# QMC v2 EKey
# ---------------------------------------------------------------------------

EKEY_V2_PREFIX = base64.b64encode(b"QQMusic EncV2,Key:")
EKEY_V2_KEY1 = bytes(
    [0x33, 0x38, 0x36, 0x5A, 0x4A, 0x59, 0x21, 0x40, 0x23, 0x2A, 0x24, 0x25, 0x5E, 0x26, 0x29, 0x28]
)
EKEY_V2_KEY2 = bytes(
    [0x2A, 0x2A, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25, 0x26, 0x5E, 0x61, 0x31, 0x63, 0x5A, 0x2C, 0x54]
)


def _f32(value: float) -> float:
    return struct.unpack("f", struct.pack("f", value))[0]


def simple_key_8() -> bytes:
    out = bytearray()
    for index in range(8):
        value = abs(math.tan(_f32(106.0 + _f32(index * _f32(0.1)))))
        out.append(max(0, min(int(_f32(_f32(value) * 100.0)), 255)))
    return bytes(out)


_SIMPLE_KEY = simple_key_8()


def _ekey_v1(ekey: bytes) -> bytes:
    decoded = base64.b64decode(ekey)
    if len(decoded) < 8:
        raise ValueError("EKey v1: 解码后不足 8 字节")
    header, cipher = decoded[:8], decoded[8:]
    tea_key = bytearray()
    for simple, header_byte in zip(_SIMPLE_KEY, header):
        tea_key += bytes((simple, header_byte))
    return header + tea_cbc_decrypt(cipher, bytes(tea_key))


def derive_master_key(ekey: bytes) -> bytes:
    """从 EKey 派生 QMC v2 主密钥，兼容 EncV2 双层与 v1 单层。"""
    if ekey.startswith(EKEY_V2_PREFIX):
        payload = base64.b64decode(ekey[len(EKEY_V2_PREFIX) :])
        payload = tea_cbc_decrypt(payload, EKEY_V2_KEY1)
        payload = tea_cbc_decrypt(payload, EKEY_V2_KEY2)
        zero = payload.find(b"\x00")
        return _ekey_v1(payload if zero == -1 else payload[:zero])
    return _ekey_v1(ekey)


# ---------------------------------------------------------------------------
# QMC v2 流密码
# ---------------------------------------------------------------------------

MAP_LEN = 128
MAP_MAGIC = 71214
RC4_FIRST_SEGMENT = 0x80
RC4_SEGMENT = 0x1400
RC4_STREAM_CACHE = RC4_SEGMENT + 512


def compress_key(long_key: bytes) -> bytes:
    if not long_key:
        raise ValueError("Map 密钥为空")
    length = len(long_key)
    out = bytearray(MAP_LEN)
    for index in range(MAP_LEN):
        idx = (index * index + MAP_MAGIC) % length
        shift = (idx + 4) % 8
        out[index] = ((long_key[idx] << shift) | (long_key[idx] >> shift)) & 0xFF
    return bytes(out)


def qmc2_hash(key: bytes) -> float:
    hash_value = 1
    for value in key:
        if value == 0:
            continue
        next_value = (hash_value * value) & 0xFFFFFFFF
        if next_value == 0 or next_value <= hash_value:
            break
        hash_value = next_value
    return float(hash_value)


def segment_key(seg_id: int, seed: int, hash_value: float) -> int:
    if seed == 0:
        return 0
    denominator = ((seg_id + 1) * seed) & 0xFFFFFFFFFFFFFFFF
    return int(hash_value / float(denominator) * 100.0)


class MapStream:
    """短主密钥（<=300 字节）的 Map 流密码。"""

    def __init__(self, master_key: bytes):
        self.key = compress_key(master_key)

    def decrypt(self, data: bytes, offset: int = 0) -> bytes:
        return qmc1_transform(data, self.key, offset)


class Rc4Stream:
    """长主密钥（>300 字节）的分段 RC4 流密码。"""

    def __init__(self, master_key: bytes):
        self.key = bytes(master_key)
        length = len(self.key)
        state = [index & 0xFF for index in range(length)]
        j = 0
        for index in range(length):
            j = (j + state[index] + self.key[index % length]) % length
            state[index], state[j] = state[j], state[index]
        self.state = state
        self.n = length
        self._i = 0
        self._j = 0
        self.hash = qmc2_hash(self.key)
        # 预生成分段查询流；流密码与位置一一对应，后续可按 offset 切片。
        self.key_stream = bytes(self._next_byte() for _ in range(RC4_STREAM_CACHE))

    def _next_byte(self) -> int:
        n = self.n
        self._i = (self._i + 1) % n
        self._j = (self._j + self.state[self._i]) % n
        self.state[self._i], self.state[self._j] = self.state[self._j], self.state[self._i]
        return self.state[(self.state[self._i] + self.state[self._j]) % n]

    def decrypt(self, data: bytes, offset: int = 0) -> bytes:
        out = bytearray(data)
        n = len(self.key)
        total = len(out)
        pos = offset
        start = 0
        if pos < RC4_FIRST_SEGMENT:
            take = min(RC4_FIRST_SEGMENT - pos, total)
            for j in range(take):
                p = pos + j
                out[j] ^= self.key[segment_key(p, self.key[p % n], self.hash) % n]
            start += take
            pos += take
        while start < total:
            seg_id = pos // RC4_SEGMENT
            block_off = pos % RC4_SEGMENT
            seed = self.key[seg_id % n]
            skip = segment_key(seg_id, seed, self.hash) & 0x1FF
            take = min(RC4_SEGMENT - block_off, total - start)
            stream = self.key_stream[skip + block_off : skip + block_off + take]
            out[start : start + take] = xor_key_stream(bytes(out[start : start + take]), stream)
            start += take
            pos += take
        return bytes(out)


def make_qmc2_stream(master_key: bytes) -> MapStream | Rc4Stream:
    """按主密钥长度选择 Map 或 RC4 流密码。"""
    if not master_key:
        raise ValueError("主密钥为空")
    if len(master_key) <= 300:
        return MapStream(master_key)
    return Rc4Stream(master_key)


def qmc2_stream_file(
    src: BinaryIO,
    src_total: int,
    dst: BinaryIO,
    stream: MapStream | Rc4Stream,
    start_offset: int = 0,
    chunk_size: int = 1024 * 1024,
    progress=None,
) -> None:
    position = start_offset
    remaining = max(0, src_total - start_offset)
    while remaining:
        chunk = src.read(min(chunk_size, remaining))
        if not chunk:
            break
        dst.write(stream.decrypt(chunk, position))
        position += len(chunk)
        remaining -= len(chunk)
        if progress:
            progress(position - start_offset, src_total - start_offset, "decrypt")


# ---------------------------------------------------------------------------
# NCM 密钥流
# ---------------------------------------------------------------------------


def ncm_stream_bytes(key: bytes) -> bytes:
    sbox = bytearray(range(256))
    j = 0
    key_len = len(key)
    for index in range(256):
        j = (j + sbox[index] + key[index % key_len]) & 0xFF
        sbox[index], sbox[j] = sbox[j], sbox[index]
    box = bytearray(256)
    for index in range(256):
        box[index] = sbox[(sbox[index] + sbox[(index + sbox[index]) & 0xFF]) & 0xFF]
    return bytes(box)


def xor_ncm_file(
    src: BinaryIO,
    src_total: int,
    dst: BinaryIO,
    box: bytes,
    start_offset: int = 0,
    chunk_size: int = 1024 * 1024,
    progress=None,
) -> None:
    """流式还原 NCM 音频：音频第 i 字节使用 box[(i+1)&0xFF]。"""
    position = start_offset
    remaining = max(0, src_total - start_offset)
    while remaining:
        chunk = src.read(min(chunk_size, remaining))
        if not chunk:
            break
        out = bytearray(len(chunk))
        for index, value in enumerate(chunk):
            out[index] = value ^ box[(position + index + 1) & 0xFF]
        dst.write(out)
        position += len(chunk)
        remaining -= len(chunk)
        if progress:
            progress(position - start_offset, src_total - start_offset, "decrypt")
