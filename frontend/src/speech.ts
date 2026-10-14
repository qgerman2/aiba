import { useEffect, useState } from "react";

// Browser text-to-speech (Web Speech API). Free and offline-capable; quality depends on the
// voices installed: Chrome ships Google's Mandarin voice, Edge Microsoft's neural voices.

function pickChineseVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis
    .getVoices()
    .filter((voice) => /^(zh|cmn)/i.test(voice.lang) && !/HK|TW|yue/i.test(voice.lang));
  const score = (voice: SpeechSynthesisVoice) =>
    (/natural|neural|online/i.test(voice.name) ? 4 : 0) +
    (/google/i.test(voice.name) ? 3 : 0) +
    (/xiaoxiao|tingting|yunxi|huihui/i.test(voice.name) ? 2 : 0) +
    (/zh[-_]CN|cmn/i.test(voice.lang) ? 1 : 0);
  return voices.sort((a, b) => score(b) - score(a))[0] ?? null;
}

export function useChineseVoice() {
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(() => pickChineseVoice());

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const update = () => setVoice(pickChineseVoice());
    update();
    window.speechSynthesis.addEventListener("voiceschanged", update);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);

  return voice;
}

/** Keeps only the Chinese sentence: drops "（o …）" alternatives, Latin text and brackets. */
export function speakableChinese(text: string) {
  return text
    .replace(/[（(]o [^）)]*[）)]/g, "")
    .replace(/\s*\/\s*/g, "，")
    .replace(/[（）()]/g, "")
    .replace(/[A-Za-zÀ-ÿ]+/g, "")
    .replace(/\s+/g, "")
    .trim();
}

export function speakChinese(text: string, voice: SpeechSynthesisVoice | null) {
  if (!("speechSynthesis" in window)) return;
  const sentence = speakableChinese(text);
  if (!/[㐀-鿿]/.test(sentence)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(sentence);
  utterance.lang = voice?.lang ?? "zh-CN";
  if (voice) utterance.voice = voice;
  utterance.rate = 0.9;
  window.speechSynthesis.speak(utterance);
}
