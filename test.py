import torch
import gc
import os
from qwen_asr import Qwen3ASRModel, Qwen3ForcedAligner

audio_path = "your-file.mp3"
base_name = os.path.splitext(os.path.basename(audio_path))[0]

# Step 1: ASR
asr_model = Qwen3ASRModel.from_pretrained(
    "Qwen/Qwen3-ASR-0.6B",
    dtype=torch.bfloat16,
    device_map="cuda:0",
    max_new_tokens=256,
)

asr_results = asr_model.transcribe(audio=audio_path, language="Chinese")
transcript = asr_results[0].text

# Save plain transcript
transcript_file = f"{base_name}.txt"
with open(transcript_file, "w", encoding="utf-8") as f:
    f.write(transcript)

print(f"Transcript saved to: {transcript_file}")

# Unload ASR from VRAM
del asr_model
gc.collect()
torch.cuda.empty_cache()

# Step 2: Forced aligner
aligner = Qwen3ForcedAligner.from_pretrained(
    "Qwen/Qwen3-ForcedAligner-0.6B",
    dtype=torch.bfloat16,
    device_map="cuda:0",
)

align_results = aligner.align(
    audio=audio_path,
    text=transcript,
    language="Chinese",
)

# Save timestamps
timestamps_file = f"{base_name}_timestamps.txt"
with open(timestamps_file, "w", encoding="utf-8") as f:
    for segment in align_results[0]:
        start = segment.start_time
        end = segment.end_time
        text = segment.text
        f.write(f"[{start:.3f} -> {end:.3f}] {text}\n")

print(f"Timestamps saved to: {timestamps_file}")
