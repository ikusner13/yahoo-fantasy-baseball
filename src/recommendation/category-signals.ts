import type { Category } from "../types";

const CATEGORY_PATTERNS: Array<{ category: Category; patterns: RegExp[] }> = [
  { category: "RBI", patterns: [/\bRBI\b/i, /\bruns batted in\b/i] },
  { category: "OBP", patterns: [/\bOBP\b/i, /\bon-base percentage\b/i] },
  { category: "WHIP", patterns: [/\bWHIP\b/i] },
  { category: "ERA", patterns: [/\bERA\b/i] },
  { category: "SVHD", patterns: [/\bSVHD\b/i, /\bSV\+H(?:LD)?\b/i, /\bsaves?\b/i, /\bholds?\b/i] },
  { category: "QS", patterns: [/\bQS\b/i, /\bquality starts?\b/i] },
  { category: "OUT", patterns: [/\bOUT\b/i, /\bouts\b/i] },
  { category: "TB", patterns: [/\bTB\b/i, /\btotal bases?\b/i] },
  { category: "HR", patterns: [/\bHR\b/i, /\bhome runs?\b/i] },
  { category: "SB", patterns: [/\bSB\b/i, /\bstolen bases?\b/i] },
  { category: "K", patterns: [/\bK\b/i, /\bstrikeouts?\b/i] },
  { category: "H", patterns: [/\bH\b/i, /\bhits\b/i] },
  { category: "R", patterns: [/\bR\b/i, /\bruns\b/i] },
];

export function extractMentionedCategories(
  ...texts: Array<string | null | undefined>
): Category[] {
  const haystack = texts.filter(Boolean).join(" ");
  if (!haystack) return [];

  const categories: Category[] = [];
  for (const entry of CATEGORY_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(haystack))) {
      categories.push(entry.category);
    }
  }
  return categories;
}

