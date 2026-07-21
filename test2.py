import torch
import gc
import os
import re
import ollama
from qwen_asr import Qwen3ASRModel, Qwen3ForcedAligner

audio_path = "your-file.mp3"
base_name = os.path.splitext(os.path.basename(audio_path))[0]
ollama_model = "qwen3:4b-instruct"

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

# Step 2: Split into phrases using Ollama
def split_with_ollama(text, model=ollama_model):
    prompt = f"""Split the following Chinese text into natural phrases. Each phrase should be about 30 characters long. Only split at punctuation marks （。，）. Do not add, remove, or change any characters. Output one phrase per line.

Text:
{text}
"""
    response = ollama.chat(
        model=model,
        messages=[
            {"role": "system", "content": "You are a text formatter. Never explain, think, or add commentary. Output only the requested format."},
            {"role": "user", "content": prompt},
        ],
        options={"temperature": 0.1},
    )
    return response["message"]["content"].strip()

def parse_phrases(output):
    lines = [line.strip() for line in output.split("\n") if line.strip()]
    # Remove any numbering or markdown artifacts
    cleaned = []
    for line in lines:
        line = re.sub(r"^\d+\.\s*", "", line)
        line = line.strip("`- ")
        cleaned.append(line)
    return cleaned

def split_with_regex(text):
    parts = re.split(r'(?<=[。，])', text)
    return [p.strip() for p in parts if p.strip()]

print("Splitting phrases with Ollama...")
ollama_output = split_with_ollama(transcript)
phrases = parse_phrases(ollama_output)

# Verify no characters were changed
joined = "".join(phrases)
if joined != transcript:
    print("WARNING: Ollama changed the transcript. Falling back to regex splitting.")
    print(f"Expected length: {len(transcript)}")
    print(f"Got length: {len(joined)}")
    phrases = split_with_regex(transcript)

# Save phrases
phrases_file = f"{base_name}_phrases.txt"
with open(phrases_file, "w", encoding="utf-8") as f:
    for phrase in phrases:
        f.write(phrase + "\n")

print(f"Phrases saved to: {phrases_file}")

# Unload ASR from VRAM
del asr_model
gc.collect()
torch.cuda.empty_cache()

# Step 3: Forced aligner on full transcript
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

# Step 4: Map character-level timestamps to phrase-level timestamps
char_segments = align_results[0]

char_list = []
for segment in char_segments:
    text = segment.text
    start = segment.start_time
    end = segment.end_time
    chars = list(text)
    if len(chars) == 1:
        char_list.append((chars[0], start, end))
    else:
        duration = end - start
        for i, ch in enumerate(chars):
            ch_start = start + (duration * i / len(chars))
            ch_end = start + (duration * (i + 1) / len(chars))
            char_list.append((ch, ch_start, ch_end))

phrase_timestamps = []
char_idx = 0
for phrase in phrases:
    phrase_chars = list(phrase)
    start_time = None
    end_time = None

    for pc in phrase_chars:
        while char_idx < len(char_list) and char_list[char_idx][0] in " \t\n":
            char_idx += 1
        if char_idx >= len(char_list):
            break
        ch, ch_start, ch_end = char_list[char_idx]
        if start_time is None:
            start_time = ch_start
        end_time = ch_end
        char_idx += 1

    if start_time is not None:
        phrase_timestamps.append((start_time, end_time, phrase))

# Save phrase timestamps
phrase_timestamps_file = f"{base_name}_phrase_timestamps.txt"
with open(phrase_timestamps_file, "w", encoding="utf-8") as f:
    for start, end, phrase in phrase_timestamps:
        f.write(f"[{start:.3f} -> {end:.3f}] {phrase}\n")

print(f"Phrase timestamps saved to: {phrase_timestamps_file}")

# Also save character-level timestamps
char_timestamps_file = f"{base_name}_char_timestamps.txt"
with open(char_timestamps_file, "w", encoding="utf-8") as f:
    for segment in align_results[0]:
        f.write(f"[{segment.start_time:.3f} -> {segment.end_time:.3f}] {segment.text}\n")

print(f"Character timestamps saved to: {char_timestamps_file}")
