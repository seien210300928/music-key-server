"""统一异常类型。"""

from __future__ import annotations


class MusicKeyError(Exception):
    """所有 MusicKey 错误的基类。"""


class FormatError(MusicKeyError):
    """文件头或结构不符合预期格式。"""


class KeyMissingError(MusicKeyError):
    """密钥缺失或无法推导。"""


class UnsupportedError(MusicKeyError):
    """已知但暂不支持的格式变体。"""


class JobCancelledError(MusicKeyError):
    """任务已被用户取消。"""
