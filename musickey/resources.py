"""打包/源码两种运行模式下的资源路径解析。"""

from __future__ import annotations

import sys
from pathlib import Path


def bundled_path(relative: str) -> Path:
    """优先读取 PyInstaller 解包目录，其次读取源码树。"""
    freeze_root = Path(getattr(sys, "_MEIPASS", "")).resolve() if hasattr(sys, "_MEIPASS") else None
    if freeze_root:
        candidate = freeze_root / relative
        if candidate.exists():
            return candidate
    return Path(__file__).resolve().parent / relative


def asset_path(name: str) -> Path:
    return bundled_path(f"assets/{name}")
