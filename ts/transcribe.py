# /// script
# requires-python = ">=3.10"
# dependencies = ["mlx-whisper", "av", "numpy"]
# ///
# Local speech-to-text for the relay's voice messages: `uv run --script ts/transcribe.py <audio>`
# prints the transcript. PyAV decodes any container Slack uses (m4a, webm, mp4, ogg), so no
# ffmpeg CLI is needed; mlx-whisper runs on Apple Silicon. Model: $RELAY_WHISPER_MODEL.
import os, sys

import av
import numpy as np


def load(path: str) -> np.ndarray:
    """Decode to 16 kHz mono float32, the input whisper expects."""
    rs = av.AudioResampler(format="s16", layout="mono", rate=16000)
    chunks = []
    with av.open(path) as c:
        for frame in c.decode(audio=0):
            chunks += [f.to_ndarray().reshape(-1) for f in rs.resample(frame)]
    chunks += [f.to_ndarray().reshape(-1) for f in rs.resample(None)]
    return np.concatenate(chunks).astype(np.float32) / 32768.0 if chunks else np.zeros(0, np.float32)


import mlx_whisper  # noqa: E402
from huggingface_hub import snapshot_download  # noqa: E402

model = os.environ.get("RELAY_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
# Run offline once the model is cached: no request to the Hub, the audio never leaves the Mac.
try:
    model = snapshot_download(model, local_files_only=True)
except Exception:
    pass  # first run: mlx-whisper downloads it
print(mlx_whisper.transcribe(load(sys.argv[1]), path_or_hf_repo=model)["text"].strip())
