"""Word-level transcript for tool 06.

Usage: python -I transcribe.py <audio.wav> <out.json>
Writes {"language": str, "words": [{"i", "text", "start", "end"}]}. Exits 3 when no words are found.
"""
import json
import sys

from faster_whisper import WhisperModel


def main() -> int:
    wav, out = sys.argv[1], sys.argv[2]
    model = WhisperModel("small", device="cpu", compute_type="int8")
    segments, info = model.transcribe(wav, word_timestamps=True, vad_filter=True)
    words = []
    for segment in segments:
        for w in segment.words or []:
            text = w.word.strip()
            if text:
                words.append({"i": len(words), "text": text, "start": round(w.start, 3), "end": round(w.end, 3)})
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"language": info.language, "words": words}, f, ensure_ascii=False)
    return 0 if words else 3


if __name__ == "__main__":
    sys.exit(main())
