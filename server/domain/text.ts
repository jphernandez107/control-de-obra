/** Lowercase, accent-free, single-spaced text for matching. Keeps "ø" as "o". */
export function normalizeText(text: string): string {
  return text
    .replace(/³/g, "3")
    .replace(/²/g, "2")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[øØ⌀]/g, " o")
    .replace(/[“”"'`´]/g, "")
    .replace(/[^a-z0-9.,/\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalized order/remito reference: "N.º 0038" → "38", "A-1043" → "a1043". */
export function normalizeReference(ref: string): string {
  return normalizeText(ref)
    .replace(/^(pedido|orden|remito|n\.?o?|nro\.?|numero|#)\s*/g, "")
    .replace(/[\s\-./]/g, "")
    .replace(/^0+(?=\w)/, "");
}

const STOPWORDS = new Set(["de", "del", "la", "las", "el", "los", "y", "a", "al", "en", "para", "con", "x", "por", "un", "una", "unos", "unas"]);

function singular(word: string): string {
  if (word.length > 4 && word.endsWith("es") && !/[aeiou]es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

export function tokens(text: string): string[] {
  return normalizeText(text)
    .split(/[\s/,-]+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map(singular);
}

export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((w) => w.length > 2 && !["del", "las", "los"].includes(w.toLowerCase()));
  return (words.length ? words : name.split(/\s+/))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}
