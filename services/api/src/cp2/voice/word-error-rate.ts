/**
 * Word error rate for the voice eval: (substitutions + deletions + insertions) / reference words,
 * on words lowercased with punctuation removed, thousands commas dropped and number words read as
 * digits ("1,250" matches "one thousand two hundred and fifty").
 */
const units: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
};
const scales: Readonly<Record<string, number>> = { hundred: 100, thousand: 1000, million: 1e6 };

const digitWords: Readonly<Record<string, string>> = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9"
};

/** Reads one cardinal starting at `from`; returns its value and the index after it. */
function readCardinal(words: string[], from: number): { value: number; next: number } {
  let total = 0;
  let group = units[words[from]!]!;
  let last: "unit" | "tens" | "hundred" | "scale" = group >= 20 ? "tens" : "unit";
  // Each thousand-scale may appear once, in falling order: "two thousand three thousand" is two
  // numbers, "five hundred thousand" is one.
  let smallestScale = Infinity;
  let at = from + 1;
  for (; at < words.length; at += 1) {
    const word = words[at]!;
    const value = Object.hasOwn(units, word) ? units[word]! : undefined;
    if (value !== undefined) {
      if (last === "tens" && value < 10) group += value;
      // A unit that a scale word follows starts a new number when that scale could not continue
      // this one ("one hundred | one hundred", "two thousand | three thousand").
      else if (
        (last === "hundred" || last === "scale") &&
        (words[at + 1] === "hundred"
          ? last === "hundred"
          : Object.hasOwn(scales, words[at + 1] ?? "") && scales[words[at + 1]!]! >= smallestScale)
      )
        break;
      else if ((last === "hundred" || last === "scale") && group % 100 === 0) group += value;
      else break;
      last = value >= 20 ? "tens" : "unit";
    } else if (word === "hundred" && last !== "hundred" && group > 0 && group < 100) {
      group *= 100;
      last = "hundred";
    } else if (Object.hasOwn(scales, word) && word !== "hundred" && group > 0) {
      const scale = scales[word]!;
      if (scale >= smallestScale) break;
      total += group * scale;
      group = 0;
      smallestScale = scale;
      last = "scale";
    } else if (
      word === "and" &&
      (last === "hundred" || last === "scale") &&
      Object.hasOwn(units, words[at + 1] ?? "")
    )
      continue;
    else break;
  }
  return { value: total + group, next: at };
}

/**
 * English number words as digits, so a model that writes numerals is not scored as wrong:
 * "one thousand two hundred and fifty" -> "1250", "nineteen eighty four" -> "1984" (a year said
 * as two pairs), "one point five" -> "1.5". Separate numbers stay separate ("one two three",
 * "two and three", "one hundred one hundred").
 */
function numeralize(words: string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < words.length) {
    if (!Object.hasOwn(units, words[index]!)) {
      out.push(words[index]!);
      index += 1;
      continue;
    }
    let { value, next } = readCardinal(words, index);
    // A year as two pairs: 10-99 then 10-99, with no scale word in either ("twenty twenty").
    if (
      value >= 10 &&
      value <= 99 &&
      next - index <= 2 &&
      Object.hasOwn(units, words[next] ?? "")
    ) {
      const second = readCardinal(words, next);
      if (second.value >= 10 && second.value <= 99 && second.next - next <= 2) {
        value = value * 100 + second.value;
        next = second.next;
      }
    }
    // "nineteen oh five" -> 1905.
    if (value >= 10 && value <= 99 && next - index === 1 && words[next] === "oh") {
      const digit = units[words[next + 1] ?? ""];
      if (digit !== undefined && digit >= 1 && digit <= 9) {
        value = value * 100 + digit;
        next += 2;
      }
    }
    let text = String(value);
    if (words[next] === "point" && Object.hasOwn(digitWords, words[next + 1] ?? "")) {
      let decimals = "";
      next += 1;
      while (Object.hasOwn(digitWords, words[next] ?? "")) decimals += digitWords[words[next++]!];
      text = `${text}.${decimals}`;
    }
    out.push(text);
    index = next;
  }
  return out;
}

export function normalizeWords(text: string): string[] {
  return numeralize(normalizeTokens(text));
}

function normalizeTokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      // Thousands commas only inside a properly grouped number ("1,250", "12,500,000").
      .replace(/\b\d{1,3}(?:,\d{3})+\b/gu, (grouped) => grouped.replace(/,/gu, ""))
      // Keep a decimal point between digits ("1.5"); every other mark becomes a space.
      .replace(/[^\p{L}\p{N}\s'.]/gu, " ")
      .replace(/(?<!\d)\.|\.(?!\d)/gu, " ")
      .replace(/'/gu, "")
      .split(/\s+/u)
      .filter(Boolean)
  );
}

export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  let previous = Array.from({ length: hyp.length + 1 }, (_, index) => index);
  for (let i = 1; i <= ref.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= hyp.length; j += 1)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
      );
    previous = current;
  }
  return previous[hyp.length]! / ref.length;
}
