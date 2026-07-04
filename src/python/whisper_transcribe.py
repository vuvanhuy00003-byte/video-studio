#!/usr/bin/env python3
"""Vendored faster-whisper entrypoint for Vibe Tool Video.

This script is intentionally tiny and explicit so it can be packed by
PyInstaller into vendor/whisper/<platform>/whisper-transcribe.
"""

from __future__ import annotations

import argparse
import json
import multiprocessing
import os
import sys
from pathlib import Path

MODEL_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v1": "Systran/faster-whisper-large-v1",
    "large-v2": "Systran/faster-whisper-large-v2",
    "large-v3": "Systran/faster-whisper-large-v3",
}


def import_whisper_model():
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as exc:  # pragma: no cover - surfaced to Node stderr
        print(f"Unable to import faster_whisper: {exc}", file=sys.stderr)
        raise
    return WhisperModel


def format_srt_time(seconds: float) -> str:
    total_ms = max(0, int(round(float(seconds or 0) * 1000)))
    hh, rem = divmod(total_ms, 3_600_000)
    mm, rem = divmod(rem, 60_000)
    ss, ms = divmod(rem, 1000)
    return f"{hh:02d}:{mm:02d}:{ss:02d},{ms:03d}"


def clean_text(value: object) -> str:
    return str(value or "").replace("\n", " ").strip()


def safe_model_dir_name(model_size: str) -> str:
    normalized = (model_size or "small").strip().replace("\\", "/").rstrip("/")
    if "/" in normalized:
        return normalized.split("/")[-1].replace(":", "-")
    return f"faster-whisper-{normalized}"


def local_model_dir(args: argparse.Namespace) -> Path:
    return Path(args.model_dir).expanduser().resolve() / safe_model_dir_name(args.model_size)


def repo_id_for_model(model_size: str) -> str:
    normalized = (model_size or "small").strip()
    if "/" in normalized:
        return normalized
    return MODEL_REPOS.get(normalized, f"Systran/faster-whisper-{normalized}")


def resolve_model_name_or_path(args: argparse.Namespace) -> str:
    explicit_path = Path(args.model_size).expanduser()
    if explicit_path.exists():
        return str(explicit_path.resolve())
    local_dir = local_model_dir(args)
    if (local_dir / "model.bin").exists() and (local_dir / "config.json").exists():
        return str(local_dir)
    return args.model_size


def write_srt(segments: list[object], output_srt: Path) -> None:
    lines: list[str] = []
    index = 1
    for segment in segments:
        text = clean_text(getattr(segment, "text", ""))
        if not text:
            continue
        start = float(getattr(segment, "start", 0) or 0)
        end = max(start + 0.05, float(getattr(segment, "end", start + 0.05) or start + 0.05))
        lines.extend([
            str(index),
            f"{format_srt_time(start)} --> {format_srt_time(end)}",
            text,
            "",
        ])
        index += 1
    output_srt.parent.mkdir(parents=True, exist_ok=True)
    output_srt.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def collect_words(segments: list[object]) -> list[dict[str, object]]:
    words: list[dict[str, object]] = []
    for segment in segments:
        for word in getattr(segment, "words", None) or []:
            text = clean_text(getattr(word, "word", ""))
            if not text:
                continue
            start = float(getattr(word, "start", 0) or 0)
            end = max(start + 0.03, float(getattr(word, "end", start + 0.03) or start + 0.03))
            words.append({
                "word": text,
                "start": start,
                "end": end,
                "probability": float(getattr(word, "probability", 0) or 0),
            })
    return words


def build_model(args: argparse.Namespace):
    WhisperModel = import_whisper_model()
    model_dir = Path(args.model_dir).expanduser().resolve()
    model_dir.mkdir(parents=True, exist_ok=True)
    return WhisperModel(
        resolve_model_name_or_path(args),
        device=args.device,
        compute_type=args.compute_type,
        download_root=str(model_dir),
    )


def download_model_files(args: argparse.Namespace) -> Path:
    try:
        from huggingface_hub import snapshot_download  # type: ignore
    except Exception:
        # If huggingface_hub is not importable for some reason, WhisperModel can
        # still trigger the standard faster-whisper download path.
        build_model(args)
        return local_model_dir(args)

    destination = local_model_dir(args)
    destination.mkdir(parents=True, exist_ok=True)
    kwargs = {
        "repo_id": repo_id_for_model(args.model_size),
        "local_dir": str(destination),
    }
    try:
        snapshot_download(**kwargs, local_dir_use_symlinks=False)
    except TypeError:
        snapshot_download(**kwargs)
    return destination


def language_arg(value: str) -> str | None:
    normalized = (value or "auto").strip().lower()
    return None if normalized in {"", "auto", "detect"} else normalized


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe audio with vendored faster-whisper.")
    parser.add_argument("audio_path", nargs="?", help="Audio file to transcribe.")
    parser.add_argument("--output-srt", help="Path to write SRT output.")
    parser.add_argument("--output-words", help="Path to write word timing JSON output.")
    parser.add_argument("--metadata", help="Path to write transcription metadata JSON.")
    parser.add_argument("--model-size", default=os.environ.get("VIBE_TOOL_WHISPER_MODEL", "small"))
    parser.add_argument("--model-dir", default=os.environ.get("VIBE_TOOL_WHISPER_MODEL_DIR", "vendor/whisper/models"))
    parser.add_argument("--language", default=os.environ.get("VIBE_TOOL_WHISPER_LANGUAGE", "auto"))
    parser.add_argument("--device", default=os.environ.get("VIBE_TOOL_WHISPER_DEVICE", "cpu"))
    parser.add_argument("--compute-type", default=os.environ.get("VIBE_TOOL_WHISPER_COMPUTE_TYPE", "int8"))
    parser.add_argument("--beam-size", type=int, default=int(os.environ.get("VIBE_TOOL_WHISPER_BEAM_SIZE", "5")))
    parser.add_argument("--vad-filter", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--download-model", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.self_test:
        import_whisper_model()
        print(json.dumps({"ok": True, "runtime": "faster_whisper"}, ensure_ascii=False))
        return 0

    if args.download_model:
        model_path = download_model_files(args)
        args.model_size = str(model_path)
        build_model(args)
        print(json.dumps({
            "ok": True,
            "modelSize": Path(args.model_size).name,
            "modelDir": str(Path(args.model_dir).expanduser().resolve()),
            "modelPath": str(model_path),
        }, ensure_ascii=False))
        return 0

    if not args.audio_path:
        raise SystemExit("Missing audio_path")
    if not args.output_srt:
        raise SystemExit("Missing --output-srt")

    audio_path = Path(args.audio_path).expanduser().resolve()
    output_srt = Path(args.output_srt).expanduser().resolve()
    output_words = Path(args.output_words).expanduser().resolve() if args.output_words else None
    metadata_path = Path(args.metadata).expanduser().resolve() if args.metadata else None

    model = build_model(args)
    segments_iter, info = model.transcribe(
        str(audio_path),
        language=language_arg(args.language),
        beam_size=max(1, args.beam_size),
        word_timestamps=True,
        vad_filter=bool(args.vad_filter),
        condition_on_previous_text=False,
    )
    segments = list(segments_iter)
    write_srt(segments, output_srt)

    words = collect_words(segments)
    if output_words:
        output_words.parent.mkdir(parents=True, exist_ok=True)
        output_words.write_text(json.dumps(words, ensure_ascii=False, indent=2), encoding="utf-8")

    if metadata_path:
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        metadata_path.write_text(json.dumps({
            "language": getattr(info, "language", None),
            "languageProbability": getattr(info, "language_probability", None),
            "duration": getattr(info, "duration", None),
            "modelSize": args.model_size,
            "device": args.device,
            "computeType": args.compute_type,
            "wordCount": len(words),
        }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({
        "ok": True,
        "srtPath": str(output_srt),
        "wordsPath": str(output_words) if output_words else "",
        "wordCount": len(words),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        multiprocessing.freeze_support()
        raise SystemExit(main())
    except Exception as exc:
        print(f"Whisper transcription failed: {exc}", file=sys.stderr)
        raise
