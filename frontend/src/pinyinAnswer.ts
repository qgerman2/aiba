// Accepts answers typed as numbered pinyin (ni3 hao3, wanr2, ma / ma0 / ma5).
// pinyin-pro is loaded lazily, only once the learner types Latin letters.

type PinyinFn = typeof import("pinyin-pro").pinyin;

let pinyinFn: PinyinFn | null = null;
let loading: Promise<PinyinFn> | null = null;

export function loadPinyin(): Promise<PinyinFn> {
  if (pinyinFn) return Promise.resolve(pinyinFn);
  loading ??= import("pinyin-pro").then((module) => {
    pinyinFn = module.pinyin;
    return pinyinFn;
  });
  return loading;
}

export function looksLikePinyin(value: string) {
  return /[a-zA-Z]/.test(value) && !/[㐀-鿿]/.test(value);
}

// Characters often read in the neutral tone in context (measure word 个, directional 来/去,
// 不/没 in A-not-A questions, 还是 shi…), even though dictionaries list a full tone.
const OFTEN_NEUTRAL = new Set([..."个么们子头来去上下里边面不没一是的得地了着过吗呢吧啊儿候西"]);

// Second syllables that are neutral in common words: 朋友, 多少, 衣服, 认识, 喜欢, 清楚, 漂亮…
const NEUTRAL_SECOND = new Set([..."友少服识欢气楚亮思生字方息宜和快诉系道烦情户算量白"]);

function isHan(char: string) {
  return /[㐀-鿿〇]/.test(char);
}

function normalizeInput(value: string) {
  return value
    .toLowerCase()
    .replace(/u:|ü/g, "v")
    .replace(/[^a-z0-9]/g, "")
    // "wan2r" -> "wanr2"
    .replace(/([1-5])r(?![aeiou]|ng?(?![aeiou]))/g, "r$1");
}

// Every acceptable typed form of one syllable, e.g. "ma0" -> ["ma", "ma0", "ma5"].
function typedForms(syllable: string): string[] {
  const match = /^([a-zv]+)([0-5])?$/.exec(syllable.replace(/ü/g, "v"));
  if (!match) return [];
  const [, base, tone = "0"] = match;
  return tone === "0" || tone === "5" ? [base, `${base}0`, `${base}5`] : [`${base}${tone}`];
}

/** Acceptable syllables for each Han character of `text`, read in the context of `context`. */
function syllableOptions(pinyin: PinyinFn, text: string, context?: { full: string; start: number }) {
  const full = context?.full ?? text;
  const start = context?.start ?? 0;
  const fullChars = [...full];
  const read = (toneSandhi: boolean) =>
    pinyin(full, { toneType: "num", type: "array", toneSandhi, nonZh: "spaced" });
  const withSandhi = read(true);
  const withoutSandhi = read(false);
  // pinyin-pro returns one item per Han char and one per non-Han char when nonZh is "spaced".
  const options: string[][] = [];
  [...text].forEach((char, offset) => {
    if (!isHan(char)) return;
    const index = start + offset;
    const set = new Set<string>();
    if (fullChars[index] === char) {
      set.add(withSandhi[index]);
      set.add(withoutSandhi[index]);
    }
    for (const reading of pinyin(char, { toneType: "num", type: "array", multiple: true })) {
      set.add(reading);
    }
    const previous = fullChars[index - 1];
    const afterHan = previous !== undefined && isHan(previous);
    if (OFTEN_NEUTRAL.has(char) || previous === char || (afterHan && NEUTRAL_SECOND.has(char))) {
      for (const reading of [...set]) set.add(reading.replace(/[1-4]$/, "0"));
    }
    options.push([...set].flatMap(typedForms));
  });
  return options;
}

function matches(input: string, options: string[][], chars: string[]) {
  const memo = new Map<string, boolean>();
  const walk = (position: number, index: number): boolean => {
    if (index === options.length) return position === input.length;
    const key = `${position}:${index}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let ok = false;
    // X儿 typed as one erhua syllable: "wanr2"
    if (chars[index + 1] === "儿") {
      for (const form of options[index]) {
        const erhua = form.replace(/^([a-z]+)([0-5]?)$/, "$1r$2");
        const bare = form.replace(/[0-5]$/, "") + "r";
        for (const candidate of new Set([erhua, bare])) {
          if (input.startsWith(candidate, position) && walk(position + candidate.length, index + 2)) {
            ok = true;
            break;
          }
        }
        if (ok) break;
      }
    }
    if (!ok) {
      for (const form of options[index]) {
        if (input.startsWith(form, position) && walk(position + form.length, index + 1)) {
          ok = true;
          break;
        }
      }
    }
    memo.set(key, ok);
    return ok;
  };
  return walk(0, 0);
}

/** True if `typed` is a numbered-pinyin rendering of `answer`. */
export function pinyinMatches(
  pinyin: PinyinFn,
  typed: string,
  answer: string,
  context?: { full: string; start: number }
) {
  const input = normalizeInput(typed);
  if (!input) return false;
  const chars = [...answer].filter(isHan);
  if (chars.length === 0) return false;
  return matches(input, syllableOptions(pinyin, answer, context), chars);
}
