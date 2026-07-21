import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { pinyin } from "pinyin-pro";
import "./styles.css";

type TimestampSegment = {
  start: number;
  end: number;
  text: string;
};

type CharacterPrompt = {
  char: string;
  start: number;
  end: number;
  expected: string;
};

type PhrasePrompt = {
  phrase: TimestampSegment;
  chars: CharacterPrompt[];
};

type PhrasePanelItem =
  | {
      type: "char";
      charIndex: number;
      char: CharacterPrompt;
    }
  | {
      type: "punctuation";
      text: string;
    };

const phraseTimestampUrl = "./your-file_phrase_timestamps.txt";
const charTimestampUrl = "./your-file_char_timestamps.txt";
const audioUrl = "./your-file.mp3";
const syllablePlaybackTailSeconds = 1;
const syllablePlaybackLeadInSeconds = 2;

function parseTimestampText(raw: string): TimestampSegment[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\[(\d+(?:\.\d+)?) -> (\d+(?:\.\d+)?)\]\s*(.*)$/);

      if (!match) {
        throw new Error(`Invalid timestamp line: ${line}`);
      }

      return {
        start: Number(match[1]),
        end: Number(match[2]),
        text: match[3]
      };
    });
}

function isChineseCharacter(char: string) {
  return /\p{Script=Han}/u.test(char);
}

function normalizePinyin(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replaceAll("ü", "v")
    .replaceAll("u:", "v")
    .replace(/\s+/g, "");
}

function buildPhrasePrompts(
  phrases: TimestampSegment[],
  characters: TimestampSegment[]
): PhrasePrompt[] {
  let charCursor = 0;

  return phrases.map((phrase) => {
    const phraseChars = Array.from(phrase.text).filter(isChineseCharacter);
    const matchedChars: TimestampSegment[] = [];

    for (const phraseChar of phraseChars) {
      while (
        charCursor < characters.length &&
        characters[charCursor].text !== phraseChar
      ) {
        charCursor += 1;
      }

      if (charCursor < characters.length) {
        matchedChars.push(characters[charCursor]);
        charCursor += 1;
      }
    }

    const expectedPinyin = pinyin(
      matchedChars.map((char) => char.text).join(""),
      { toneType: "num", type: "array" }
    );

    return {
      phrase,
      chars: matchedChars.map((char, index) => ({
        char: char.text,
        start: char.start,
        end: char.end,
        expected: normalizePinyin(expectedPinyin[index] ?? "")
      }))
    };
  });
}

function findActivePhraseIndex(phrases: TimestampSegment[], currentTime: number) {
  const index = phrases.findIndex(
    (phrase) => currentTime >= phrase.start && currentTime < phrase.end
  );

  return index >= 0 ? index : null;
}

function findActiveCharacterIndex(chars: CharacterPrompt[], currentTime: number) {
  const index = chars.findIndex(
    (char) => currentTime >= char.start && currentTime < char.end
  );

  return index >= 0 ? index : null;
}

function buildPhrasePanelItems(prompt: PhrasePrompt): PhrasePanelItem[] {
  let charIndex = 0;

  return Array.from(prompt.phrase.text).flatMap((text) => {
    if (!isChineseCharacter(text)) {
      return { type: "punctuation", text };
    }

    const char = prompt.chars[charIndex];
    charIndex += 1;

    return char ? { type: "char", charIndex: charIndex - 1, char } : [];
  });
}

function App() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const playUntilRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [phrasePrompts, setPhrasePrompts] = useState<PhrasePrompt[]>([]);
  const [selectedPhraseIndex, setSelectedPhraseIndex] = useState(0);
  const [focusedCharIndex, setFocusedCharIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [hanziHintKey, setHanziHintKey] = useState<string | null>(null);
  const [pinyinHintKey, setPinyinHintKey] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(phraseTimestampUrl).then((response) => response.text()),
      fetch(charTimestampUrl).then((response) => response.text())
    ])
      .then(([phraseText, charText]) => {
        const prompts = buildPhrasePrompts(
          parseTimestampText(phraseText),
          parseTimestampText(charText)
        );

        setPhrasePrompts(prompts);
        setAnswers((current) => ({
          ...current,
          ...Object.fromEntries(
            prompts[0]?.chars
              .slice(0, 2)
              .map((char, charIndex) => [
                answerKey(0, charIndex),
                char.expected
              ]) ?? []
          )
        }));
      })
      .catch((unknownError) => {
        setError(
          unknownError instanceof Error
            ? unknownError.message
            : "Could not load timestamp files"
        );
      });
  }, []);

  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  const phrases = useMemo(
    () => phrasePrompts.map((prompt) => prompt.phrase),
    [phrasePrompts]
  );

  const activePhraseIndex = useMemo(
    () => findActivePhraseIndex(phrases, currentTime),
    [phrases, currentTime]
  );

  const selectedPhrase = phrasePrompts[selectedPhraseIndex] ?? null;
  const currentPhrase =
    activePhraseIndex === null
      ? selectedPhrase
      : phrasePrompts[activePhraseIndex] ?? selectedPhrase;
  const activeCharacterIndex = selectedPhrase
    ? findActiveCharacterIndex(selectedPhrase.chars, currentTime)
    : null;

  function answerKey(phraseIndex: number, charIndex: number) {
    return `${phraseIndex}:${charIndex}`;
  }

  function playPhrase(index: number) {
    const phrase = phrasePrompts[index]?.phrase;

    if (!phrase || !audioRef.current) {
      return;
    }

    setSelectedPhraseIndex(index);
    playUntilRef.current = phrase.end;
    audioRef.current.currentTime = phrase.start;
    audioRef.current.play();
  }

  function playUntilCharacter(index: number, charIndex: number) {
    const prompt = phrasePrompts[index];
    const targetChar = prompt?.chars[charIndex];
    const stopAt =
      prompt && targetChar
        ? Math.min(
            targetChar.start + syllablePlaybackTailSeconds,
            prompt.phrase.end
          )
        : prompt?.phrase.end;

    if (!prompt || stopAt === undefined || !audioRef.current) {
      return;
    }

    const startAt = targetChar
      ? Math.max(0, targetChar.start - syllablePlaybackLeadInSeconds)
      : prompt.phrase.start;

    setSelectedPhraseIndex(index);
    playUntilRef.current = stopAt;
    audioRef.current.currentTime = startAt;
    audioRef.current.play();
  }

  function movePhrase(offset: number) {
    if (phrasePrompts.length === 0) {
      return;
    }

    const nextIndex = Math.min(
      Math.max(selectedPhraseIndex + offset, 0),
      phrasePrompts.length - 1
    );

    setFocusedCharIndex(0);
    setSelectedPhraseIndex(nextIndex);
    playUntilRef.current = null;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = phrasePrompts[nextIndex]?.phrase.start ?? 0;
    }
  }

  function updateCurrentTime(time: number) {
    setCurrentTime(time);

    if (playUntilRef.current !== null && time >= playUntilRef.current) {
      audioRef.current?.pause();
      playUntilRef.current = null;
    }
  }

  function stopTrackingPlayback() {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }

  function trackPlayback() {
    const audio = audioRef.current;

    if (!audio || audio.paused || audio.ended) {
      stopTrackingPlayback();
      return;
    }

    updateCurrentTime(audio.currentTime);
    animationFrameRef.current = requestAnimationFrame(trackPlayback);
  }

  function startTrackingPlayback() {
    stopTrackingPlayback();
    animationFrameRef.current = requestAnimationFrame(trackPlayback);
  }

  function focusInput(phraseIndex: number, charIndex: number) {
    inputRefs.current[answerKey(phraseIndex, charIndex)]?.focus();
  }

  function handleInputKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    phraseIndex: number,
    charIndex: number,
    charCount: number
  ) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusInput(phraseIndex, Math.max(charIndex - 1, 0));
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusInput(phraseIndex, Math.min(charIndex + 1, charCount - 1));
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHanziHintKey(answerKey(phraseIndex, charIndex));
    }

    if (event.key === "ArrowDown") {
      const expected = phrasePrompts[phraseIndex]?.chars[charIndex]?.expected;

      if (expected) {
        event.preventDefault();
        setPinyinHintKey(answerKey(phraseIndex, charIndex));
      }
    }

    if (event.key === " ") {
      event.preventDefault();
      playUntilCharacter(phraseIndex, charIndex);
    }
  }

  return (
    <main className="shell">
      <section className="player">
        <header className="header">
          <h1>aiba</h1>
        </header>

        <audio
          ref={audioRef}
          className="audio"
          controls
          preload="metadata"
          src={audioUrl}
          onEnded={() => {
            playUntilRef.current = null;
            stopTrackingPlayback();
          }}
          onPause={stopTrackingPlayback}
          onPlay={startTrackingPlayback}
          onSeeked={(event) => updateCurrentTime(event.currentTarget.currentTime)}
          onTimeUpdate={(event) => updateCurrentTime(event.currentTarget.currentTime)}
        />

        <div className="controls">
          <button
            type="button"
            onClick={() => movePhrase(-1)}
            disabled={selectedPhraseIndex <= 0}
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => playPhrase(selectedPhraseIndex)}
            disabled={!selectedPhrase}
          >
            Play phrase
          </button>
          <button
            type="button"
            onClick={() => movePhrase(1)}
            disabled={selectedPhraseIndex >= phrasePrompts.length - 1}
          >
            Next
          </button>
        </div>

        <section className="nowPlaying" aria-live="polite">
          <p className="label">Current phrase</p>
          <p className="phrase">
            {error ??
              (currentPhrase
                ? `Phrase ${selectedPhraseIndex + 1}`
                : phrasePrompts.length > 0
                  ? "No phrase selected"
                  : "Loading...")}
          </p>
          <div className="meta">
            <span>{currentTime.toFixed(2)}s</span>
            <span>
              {selectedPhraseIndex + 1} / {Math.max(phrasePrompts.length, 1)}
            </span>
          </div>
        </section>

        <section className="shortcuts" aria-label="Keyboard shortcuts">
          <span>
            <kbd>Space</kbd> play current syllable window
          </span>
          <span>
            <kbd>Left</kbd> previous input
          </span>
          <span>
            <kbd>Right</kbd> next input
          </span>
          <span>
            <kbd>Up</kbd> reveal current character
          </span>
          <span>
            <kbd>Down</kbd> reveal current pinyin
          </span>
        </section>

        {selectedPhrase && (
          <section
            className={[
              "phraseCard",
              selectedPhraseIndex === activePhraseIndex ? "active" : ""
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <div className="phraseRowHeader">
              <time>
                {selectedPhrase.phrase.start.toFixed(2)} -{" "}
                {selectedPhrase.phrase.end.toFixed(2)}
              </time>
              <span>Type the numbered pinyin for each hidden character</span>
            </div>

            <div className="syllables">
              {buildPhrasePanelItems(selectedPhrase).map((item, itemIndex) => {
                if (item.type === "punctuation") {
                  return (
                    <span className="punctuation" key={`punctuation-${itemIndex}`}>
                      {item.text}
                    </span>
                  );
                }

                const { char, charIndex } = item;
                const key = answerKey(selectedPhraseIndex, charIndex);
                const value = answers[key] ?? "";
                const isCorrect =
                  value.length > 0 &&
                  normalizePinyin(value) === normalizePinyin(char.expected);
                const isRevealed = isCorrect || hanziHintKey === key;
                const hasPinyinHint = pinyinHintKey === key;

                return (
                  <label
                    className={[
                      "syllable",
                      activeCharacterIndex === charIndex ? "playing" : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    key={`${key}-${char.start}`}
                  >
                    <span className={isRevealed ? "hanzi revealed" : "hanzi"}>
                      {isRevealed ? char.char : ""}
                    </span>
                    <input
                      ref={(element) => {
                        inputRefs.current[key] = element;
                      }}
                      className={isCorrect ? "correct" : ""}
                      inputMode="text"
                      value={value}
                      placeholder="pinyin"
                      aria-label={`Pinyin for character ${charIndex + 1}`}
                      onChange={(event) => {
                        setAnswers((current) => ({
                          ...current,
                          [key]: event.target.value
                        }));
                      }}
                      onFocus={() => {
                        setSelectedPhraseIndex(selectedPhraseIndex);
                        setFocusedCharIndex(charIndex);
                        setHanziHintKey(null);
                        setPinyinHintKey(null);
                      }}
                      onBlur={() => {
                        setHanziHintKey((current) =>
                          current === key ? null : current
                        );
                        setPinyinHintKey((current) =>
                          current === key ? null : current
                        );
                      }}
                      onKeyDown={(event) =>
                        handleInputKeyDown(
                          event,
                          selectedPhraseIndex,
                          charIndex,
                          selectedPhrase.chars.length
                        )
                      }
                    />
                    <span className="pinyinHint">
                      {hasPinyinHint ? char.expected : ""}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        )}

        <p className="disclaimer">
          <strong>
            Tone checks currently come from a pinyin library and do not apply
            tone sandhi rules.
          </strong>
        </p>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
