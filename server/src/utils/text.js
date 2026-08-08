/**
 * Cheap text helpers used for local filtering and repetition checks.
 * Deliberately dependency-free: this runs before any LLM call, on every article.
 */

/** Words carrying no topical signal, so they never become match keywords. */
const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','been','but','by','can','could','did','do','does','for','from',
  'had','has','have','how','in','into','is','it','its','just','may','might','more','most','new','no',
  'not','now','of','on','or','other','our','out','over','said','says','should','so','than','that','the',
  'their','them','then','there','these','they','this','to','under','up','use','used','using','via','was',
  'we','were','what','when','which','while','who','why','will','with','would','you','your','about',
  'after','again','all','also','any','because','before','being','between','both','during','each','if',
  'only','same','such','through','too','very','one','two','get','gets','make','makes','way','many',
]);

/**
 * Lowercase, strip punctuation/diacritics, collapse whitespace.
 * Possessives are removed rather than merged, so "OpenAI's model" and
 * "OpenAI model" produce the same tokens instead of `openais` vs `openai`.
 */
export function normalizeText(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Stable comparison key for a topic. Sorting the tokens means
 * "prompt injection in agents" and "agents and prompt injection" collide,
 * which is what repetition detection wants.
 */
export function normalizeTopic(value = '') {
  const tokens = normalizeText(value)
    .split(' ')
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
  return [...new Set(tokens)].sort().join(' ');
}

/** Content-bearing keywords, longest-first, capped. */
export function extractKeywords(value = '', limit = 12) {
  const counts = new Map();
  for (const word of normalizeText(value).split(' ')) {
    if (word.length <= 2 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([word]) => word);
}

/** Jaccard overlap of two token sets, 0..1. */
export function jaccardSimilarity(a = [], b = []) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const item of setA) if (setB.has(item)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/** Number of tokens the two sets have in common. */
export function sharedTokenCount(a = [], b = []) {
  const setB = new Set(b);
  let shared = 0;
  for (const item of new Set(a)) if (setB.has(item)) shared += 1;
  return shared;
}

/**
 * Overlap coefficient: shared tokens over the *smaller* set, 0..1.
 *
 * Jaccard punishes length differences, which matters because two outlets
 * rarely write headlines of the same length — "Critical RCE in an inference
 * server" and "Critical remote code execution flaw in a popular inference
 * server" are one story, but Jaccard scores them apart. Containment does not,
 * so dedup uses both signals.
 */
export function containment(a = [], b = []) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (!setA.size || !setB.size) return 0;
  return sharedTokenCount(setA, setB) / Math.min(setA.size, setB.size);
}

/** Canonical URL for dedup: drops tracking params, fragments, trailing slash. */
export function canonicalizeUrl(value = '') {
  try {
    const url = new URL(String(value).trim());
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref|referrer|source|fbclid|gclid|mc_)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.replace(/^www\./, '').toLowerCase();
    url.protocol = 'https:';
    let out = url.toString();
    if (out.endsWith('/') && url.pathname !== '/') out = out.slice(0, -1);
    return out;
  } catch {
    return String(value).trim();
  }
}
