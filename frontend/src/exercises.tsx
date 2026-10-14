import { useEffect, useMemo, useRef, useState } from "react";
import exerciseData from "./exercises.json";
import grammarData from "./grammar.json";
import { loadPinyin, looksLikePinyin, pinyinMatches } from "./pinyinAnswer";
import { speakChinese, useChineseVoice } from "./speech";

type ClozeSegment = { text: string } | { gap: number };

type ClozeGap = {
  answer: string;
  hint: string;
  options?: string[];
  alternatives?: string[];
};

type BaseExercise = {
  id: string;
  lesson: number;
  point: string;
  type: string;
  instruction: string;
  answer: string;
  pinyin: string;
  es: string;
  rule: string;
  note: string;
};

type Exercise =
  | (BaseExercise & { mode: "cloze"; segments: ClozeSegment[]; gaps: ClozeGap[] })
  | (BaseExercise & { mode: "text"; prompt: string; context: string; accepted: string[] })
  | (BaseExercise & { mode: "tiles"; prompt: string; context: string; tiles: string[]; accepted: string[] })
  | (BaseExercise & { mode: "choice"; prompt: string; context: string; options: string[]; accepted: string[] })
  | (BaseExercise & { mode: "reveal"; prompt: string; context: string });

type Lesson = { number: number; title: string };

type SessionScope = {
  kind: "lesson" | "point" | "retry";
  lesson: number;
  point?: string;
  label: string;
};

type SessionResult = {
  exerciseId: string;
  correct: boolean;
  response: string;
  overridden?: boolean;
  revealed?: boolean;
  durationMs: number;
  answeredAt: string;
  // Retries after a miss: the first attempt stays the score; these record how the retries went.
  retries?: number;
  retryCorrect?: boolean;
  retryResponse?: string;
};

type StudySession = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  scope: SessionScope;
  exerciseIds: string[];
  results: SessionResult[];
};

type Screen =
  | { kind: "lessons" }
  | { kind: "lesson"; lesson: number }
  | { kind: "session"; sessionId: string }
  | { kind: "summary"; sessionId: string }
  | { kind: "history" };

type Feedback = {
  correct: boolean;
  response: string;
  retried?: boolean;
  gapResults?: boolean[];
};

const lessons = exerciseData.lessons as Lesson[];
const exercises = exerciseData.exercises as unknown as Exercise[];
const exerciseById = new Map(exercises.map((exercise) => [exercise.id, exercise]));
const sessionsStorageKey = "aiba.exerciseSessions.v1";
const exerciseSettingsKey = "aiba.exerciseSettings.v1";

function readSessions(): StudySession[] {
  try {
    const raw = window.localStorage.getItem(sessionsStorageKey);
    const parsed = raw ? (JSON.parse(raw) as StudySession[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSessions(sessions: StudySession[]) {
  try {
    window.localStorage.setItem(sessionsStorageKey, JSON.stringify(sessions));
  } catch {
    // Storage full or unavailable; the session still works in memory.
  }
}

type ExerciseSettings = { shuffle: boolean; readAloud: boolean };

function readExerciseSettings(): ExerciseSettings {
  const defaults: ExerciseSettings = { shuffle: true, readAloud: true };
  try {
    const raw = window.localStorage.getItem(exerciseSettingsKey);
    return raw ? { ...defaults, ...(JSON.parse(raw) as Partial<ExerciseSettings>) } : defaults;
  } catch {
    return defaults;
  }
}

function normalizeAnswer(value: string) {
  return value.replace(/[\s\p{P}\p{S}]/gu, "");
}

type ClozeExercise = Extract<Exercise, { mode: "cloze" }>;

/** Each gap's position inside the full sentence, so pinyin is read in context. */
function gapContexts(exercise: ClozeExercise) {
  const textOf = (segment: { text: string }, index: number) =>
    index === 0 ? segment.text.replace(SITUATION, "") : segment.text;
  const full = exercise.segments
    .map((segment, index) => ("text" in segment ? textOf(segment, index) : exercise.gaps[segment.gap].answer))
    .join("");
  const contexts: { full: string; start: number }[] = [];
  let offset = 0;
  for (const [index, segment] of exercise.segments.entries()) {
    if ("text" in segment) {
      offset += [...textOf(segment, index)].length;
    } else {
      contexts[segment.gap] = { full, start: offset };
      offset += [...exercise.gaps[segment.gap].answer].length;
    }
  }
  return contexts;
}

// A leading "（situation）" in a cloze sentence is context, not part of the Chinese.
const SITUATION = /^（([^）]*[A-Za-z][^）]*)）/;

function clozeSituation(exercise: ClozeExercise) {
  const first = exercise.segments[0];
  return first && "text" in first ? SITUATION.exec(first.text)?.[1] ?? null : null;
}

/** The Chinese sentence to read aloud once the exercise is answered. */
function spokenText(exercise: Exercise) {
  if (exercise.mode === "reveal") {
    return /[\u3400-\u9fff]/.test(exercise.answer) ? exercise.answer : exercise.prompt;
  }
  return exercise.answer;
}

type GrammarPattern = { label: string; formula: string; examples: string[] };
type GrammarExample = { zh: string; pinyin: string; es: string };
type GrammarEntry = {
  point: string;
  lesson: number;
  missing?: boolean;
  reason?: string;
  title?: string;
  source?: string;
  sourceUrl?: string;
  sourceUrls?: string[];
  explanation?: string[];
  patterns?: GrammarPattern[];
  examples?: GrammarExample[];
  notes?: string[];
};

const grammarByPoint = new Map(
  (grammarData as GrammarEntry[]).map((entry) => [`${entry.lesson}|${entry.point}`, entry])
);

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function sessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function sessionDuration(session: StudySession) {
  const end = session.endedAt ?? session.results.at(-1)?.answeredAt ?? session.startedAt;
  return new Date(end).getTime() - new Date(session.startedAt).getTime();
}

function correctCount(session: StudySession) {
  return session.results.filter((result) => result.correct).length;
}

function isUnfinished(session: StudySession) {
  return session.endedAt === null && session.results.length < session.exerciseIds.length;
}

function exercisePrompt(exercise: Exercise) {
  if (exercise.mode === "cloze") {
    return exercise.segments
      .map((segment) => ("text" in segment ? segment.text : "＿"))
      .join("");
  }
  return exercise.prompt;
}

function lessonLabel(lesson: number) {
  const title = lessons.find((item) => item.number === lesson)?.title ?? "";
  return `Lesson ${lesson} · ${title}`;
}

function scorePillClass(correct: number, total: number) {
  if (total === 0) return "statusPill";
  const ratio = correct / total;
  if (ratio >= 0.8) return "statusPill succeeded";
  if (ratio >= 0.5) return "statusPill running";
  return "statusPill failed";
}

export function ExercisesView() {
  const [sessions, setSessions] = useState<StudySession[]>(() => readSessions());
  const [screen, setScreen] = useState<Screen>({ kind: "lessons" });
  const [shuffle, setShuffle] = useState(() => readExerciseSettings().shuffle);
  const [readAloud, setReadAloud] = useState(() => readExerciseSettings().readAloud);

  useEffect(() => {
    writeSessions(sessions);
  }, [sessions]);

  useEffect(() => {
    try {
      window.localStorage.setItem(exerciseSettingsKey, JSON.stringify({ shuffle, readAloud }));
    } catch {
      // ignore
    }
  }, [shuffle, readAloud]);

  // Last result per exercise, across all sessions.
  const lastResults = useMemo(() => {
    const map = new Map<string, SessionResult>();
    const ordered = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const session of ordered) {
      for (const result of session.results) {
        map.set(result.exerciseId, result);
      }
    }
    return map;
  }, [sessions]);

  const unfinished = sessions.find(isUnfinished) ?? null;

  function startSession(scope: SessionScope, ids: string[]) {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const session: StudySession = {
      id: sessionId(),
      startedAt: now,
      endedAt: null,
      scope,
      exerciseIds: shuffle ? shuffled(ids) : ids,
      results: []
    };
    // Close any abandoned session so only one stays open.
    setSessions((current) => [
      ...current.map((item) => (isUnfinished(item) ? { ...item, endedAt: now } : item)),
      session
    ]);
    setScreen({ kind: "session", sessionId: session.id });
  }

  function recordResult(id: string, result: SessionResult) {
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== id) return session;
        const results = [...session.results, result];
        const finished = results.length >= session.exerciseIds.length;
        return { ...session, results, endedAt: finished ? result.answeredAt : null };
      })
    );
  }

  function recordRetry(id: string, correct: boolean, response: string) {
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== id || session.results.length === 0) return session;
        const results = [...session.results];
        const last = results[results.length - 1];
        results[results.length - 1] = {
          ...last,
          retries: (last.retries ?? 0) + 1,
          retryCorrect: correct,
          retryResponse: response
        };
        return { ...session, results };
      })
    );
  }

  function overrideLastResult(id: string) {
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== id || session.results.length === 0) return session;
        const results = [...session.results];
        results[results.length - 1] = { ...results[results.length - 1], correct: true, overridden: true };
        return { ...session, results };
      })
    );
  }

  function endSession(id: string) {
    setSessions((current) =>
      current.map((session) =>
        session.id === id && session.endedAt === null
          ? { ...session, endedAt: new Date().toISOString() }
          : session
      )
    );
    setScreen({ kind: "summary", sessionId: id });
  }

  function clearHistory() {
    if (!window.confirm("Delete all study session history from this browser?")) return;
    setSessions([]);
    setScreen({ kind: "history" });
  }

  function exportHistory() {
    const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `aiba-exercise-sessions-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const activeSession =
    screen.kind === "session" || screen.kind === "summary"
      ? sessions.find((session) => session.id === screen.sessionId) ?? null
      : null;

  return (
    <section className={screen.kind === "session" || screen.kind === "summary" ? "page narrow" : "page"}>
      {screen.kind !== "session" && (
        <div className="pageHeader">
          <div>
            <p className="label">Grammar practice</p>
            <h1>Exercises</h1>
            <p className="pageDescription">
              Grammar exercises from New Practical Chinese Reader, lessons 1–14.
              Sessions are logged in this browser.
            </p>
          </div>
          <div className="sourceToggle exerciseTabs" aria-label="Exercises section">
            <button
              type="button"
              className={screen.kind === "history" ? "" : "active"}
              onClick={() => setScreen({ kind: "lessons" })}
            >
              Lessons
            </button>
            <button
              type="button"
              className={screen.kind === "history" ? "active" : ""}
              onClick={() => setScreen({ kind: "history" })}
            >
              History
            </button>
          </div>
        </div>
      )}

      {screen.kind === "lessons" && (
        <LessonList
          lastResults={lastResults}
          sessions={sessions}
          unfinished={unfinished}
          onOpen={(lesson) => setScreen({ kind: "lesson", lesson })}
          onResume={(id) => setScreen({ kind: "session", sessionId: id })}
        />
      )}

      {screen.kind === "lesson" && (
        <LessonDetail
          lesson={screen.lesson}
          lastResults={lastResults}
          shuffle={shuffle}
          onShuffleChange={setShuffle}
          readAloud={readAloud}
          onReadAloudChange={setReadAloud}
          onBack={() => setScreen({ kind: "lessons" })}
          onStart={startSession}
        />
      )}

      {screen.kind === "session" && activeSession && (
        <SessionRunner
          key={activeSession.id}
          session={activeSession}
          onResult={(result) => recordResult(activeSession.id, result)}
          onOverride={() => overrideLastResult(activeSession.id)}
          onRetryResult={(correct, response) => recordRetry(activeSession.id, correct, response)}
          onFinish={() => endSession(activeSession.id)}
          readAloud={readAloud}
          onReadAloudChange={setReadAloud}
        />
      )}

      {screen.kind === "summary" && activeSession && (
        <SessionSummary
          session={activeSession}
          onRetry={(ids) =>
            startSession(
              {
                kind: "retry",
                lesson: activeSession.scope.lesson,
                label: `Retry · ${activeSession.scope.label}`
              },
              ids
            )
          }
          onBack={() => setScreen({ kind: "lesson", lesson: activeSession.scope.lesson })}
        />
      )}

      {screen.kind === "history" && (
        <SessionHistory
          sessions={sessions}
          onExport={exportHistory}
          onClear={clearHistory}
          onOpen={(id) => setScreen({ kind: "summary", sessionId: id })}
        />
      )}
    </section>
  );
}

function LessonList({
  lastResults,
  sessions,
  unfinished,
  onOpen,
  onResume
}: {
  lastResults: Map<string, SessionResult>;
  sessions: StudySession[];
  unfinished: StudySession | null;
  onOpen: (lesson: number) => void;
  onResume: (id: string) => void;
}) {
  return (
    <>
      {unfinished && (
        <section className="queueStatusBox exerciseResume">
          <div className="statusTopline">
            <span className="serverDot busy" />
            <strong>Unfinished session: {unfinished.scope.label}</strong>
          </div>
          <div className="statusGrid">
            <span>
              {unfinished.results.length} / {unfinished.exerciseIds.length} answered ·{" "}
              {formatDateTime(unfinished.startedAt)}
            </span>
            <button type="button" className="ghostButton" onClick={() => onResume(unfinished.id)}>
              Resume
            </button>
          </div>
        </section>
      )}
      <div className="entryList full">
        {lessons.map((lesson) => {
          const lessonExercises = exercises.filter((exercise) => exercise.lesson === lesson.number);
          const points = new Set(lessonExercises.map((exercise) => exercise.point));
          const done = lessonExercises.filter((exercise) => lastResults.has(exercise.id));
          const correct = done.filter((exercise) => lastResults.get(exercise.id)?.correct).length;
          const lastSession = [...sessions]
            .reverse()
            .find((session) => session.scope.lesson === lesson.number && session.results.length > 0);
          return (
            <button
              type="button"
              className="entryButton"
              key={lesson.number}
              onClick={() => onOpen(lesson.number)}
            >
              <span className="entryTitle">Lesson {lesson.number}</span>
              <span className={done.length > 0 ? scorePillClass(correct, done.length) : "statusPill"}>
                {done.length > 0 ? `${correct}/${done.length} ok` : "new"}
              </span>
              <span className="exerciseLessonTitle">{lesson.title}</span>
              <span className="entryMeta">
                {lessonExercises.length} exercises · {points.size} points
                {lastSession ? ` · ${formatDateTime(lastSession.startedAt)}` : ""}
              </span>
              <span className="progressTrack exerciseCoverage" aria-hidden="true">
                <span
                  className="progressBar"
                  style={{ width: `${(done.length / lessonExercises.length) * 100}%` }}
                />
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function LessonDetail({
  lesson,
  lastResults,
  shuffle,
  onShuffleChange,
  readAloud,
  onReadAloudChange,
  onBack,
  onStart
}: {
  lesson: number;
  lastResults: Map<string, SessionResult>;
  shuffle: boolean;
  onShuffleChange: (value: boolean) => void;
  readAloud: boolean;
  onReadAloudChange: (value: boolean) => void;
  onBack: () => void;
  onStart: (scope: SessionScope, ids: string[]) => void;
}) {
  const lessonExercises = exercises.filter((exercise) => exercise.lesson === lesson);
  const points = Array.from(new Set(lessonExercises.map((exercise) => exercise.point)));
  const missed = lessonExercises.filter((exercise) => lastResults.get(exercise.id)?.correct === false);
  const fresh = lessonExercises.filter((exercise) => !lastResults.has(exercise.id));

  return (
    <>
      <section className="homeSection wide exerciseLessonHeader">
        <div className="sectionHeader">
          <div>
            <h2>{lessonLabel(lesson)}</h2>
            <p className="entryMeta exerciseSubtle">
              {lessonExercises.length} exercises · {points.length} grammar points
            </p>
          </div>
          <button type="button" className="ghostButton" onClick={onBack}>
            All lessons
          </button>
        </div>
        <div className="controls">
          <button
            type="button"
            onClick={() =>
              onStart(
                { kind: "lesson", lesson, label: lessonLabel(lesson) },
                lessonExercises.map((exercise) => exercise.id)
              )
            }
          >
            Practice all ({lessonExercises.length})
          </button>
          <button
            type="button"
            className="ghostButton"
            disabled={fresh.length === 0}
            onClick={() =>
              onStart(
                { kind: "lesson", lesson, label: `New · ${lessonLabel(lesson)}` },
                fresh.map((exercise) => exercise.id)
              )
            }
          >
            New only ({fresh.length})
          </button>
          <button
            type="button"
            className="ghostButton"
            disabled={missed.length === 0}
            onClick={() =>
              onStart(
                { kind: "retry", lesson, label: `Missed · ${lessonLabel(lesson)}` },
                missed.map((exercise) => exercise.id)
              )
            }
          >
            Missed ({missed.length})
          </button>
          <label className="switchControl">
            <input
              type="checkbox"
              checked={shuffle}
              onChange={(event) => onShuffleChange(event.target.checked)}
            />
            Shuffle
          </label>
          <label className="switchControl" title="Read the sentence aloud after checking">
            <input
              type="checkbox"
              checked={readAloud}
              onChange={(event) => onReadAloudChange(event.target.checked)}
            />
            Read aloud
          </label>
        </div>
      </section>

      <div className="exercisePointList">
        {points.map((point) => {
          const pointExercises = lessonExercises.filter((exercise) => exercise.point === point);
          return (
            <section className="homeSection" key={point}>
              <div className="sectionHeader">
                <h2>{point}</h2>
                <button
                  type="button"
                  className="ghostButton"
                  onClick={() =>
                    onStart(
                      { kind: "point", lesson, point, label: point },
                      pointExercises.map((exercise) => exercise.id)
                    )
                  }
                >
                  Practice
                </button>
              </div>
              <ul className="exerciseRows">
                {pointExercises.map((exercise) => {
                  const last = lastResults.get(exercise.id);
                  return (
                    <li key={exercise.id}>
                      <span
                        className={`serverDot ${last ? (last.correct ? "idle" : "offline") : ""}`}
                        title={last ? (last.correct ? "Last attempt correct" : "Last attempt missed") : "Not practiced"}
                      />
                      <span className="entryTag">{exercise.type}</span>
                      <span className="exerciseRowPrompt">{exercisePrompt(exercise)}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}

function SessionRunner({
  session,
  onResult,
  onOverride,
  onFinish,
  onRetryResult,
  readAloud,
  onReadAloudChange
}: {
  session: StudySession;
  onResult: (result: SessionResult) => void;
  onOverride: () => void;
  onFinish: () => void;
  onRetryResult: (correct: boolean, response: string) => void;
  readAloud: boolean;
  onReadAloudChange: (value: boolean) => void;
}) {
  const index = session.results.length;
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [retrying, setRetrying] = useState(false);
  // While feedback is shown, the result is already recorded, so show the answered exercise.
  const shownIndex = feedback || retrying ? index - 1 : index;
  const exercise = exerciseById.get(session.exerciseIds[shownIndex]) ?? null;
  const shownAtRef = useRef(Date.now());
  const total = session.exerciseIds.length;
  const correct = correctCount(session);

  useEffect(() => {
    if (!exercise && !feedback) onFinish();
  }, [exercise, feedback, onFinish]);

  if (!exercise) return null;

  function submit(result: Feedback & { revealed?: boolean }) {
    if (retrying) {
      // The first attempt is already logged; only note how the retry went.
      onRetryResult(result.correct, result.response);
      setFeedback({ ...result, retried: true });
      return;
    }
    onResult({
      exerciseId: exercise!.id,
      correct: result.correct,
      response: result.response,
      revealed: result.revealed,
      durationMs: Date.now() - shownAtRef.current,
      answeredAt: new Date().toISOString()
    });
    setFeedback(result);
  }

  function next() {
    setFeedback(null);
    setRetrying(false);
    shownAtRef.current = Date.now();
    if (index >= total) onFinish();
  }

  return (
    <>
      <div className="pageHeader">
        <div>
          <p className="label">{session.scope.label}</p>
          <h1>Exercise {shownIndex + 1} of {total}</h1>
        </div>
      </div>

      <div className="progressTrack" aria-hidden="true">
        <span className="progressBar" style={{ width: `${(index / total) * 100}%` }} />
      </div>
      <div className="statusGrid">
        <span>{correct} correct</span>
        <span>{index - correct} missed</span>
      </div>

      <ExerciseCard
        key={`${exercise.id}-${shownIndex}`}
        exercise={exercise}
        feedback={feedback}
        onSubmit={submit}
        onOverride={() => {
          onOverride();
          setFeedback((current) => (current ? { ...current, correct: true } : current));
        }}
        onNext={next}
        onRetry={() => {
          setRetrying(true);
          setFeedback(null);
        }}
        readAloud={readAloud}
      />

      <div className="playerHeaderActions playerBottomActions">
        <label className="switchControl" title="Read the sentence aloud after checking">
          <input
            type="checkbox"
            checked={readAloud}
            onChange={(event) => {
              if (!event.target.checked && "speechSynthesis" in window) window.speechSynthesis.cancel();
              onReadAloudChange(event.target.checked);
            }}
          />
          Read aloud
        </label>
        <button type="button" className="ghostButton" onClick={onFinish}>
          End session
        </button>
      </div>
    </>
  );
}

function ExerciseCard({
  exercise,
  feedback,
  onSubmit,
  onOverride,
  onNext,
  onRetry,
  readAloud
}: {
  exercise: Exercise;
  feedback: Feedback | null;
  onSubmit: (result: Feedback & { revealed?: boolean }) => void;
  onOverride: () => void;
  onNext: () => void;
  onRetry: () => void;
  readAloud: boolean;
}) {
  const [gapValues, setGapValues] = useState<string[]>(() =>
    exercise.mode === "cloze" ? exercise.gaps.map(() => "") : []
  );
  const [text, setText] = useState("");
  const [placed, setPlaced] = useState<number[]>([]);
  const [choice, setChoice] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [overridden, setOverridden] = useState(false);
  const [showGrammar, setShowGrammar] = useState(false);
  const checkingRef = useRef(false);
  const voice = useChineseVoice();
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  const nextButtonRef = useRef<HTMLButtonElement | null>(null);
  const tileOrder = useMemo(
    () => (exercise.mode === "tiles" ? shuffled(exercise.tiles.map((_, index) => index)) : []),
    [exercise]
  );

  useEffect(() => {
    if (feedback) {
      nextButtonRef.current?.focus();
    } else {
      firstInputRef.current?.focus();
    }
  }, [feedback]);

  const answered = feedback !== null;

  useEffect(() => {
    if (answered && readAloud) speakChinese(spokenText(exercise), voice);
    // Speak once per answer, not when the voice list refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered]);

  async function check() {
    if (answered || checkingRef.current) return;
    checkingRef.current = true;
    const typed = exercise.mode === "cloze" ? gapValues : exercise.mode === "text" ? [text] : [];
    const pinyin = typed.some(looksLikePinyin) ? await loadPinyin() : null;
    checkingRef.current = false;
    // Typed hanzi or numbered pinyin both count.
    const typedMatches = (value: string, option: string, context?: { full: string; start: number }) =>
      looksLikePinyin(value)
        ? pinyin !== null && pinyinMatches(pinyin, value, option, context)
        : normalizeAnswer(value).length > 0 && normalizeAnswer(option) === normalizeAnswer(value);
    switch (exercise.mode) {
      case "cloze": {
        const contexts = gapContexts(exercise);
        const gapResults = exercise.gaps.map((gap, index) => {
          const value = gapValues[index] ?? "";
          return (
            typedMatches(value, gap.answer, contexts[index]) ||
            (gap.alternatives ?? []).some((option) => typedMatches(value, option))
          );
        });
        onSubmit({
          correct: gapResults.every(Boolean),
          response: gapValues.join(" / "),
          gapResults
        });
        break;
      }
      case "text": {
        onSubmit({
          correct: exercise.accepted.some((option) => typedMatches(text, option)),
          response: text
        });
        break;
      }
      case "tiles": {
        const response = placed.map((index) => exercise.tiles[index]).join("");
        onSubmit({
          correct: exercise.accepted.some((option) => normalizeAnswer(option) === normalizeAnswer(response)),
          response
        });
        break;
      }
      case "choice": {
        if (choice === null) return;
        onSubmit({
          correct: exercise.accepted.some((option) => normalizeAnswer(option) === normalizeAnswer(choice)),
          response: choice
        });
        break;
      }
      case "reveal":
        setRevealed(true);
        break;
    }
  }

  // Enter checks / advances even when focus was lost (e.g. a placed tile got disabled).
  const enterHandlerRef = useRef<(event: globalThis.KeyboardEvent) => void>(() => {});
  enterHandlerRef.current = (event) => {
    if (event.key !== "Enter" || event.isComposing || event.repeat) return;
    // Action buttons (Next, I knew it…) handle Enter themselves; answer chips don't.
    if (event.target instanceof HTMLButtonElement && !event.target.classList.contains("tagChip")) return;
    if (exercise.mode === "reveal" && revealed && !answered) return;
    event.preventDefault();
    if (answered) {
      onNext();
    } else if (canCheck) {
      void check();
    }
  };

  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => enterHandlerRef.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const canCheck =
    exercise.mode === "cloze"
      ? gapValues.every((value) => value.trim().length > 0)
      : exercise.mode === "text"
        ? text.trim().length > 0
        : exercise.mode === "tiles"
          ? placed.length === exercise.tiles.length
          : exercise.mode === "choice"
            ? choice !== null
            : true;

  return (
    <article
      className={["phraseCard", "exerciseCard", answered ? (feedback.correct ? "correct" : "missed") : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="phraseRowHeader">
        <span className="entryTag exercisePointTag" title={exercise.point}>{exercise.point}</span>
        <span className="phraseCount">{lessonLabel(exercise.lesson)}</span>
      </div>
      <div className="exerciseInstructionRow">
        <p className="exerciseInstruction">{exercise.instruction}</p>
        <button
          type="button"
          className={showGrammar ? "tagChip active" : "tagChip"}
          aria-expanded={showGrammar}
          onClick={() => setShowGrammar((current) => !current)}
        >
          {showGrammar ? "Hide grammar" : "Show grammar"}
        </button>
      </div>

      {exercise.mode === "cloze" && (
        <>
          {clozeSituation(exercise) && <p className="exerciseSituation">{clozeSituation(exercise)}</p>}
          <p className="exerciseSentence">
            {exercise.segments.map((segment, segmentIndex) => {
              if ("text" in segment) {
                const text = segmentIndex === 0 ? segment.text.replace(SITUATION, "") : segment.text;
                return <span key={segmentIndex}>{text}</span>;
              }
              const gap = exercise.gaps[segment.gap];
              const result = feedback?.gapResults?.[segment.gap];
              if (gap.options) {
                return (
                  <span className="exerciseGapChoices" key={segmentIndex}>
                    {gap.options.map((option) => (
                      <button
                        type="button"
                        key={option}
                        disabled={answered}
                        className={[
                          "tagChip",
                          gapValues[segment.gap] === option ? "active" : "",
                          answered && option === gap.answer ? "right" : "",
                          answered && gapValues[segment.gap] === option && !result ? "wrong" : ""
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() =>
                          setGapValues((current) =>
                            current.map((value, index) => (index === segment.gap ? option : value))
                          )
                        }
                      >
                        {option}
                      </button>
                    ))}
                  </span>
                );
              }
              return (
                <input
                  key={segmentIndex}
                  ref={segment.gap === 0 ? firstInputRef : undefined}
                  className={[
                    "exerciseGapInput",
                    result === true ? "correct" : "",
                    result === false ? "wrong" : ""
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  value={gapValues[segment.gap] ?? ""}
                  placeholder="…"
                  disabled={answered}
                  size={4}
                  aria-label={`Gap ${segment.gap + 1}`}
                  autoComplete="off"
                  onChange={(event) => {
                    const next = event.target.value;
                    if (looksLikePinyin(next)) void loadPinyin();
                    setGapValues((current) =>
                      current.map((value, index) => (index === segment.gap ? next : value))
                    );
                  }}
                />
              );
            })}
          </p>
          <p className="exerciseTranslation">{exercise.es}</p>
        </>
      )}

      {exercise.mode !== "cloze" && (
        <>
          <p className={exercise.mode === "tiles" ? "exercisePrompt muted" : "exercisePrompt"}>
            {exercise.mode === "tiles" ? "Build the sentence:" : exercise.prompt.split("\n").map((line, index) => (
              <span key={index} className="exercisePromptLine">{line}</span>
            ))}
          </p>
          {exercise.context && <p className="exerciseTranslation">{exercise.context}</p>}
        </>
      )}

      {exercise.mode === "text" && (
        <input
          ref={firstInputRef}
          className={[
            "searchInput",
            "exerciseTextInput",
            answered ? (feedback.correct ? "correct" : "wrong") : ""
          ]
            .filter(Boolean)
            .join(" ")}
          value={text}
          disabled={answered}
          placeholder="Type in Chinese or numbered pinyin (ni3 hao3)…"
          autoComplete="off"
          lang="zh-CN"
          onChange={(event) => {
            if (looksLikePinyin(event.target.value)) void loadPinyin();
            setText(event.target.value);
          }}
        />
      )}

      {exercise.mode === "tiles" && (
        <div className="exerciseTiles">
          <div
            className={[
              "exerciseTileAnswer",
              answered ? (feedback.correct ? "correct" : "wrong") : ""
            ]
              .filter(Boolean)
              .join(" ")}
            aria-label="Your sentence"
          >
            {placed.length === 0 && <span className="emptyText">Tap the words in order</span>}
            {placed.map((tileIndex, position) => (
              <button
                type="button"
                className="tagChip active"
                key={`${tileIndex}-${position}`}
                disabled={answered}
                onClick={() => setPlaced((current) => current.filter((_, index) => index !== position))}
              >
                {exercise.tiles[tileIndex]}
              </button>
            ))}
          </div>
          <div className="exerciseTilePool">
            {tileOrder.map((tileIndex) => (
              <button
                type="button"
                className="tagChip"
                key={tileIndex}
                disabled={answered || placed.includes(tileIndex)}
                onClick={() => setPlaced((current) => [...current, tileIndex])}
              >
                {exercise.tiles[tileIndex]}
              </button>
            ))}
          </div>
        </div>
      )}

      {exercise.mode === "choice" && (
        <div className="exerciseChoices">
          {exercise.options.map((option) => {
            const isRight = exercise.accepted.some(
              (accepted) => normalizeAnswer(accepted) === normalizeAnswer(option)
            );
            return (
              <button
                type="button"
                key={option}
                disabled={answered}
                className={[
                  "tagChip",
                  choice === option ? "active" : "",
                  answered && isRight ? "right" : "",
                  answered && choice === option && !isRight ? "wrong" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => setChoice(option)}
              >
                {option}
              </button>
            );
          })}
        </div>
      )}

      {!answered && !revealed && (
        <div className="phraseNav exerciseActions">
          {exercise.mode === "reveal" ? (
            <button type="button" onClick={check} autoFocus>
              Show answer
            </button>
          ) : (
            <>
              <button
                type="button"
                className="ghostButton"
                onClick={() => onSubmit({ correct: false, response: "", revealed: true })}
              >
                Show answer
              </button>
              <button type="button" onClick={check} disabled={!canCheck}>
                Check
              </button>
            </>
          )}
        </div>
      )}

      {!answered && revealed && exercise.mode === "reveal" && (
        <>
          <AnswerPanel exercise={exercise} />
          <div className="phraseNav exerciseActions">
            <button type="button" className="ghostButton" onClick={() => onSubmit({ correct: false, response: "self: missed" })}>
              I missed it
            </button>
            <button type="button" onClick={() => onSubmit({ correct: true, response: "self: knew it" })} autoFocus>
              I knew it
            </button>
          </div>
        </>
      )}

      {answered && (
        <>
          {exercise.mode !== "reveal" && (
            <p className={feedback.correct ? "successText exerciseVerdict" : "errorText exerciseVerdict"}>
              {feedback.correct
                ? overridden
                  ? "Marked as correct."
                  : feedback.retried
                    ? "Correct on the retry! (The first attempt still counts as missed.)"
                    : "Correct!"
                : feedback.response
                  ? "Not quite. Expected answer:"
                  : "Answer:"}
            </p>
          )}
          <AnswerPanel exercise={exercise} />
          <div className="phraseNav exerciseActions">
            {!feedback.correct && exercise.mode !== "reveal" && (
              <button type="button" className="ghostButton" onClick={onRetry}>
                Try again
              </button>
            )}
            {!feedback.correct && feedback.response && exercise.mode === "text" && !overridden && !feedback.retried && (
              <button
                type="button"
                className="ghostButton"
                onClick={() => {
                  setOverridden(true);
                  onOverride();
                }}
              >
                My answer was also right
              </button>
            )}
            <button type="button" ref={nextButtonRef} onClick={onNext}>
              Next
            </button>
          </div>
        </>
      )}

      {showGrammar && <GrammarPanel lesson={exercise.lesson} point={exercise.point} />}

      <div className="shortcuts">
        <span>
          <kbd>Enter</kbd>
          {answered ? "Next" : "Check"}
        </span>
      </div>
    </article>
  );
}

function AnswerPanel({ exercise }: { exercise: Exercise }) {
  const voice = useChineseVoice();
  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;
  return (
    <div className="exerciseAnswer">
      <div className="exerciseAnswerHeader">
        <p className="exerciseAnswerText" lang="zh-CN">{exercise.answer}</p>
        {canSpeak && /[\u3400-\u9fff]/.test(spokenText(exercise)) && (
          <button
            type="button"
            className="iconButton"
            aria-label="Listen"
            title={voice ? `Listen (${voice.name})` : "Listen (no Chinese voice found; using browser default)"}
            onClick={() => speakChinese(spokenText(exercise), voice)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z" />
            </svg>
          </button>
        )}
      </div>
      {exercise.pinyin && <p className="exerciseAnswerPinyin">{exercise.pinyin}</p>}
      {exercise.es && exercise.mode !== "cloze" && <p className="exerciseTranslation">{exercise.es}</p>}
      {exercise.note && <p className="exerciseNote">Also: {exercise.note}</p>}
      <div className="exerciseRule">
        <p>{exercise.rule}</p>
      </div>
    </div>
  );
}

function SessionSummary({
  session,
  onRetry,
  onBack
}: {
  session: StudySession;
  onRetry: (ids: string[]) => void;
  onBack: () => void;
}) {
  const correct = correctCount(session);
  const answered = session.results.length;
  const missed = session.results.filter((result) => !result.correct);

  return (
    <>
      <section className="homeSection wide">
        <div className="sectionHeader">
          <div>
            <p className="label">Session summary</p>
            <h2>{session.scope.label}</h2>
          </div>
          <span className={scorePillClass(correct, answered)}>
            {correct}/{answered}
          </span>
        </div>
        <div className="statusGrid">
          <span>{formatDateTime(session.startedAt)}</span>
          <span>{formatDuration(sessionDuration(session))}</span>
          <span>
            {answered} of {session.exerciseIds.length} answered
          </span>
        </div>
        <div className="controls">
          <button type="button" disabled={missed.length === 0} onClick={() => onRetry(missed.map((result) => result.exerciseId))}>
            Retry missed ({missed.length})
          </button>
          <button type="button" className="ghostButton" onClick={onBack}>
            Back to lesson
          </button>
        </div>
      </section>

      <ResultList session={session} />
    </>
  );
}

function ResultList({ session }: { session: StudySession }) {
  return (
    <ul className="exerciseResults">
      {session.results.map((result, index) => {
        const exercise = exerciseById.get(result.exerciseId);
        if (!exercise) return null;
        return (
          <li key={`${result.exerciseId}-${index}`} className={result.correct ? "correct" : "missed"}>
            <span className={`serverDot ${result.correct ? "idle" : "offline"}`} />
            <div>
              <p className="exerciseRowPrompt">{exercisePrompt(exercise)}</p>
              <p className="entryMeta">
                {result.revealed
                  ? "Revealed"
                  : result.response
                    ? `Your answer: ${result.response}`
                    : "No answer"}
                {result.overridden ? " · marked correct" : ""}
                {result.retries
                  ? result.retryCorrect
                    ? result.retries === 1
                      ? " · correct on retry"
                      : ` · correct after ${result.retries} retries`
                    : ` · ${result.retries} retr${result.retries === 1 ? "y" : "ies"}, still missed`
                  : ""}
                {" · "}
                {formatDuration(result.durationMs)}
              </p>
              {!result.correct && <p className="exerciseResultAnswer">{exercise.answer}</p>}
            </div>
          </li>
        );
      })}
      {session.results.length === 0 && <p className="emptyText">No answers recorded.</p>}
    </ul>
  );
}

function SessionHistory({
  sessions,
  onExport,
  onClear,
  onOpen
}: {
  sessions: StudySession[];
  onExport: () => void;
  onClear: () => void;
  onOpen: (id: string) => void;
}) {
  const ordered = [...sessions].reverse();
  const answered = sessions.reduce((sum, session) => sum + session.results.length, 0);
  const correct = sessions.reduce((sum, session) => sum + correctCount(session), 0);
  const studyTime = sessions.reduce((sum, session) => sum + sessionDuration(session), 0);

  return (
    <>
      <section className="homeSection wide">
        <div className="sectionHeader">
          <h2>Study log</h2>
          <div className="playerHeaderActions">
            <button type="button" className="ghostButton" onClick={onExport} disabled={sessions.length === 0}>
              Export JSON
            </button>
            <button type="button" className="ghostButton" onClick={onClear} disabled={sessions.length === 0}>
              Clear
            </button>
          </div>
        </div>
        <div className="statusGrid">
          <span>{sessions.length} sessions</span>
          <span>{answered} exercises answered</span>
          <span>{answered > 0 ? Math.round((correct / answered) * 100) : 0}% correct</span>
          <span>{formatDuration(studyTime)} total</span>
        </div>
      </section>

      <div className="entryList full compact">
        {ordered.map((session) => (
          <button type="button" className="entryButton" key={session.id} onClick={() => onOpen(session.id)}>
            <span className="entryTitle">{session.scope.label}</span>
            <span className={scorePillClass(correctCount(session), session.results.length)}>
              {correctCount(session)}/{session.results.length}
            </span>
            <span className="entryMeta">
              {formatDateTime(session.startedAt)} · {formatDuration(sessionDuration(session))}
              {isUnfinished(session)
                ? " · in progress"
                : session.results.length < session.exerciseIds.length
                  ? ` · ended early (${session.exerciseIds.length} planned)`
                  : ""}
            </span>
          </button>
        ))}
        {sessions.length === 0 && <p className="emptyText">No study sessions yet.</p>}
      </div>
    </>
  );
}

function grammarLinks(entry: GrammarEntry) {
  return Array.from(new Set([entry.sourceUrl, ...(entry.sourceUrls ?? [])].filter((url): url is string => Boolean(url))));
}

/** "…/grammar/Comparing_%22gang%22_and_%22gangcai%22" -> "Comparing "gang" and "gangcai"" on the wiki. */
function articleName(url: string) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return /^[A-Z0-9]{8}$/.test(last) ? "Chinese Grammar Wiki article" : `Chinese Grammar Wiki: ${last.replace(/_/g, " ")}`;
  } catch {
    return url;
  }
}

function GrammarPanel({ lesson, point }: { lesson: number; point: string }) {
  const entry = grammarByPoint.get(`${lesson}|${point}`);

  if (!entry || entry.missing) {
    return (
      <section className="grammarPanel">
        <p className="label">Grammar</p>
        <h3>{point}</h3>
        <p className="emptyText">No explanation for this point in the textbook.</p>
        {entry?.reason && <p className="grammarNote">{entry.reason}</p>}
      </section>
    );
  }

  // Skip examples already listed under a pattern unless they add pinyin or a translation.
  const patternText = (entry.patterns ?? []).flatMap((pattern) => pattern.examples).join("\n");
  const examples = (entry.examples ?? []).filter(
    (example) =>
      example.pinyin ||
      example.es ||
      !example.zh ||
      !patternText.includes(example.zh.replace(/[。？！?!.]$/, ""))
  );

  return (
    <section className="grammarPanel">
      <p className="label">Grammar · {entry.source}</p>
      {grammarLinks(entry).length > 0 && (
        <p className="grammarSourceLinks">
          {grammarLinks(entry).map((url) => (
            <a key={url} href={url} target="_blank" rel="noopener noreferrer">
              {articleName(url)} ↗
            </a>
          ))}
        </p>
      )}
      <h3>{entry.title}</h3>
      {entry.explanation?.map((paragraph, index) => (
        <p className="grammarParagraph" key={index}>{paragraph}</p>
      ))}
      {entry.patterns && entry.patterns.length > 0 && (
        <div className="grammarPatterns">
          {entry.patterns.map((pattern, index) => (
            <div className="grammarPattern" key={index}>
              {pattern.label && <p className="grammarPatternLabel">{pattern.label}</p>}
              {pattern.formula && <p className="grammarFormula">{pattern.formula}</p>}
              {pattern.examples.length > 0 && (
                <ul>
                  {pattern.examples.map((example, exampleIndex) => (
                    <li key={exampleIndex} lang="zh-CN">{example}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
      {examples.length > 0 && (
        <ul className="grammarExamples">
          {examples.map((example, index) => (
            <li key={index}>
              {example.zh && <span className="grammarExampleZh" lang="zh-CN">{example.zh}</span>}
              {example.pinyin && <span className="grammarExamplePinyin">{example.pinyin}</span>}
              {example.es && <span className="grammarExampleEs">{example.es}</span>}
            </li>
          ))}
        </ul>
      )}
      {entry.notes?.map((note, index) => (
        <p className="grammarNote" key={index}>{note}</p>
      ))}
    </section>
  );
}
