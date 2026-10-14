# Exercise types

Reference for the grammar exercises in the **Exercises** tab (`src/exercises.tsx`, data in
`src/exercises.json`, explanations in `src/grammar.json`). Use it when writing new exercises
so they keep the current difficulty level.

The deck has 379 exercises over NPCR lessons 1–14. **"Say it in Chinese" is the type to favour**:
it is the most challenging and the most rewarding (see below).

| Type | Instruction shown | Mode | Count | The learner… |
|---|---|---|---|---|
| **Translate** | **Say it in Chinese** | `text` | 107 | **types the whole Chinese sentence for an English one** |
| Situation | What would you say? | `text` | 18 | says what fits a described situation |
| Fill in | Complete the sentence | `cloze` | 117 | types the missing word(s) in a Chinese sentence |
| Transform | Turn it into a question / Make it negative / … | `text` | 28 | changes a Chinese sentence's form |
| Correct | The sentence has a mistake. Correct it. | `text` | 56 | rewrites a Chinese sentence that has one mistake |
| Order | Put the words in order | `tiles` | 28 | taps word tiles to build the sentence |
| Choose | Choose the correct sentence / reading | `choice` / `text` | 19 | picks (or writes) the right option of a contrast |
| Read | Read aloud (pinyin) | `reveal` | 5 | reads a word with several readings, then self-grades |
| Question | Answer | `reveal` | 1 | answers a meaning question, then self-grades |

## "Say it in Chinese" comes first

In a Translate exercise the learner sees only an English sentence and has to produce the whole
Chinese sentence: the structure, the word order and the vocabulary, with nothing on the screen
to lean on. That is exactly what speaking and writing require, so these are the hardest and the
most useful exercises. Every other type is a step towards them: Fill in, Order and Choose train
recognition and single decisions; Transform and Correct train one change at a time.

Today they are a bit under a third of the deck (109 of 379, counting the two Choose items that
use the same instruction). When adding exercises, give them priority:

- aim for about **40%** of each lesson to be "Say it in Chinese";
- every grammar point should have **at least 1**, and every core (non-"Notes"/"Usage") point
  **at least 3**;
- together they should cover the point's forms: affirmative, negative, question, with an
  object, and the contrast with similar words.

Writing good ones:

- **Natural English that a person would actually say**, not a word-for-word gloss of the
  Chinese ("How was your trip to Xi'an?", not "You played in Xi'an how?").
- **The English must force the target grammar** without naming it: "I didn't understand what
  he said" forces 没听懂; "We haven't finished eating yet" forces 还没吃完…呢.
- **Disambiguate meaning, never form.** Add a short bracketed context only when the meaning is
  open (politeness, plural *you*, where the speaker is for 来/去), e.g. "(You're upstairs) Come
  up!". Never add tips like "(use 把)".
- **Accept every natural translation.** These have the most valid variants, so `accepted`
  needs time-word positions, 没/没有, 很/非常 when the English allows, optional words, 了
  placement, 吗 vs A-not-A vs 了没有 when the English question allows them.
- **One sentence, everyday length** (roughly 6–15 characters), using the lesson's situations.

## The types

**Translate — "Say it in Chinese"** (`text`). An English sentence; the learner types the
Chinese. The core type, see above.
Example: *How was your time in Shanghai?* → 你在上海玩儿得怎么样？

**Situation — "What would you say?"** (`text`). A described situation instead of a sentence
to translate; the learner says the fitting phrase. Good for set expressions and functions
(greeting, refusing, reminding). Same writing rules as Translate.
Example: *Remind them that it's Lin Na's turn to change money.* → 该林娜换钱了。

**Fill in — "Complete the sentence"** (`cloze`). A Chinese sentence with one or more gaps,
English translation underneath. Best for particles, measure words, complements and contrasts
(了, 得, 又/再, 就/才). The most numerous type; use it to introduce a point, not as the main
practice.
Example: 我玩儿＿非常高兴。 (*I had a great time.*) → 得

**Transform** (`text`). A Chinese sentence to turn into another form: "Turn it into a
question", "Make it negative", "Ask the same question without 吗", "Soften the request",
"Add the duration: …". Only name the target meaning, never the structure.
Example: 他睡得很好。 → *Make it negative* → 他睡得不好。

**Correct — "The sentence has a mistake. Correct it."** (`text`). A sentence with exactly
one typical learner mistake (missing 得, 不 instead of 没, wrong word order).
Example: 我玩儿很高兴。 → 我玩儿得很高兴。

**Order — "Put the words in order"** (`tiles`). Word tiles plus the English meaning; the
learner taps them in order. Best for word-order points (time words, 也/都, 把, V得 with an
object).
Example: 得 / 说 / 汉语 / 她 / 很流利 / 说 (*She speaks Chinese very fluently.*) →
她说汉语说得很流利。

**Choose — "Choose the correct sentence"** (`choice`). Two or three options, the
distractors being real mistakes. For genuine "which one" contrasts only.
Example: *She eats very slowly.* → 她吃得饭很慢。 / 她吃饭得很慢。 / **她吃饭吃得很慢。**

**Read — "Read aloud (pinyin)"** and **Question — "Answer"** (`reveal`). Self-graded items
for things that can't be checked automatically (readings of 数/称, the meaning of 不比). Keep
them rare.

## Difficulty guidelines

These are what make the level feel right; keep them for new exercises.

- **Say what to do, never which form to use.** "Turn it into a question", not
  "Make a V不V question"; "Say it in Chinese", not "Use 把". The grammar point is shown on the
  card, and its explanation is one click away, so the learner knows the topic but still has to
  produce the form.
- **No hints in gaps.** Gaps have no placeholder hint and no answer buttons, and every gap has
  the same width, so its size doesn't give away the answer's length.
- **No tips in prompts** such as "(use 差)" or "(with a directional complement)". If a prompt
  needs disambiguating, change the English sentence or add a situation, not a grammar tip.
- **One clearly right answer, many accepted forms.** The prompt should point to a single
  meaning, and `accepted` / `alternatives` must list every natural way to say it (没/没有,
  很/非常, word-order variants, 吗 vs A-not-A where the instruction allows both). A learner
  should never be marked wrong for a valid sentence.
- **Use the lesson's vocabulary** (lessons 1 up to the current one) and its situations
  (bank, post office, dorm, Xi'an, Shanghai…).
- **Mix the point's forms**: affirmative, negative, questions, with objects, contrasts with a
  similar word, and one or two typical mistakes as Correct items.

## Fields shared by every exercise

| Field | Meaning |
|---|---|
| `id` | Unique, stable id (logged in study sessions; never reuse or change) |
| `lesson` | NPCR lesson number |
| `point` | Grammar point name; must match an entry in `grammar.json` exactly (`lesson` + `point` is the lookup key) |
| `type` | One of the types above (shown in the lesson's exercise list) |
| `mode` | How the card is answered: `cloze`, `text`, `tiles`, `choice`, `reveal` |
| `instruction` | Short imperative shown above the exercise |
| `answer` | Model answer, shown after checking and read aloud |
| `pinyin` | Hand-checked pinyin of `answer`, textbook style (see below) |
| `es` | **English** translation of the answer (the key name is historical) |
| `rule` | One sentence explaining the grammar, shown after checking |
| `note` | Optional "Also: …" line (alternatives, nuances) |

## Modes

### `cloze` — Fill in

```json
{
  "mode": "cloze", "type": "Fill in", "instruction": "Complete the sentence",
  "segments": [{ "text": "我玩儿" }, { "gap": 0 }, { "text": "非常高兴。" }],
  "gaps": [{ "answer": "得", "hint": "", "alternatives": [] }],
  "answer": "我玩儿得非常高兴。", "es": "I had a great time."
}
```

- The English translation (`es`) is shown under the sentence and is the main disambiguation.
- A situation can go at the start of the first segment in full-width brackets:
  `"（The courier knocked on the wrong door）快递员记"`. It is shown as a context line, not as
  part of the Chinese, and is excluded when reading pinyin in context.
- Several gaps are allowed (`太…了`, `又…又…`, `还没…呢`).
- Gap `alternatives` hold other valid words (帮 for 替, 能 for 可以).

### `text` — Translate, Transform, Correct, Situation (and some Choose)

```json
{
  "mode": "text", "type": "Transform", "instruction": "Make it negative",
  "prompt": "他睡得很好。", "context": "",
  "accepted": ["他睡得不好。", "他睡得不太好。"],
  "answer": "他睡得不好。"
}
```

- `prompt` is the English sentence (Translate, Situation) or the Chinese sentence to change
  (Transform, Correct).
- `accepted` must contain `answer` plus every valid variant, with punctuation.
- Correct prompts contain exactly one mistake; the instruction is always
  "The sentence has a mistake. Correct it."
- Typical Transform instructions: "Turn it into a question", "Make it negative",
  "Ask the same question without 吗", "Soften the request", "Add the duration: …".

### `tiles` — Order

```json
{
  "mode": "tiles", "type": "Order", "instruction": "Put the words in order",
  "prompt": "得 / 说 / 汉语 / 她 / 很流利 / 说",
  "tiles": ["得", "说", "汉语", "她", "很流利", "说"],
  "context": "She speaks Chinese very fluently.",
  "accepted": ["她说汉语说得很流利。"]
}
```

- `context` (English meaning) is shown on the front so the order is unambiguous.
- Every entry in `accepted` must be buildable from exactly all the tiles (e.g. time words at
  the start or after the subject).

### `choice` — Choose

```json
{
  "mode": "choice", "type": "Choose", "instruction": "Choose the correct sentence",
  "prompt": "She eats very slowly.",
  "options": ["她吃得饭很慢。", "她吃饭得很慢。", "她吃饭吃得很慢。"],
  "accepted": ["她吃饭吃得很慢。"]
}
```

- Use for genuine "which of these" contrasts (word order, 了 or not, 一般 vs 常常).
- Distractors should be the mistakes learners actually make, not obviously wrong strings.

### `reveal` — Read, Question

- For items that can't be auto-graded (readings of 数 / 称, meaning questions). The learner
  clicks "Show answer", then "I knew it" / "I missed it".
- Keep these rare; prefer a gradable mode.

## Grading behaviour (what authors can rely on)

- Answers are compared after removing spaces and punctuation, against `answer` /
  `accepted` / gap `alternatives`.
- **Numbered pinyin** is accepted anywhere Chinese is typed (`ni3 mang2 ma`, `wanr2`). Neutral
  tones may be written 0, 5 or with no number. Polyphones accept any valid reading,
  一/不 tone changes either way, and common neutral syllables (个, 了, 吗, 们, directional
  来/去, 朋友's 友…) may be toneless. A wrong tone or fully toneless answer is still wrong.
- **Try again**: after a miss the learner can edit and re-check. The first attempt is the
  score; retries are logged (`retries`, `retryCorrect`, `retryResponse`).
- **"My answer was also right"** (text mode) marks a miss as correct and logs `overridden`.
  If learners use it often on an exercise, its `accepted` list is missing variants.

## Pinyin style

Textbook style, as in NPCR: words joined (`gāoxìng`, `Hànyǔ`), syllables of phrases separated,
tone marks, neutral tones unmarked (`péngyou`, `zhège`, `shàng lóu qu le`), 一/不 tone changes
applied (`yí ge`, `bú shì`), capitalised first word and proper names (`Mǎ Dàwéi`, `Xī'ān`),
儿 attached (`wánr`).

## Grammar explanations (`grammar.json`)

One entry per `lesson` + `point`, shown by the card's **Show grammar** button:

- Textbook or slide content, translated to English, with the book page in `source`.
- Where the course material has no explanation, a write-up based on the
  [Chinese Grammar Wiki](https://resources.allsetlearning.com/chinese/grammar/) (AllSet
  Learning), in our own words, with `sourceUrl` / `sourceUrls` linking the articles used. Any
  entry using AllSet content must link to it.
- A new grammar point needs a `grammar.json` entry, or the panel says there is no explanation.

## Checklist for new exercises

1. `point` copied exactly from an existing point (or a new `grammar.json` entry added).
2. Instruction states the task without naming the form; no tips in the prompt.
3. Only one meaning fits the prompt; all natural variants are in `accepted` / `alternatives`.
4. Tiles can build every accepted answer; cloze segments + gap answers rebuild `answer`.
5. Pinyin hand-checked in textbook style, and accepted when typed as numbered pinyin.
6. Vocabulary from the current or earlier lessons.
7. Not a near-duplicate of an existing exercise.
8. Check in the app that each new exercise accepts its own answer, typed both in characters and
   in numbered pinyin.
