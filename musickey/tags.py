"""标签与封面读写（基于 mutagen，支持 MP3 / FLAC / M4A / OGG / WAV）。"""

from __future__ import annotations

from pathlib import Path


def _image_mime(cover: bytes) -> str:
    return "image/png" if cover[:4] == b"\x89PNG" else "image/jpeg"


def _cover_format(cover: bytes) -> str:
    return "png" if cover[:4] == b"\x89PNG" else "jpeg"


def read_metadata(path: Path, container: str) -> tuple[dict[str, str], bytes | None]:
    """尽力读取现有标签与封面；失败时返回空数据。"""
    try:
        if container == "mp3":
            from mutagen.id3 import ID3

            tags = ID3(path)
            result = {
                "title": str(tags["TIT2"].text[0]) if tags.get("TIT2") else "",
                "artist": str(tags["TPE1"].text[0]) if tags.get("TPE1") else "",
                "album": str(tags["TALB"].text[0]) if tags.get("TALB") else "",
            }
            cover = None
            for key in tags.keys():
                if key.startswith("APIC"):
                    cover = bytes(tags[key].data)
                    break
            return {key: value for key, value in result.items() if value}, cover
        if container == "flac":
            from mutagen.flac import FLAC

            audio = FLAC(path)
            result = {key: audio.get(key, [None])[0] for key in ("title", "artist", "album") if audio.get(key)}
            cover = bytes(audio.pictures[0].data) if audio.pictures else None
            return {key: str(value) for key, value in result.items() if value}, cover
        if container == "m4a":
            from mutagen.mp4 import MP4

            audio = MP4(path)
            mapping = {"\xa9nam": "title", "\xa9ART": "artist", "\xa9alb": "album"}
            result = {name: (audio.get(atom) or [None])[0] for atom, name in mapping.items() if audio.get(atom)}
            cover = bytes(audio["covr"][0]) if audio.get("covr") else None
            return {key: str(value) for key, value in result.items() if value}, cover
        if container == "ogg":
            from mutagen.oggvorbis import OggVorbis

            audio = OggVorbis(path)
            result = {key: audio.get(key, [None])[0] for key in ("title", "artist", "album") if audio.get(key)}
            return {key: str(value) for key, value in result.items() if value}, None
        if container == "wav":
            from mutagen.wave import WAVE

            audio = WAVE(path)
            result = {key: audio.tags.get(key, [None])[0] for key in ("title", "artist", "album") if audio.tags and audio.tags.get(key)}
            return {key: str(value) for key, value in result.items() if value}, None
    except Exception:
        pass
    return {}, None


def embed(container: str, path: Path, tags: dict[str, str], cover: bytes | None) -> None:
    """把标签与封面写入音频文件；不支持的容器静默忽略。"""
    if not tags and not cover:
        return
    try:
        if container == "mp3":
            from mutagen.id3 import APIC, ID3, TALB, TIT2, TPE1

            try:
                audio = ID3(path)
            except Exception:
                audio = ID3()
            for frame, value in (
                (TIT2, tags.get("title")),
                (TPE1, tags.get("artist")),
                (TALB, tags.get("album")),
            ):
                if value:
                    audio.add(frame(encoding=3, text=value))
            if cover:
                audio.delall("APIC")
                audio.add(APIC(encoding=3, mime=_image_mime(cover), type=3, desc="cover", data=cover))
            audio.save(path)
        elif container == "flac":
            from mutagen.flac import FLAC, Picture

            audio = FLAC(path)
            for key in ("title", "artist", "album"):
                if tags.get(key):
                    audio[key] = tags[key]
            if cover:
                picture = Picture()
                picture.type = 3
                picture.mime = _image_mime(cover)
                picture.data = cover
                audio.clear_pictures()
                audio.add_picture(picture)
            audio.save()
        elif container == "m4a":
            from mutagen.mp4 import MP4, MP4Cover

            audio = MP4(path)
            mapping = {"title": "\xa9nam", "artist": "\xa9ART", "album": "\xa9alb"}
            for key, atom in mapping.items():
                if tags.get(key):
                    audio[atom] = [tags[key]]
            if cover:
                image_format = MP4Cover.FORMAT_PNG if _cover_format(cover) == "png" else MP4Cover.FORMAT_JPEG
                audio["covr"] = [MP4Cover(cover, imageformat=image_format)]
            audio.save()
        elif container == "ogg":
            from mutagen.oggvorbis import OggVorbis

            audio = OggVorbis(path)
            for key in ("title", "artist", "album"):
                if tags.get(key):
                    audio[key] = [tags[key]]
            audio.save()
        elif container == "wav":
            from mutagen.wave import WAVE

            audio = WAVE(path)
            for key in ("title", "artist", "album"):
                if tags.get(key):
                    audio.tags[key] = [tags[key]]
            audio.save()
    except Exception:
        # 标签写入失败不应导致音频丢失；保留原始输出。
        return
