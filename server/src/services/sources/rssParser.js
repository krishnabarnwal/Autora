/**
 * Minimal RSS 2.0 / Atom / RDF parser.
 *
 * Hand-rolled on purpose: the agent only needs five fields per entry, and the
 * project rule is to avoid dependencies that do not earn their weight. It is
 * deliberately tolerant — real feeds ship unescaped ampersands, stray HTML and
 * mismatched namespaces, and a single bad entry must not lose the whole feed.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
};

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 ? String.fromCodePoint(point) : match;
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function unwrapCdata(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function stripHtml(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

function collapse(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/** Plain text from a feed field: CDATA out, entities decoded, markup removed. */
function toText(raw) {
  if (!raw) return '';
  // Decoded twice: many feeds escape their HTML, so tags only appear as
  // &lt;p&gt; until the first pass has run.
  const once = decodeEntities(unwrapCdata(raw));
  return collapse(decodeEntities(stripHtml(once)));
}

/** First matching child element's inner text. Namespace prefixes are ignored. */
function tag(block, ...names) {
  for (const name of names) {
    const local = name.replace(':', '\\:');
    const pattern = new RegExp(`<(?:[a-z0-9]+:)?${local}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-z0-9]+:)?${local}>`, 'i');
    const match = pattern.exec(block);
    if (match && collapse(unwrapCdata(match[1]))) return match[1];
  }
  return '';
}

/**
 * Entry link. RSS puts the URL in <link>text</link>; Atom uses a self-closing
 * <link href> and may list several, so rel="self"/"replies" are skipped.
 */
function extractLink(block) {
  const inline = toText(tag(block, 'link'));
  if (/^https?:\/\//i.test(inline)) return inline;

  const candidates = [...block.matchAll(/<(?:[a-z0-9]+:)?link\b([^>]*)>/gi)].map(([, attrs]) => attrs);
  const hrefOf = (attrs) => {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs);
    return href ? decodeEntities(href[1].trim()) : '';
  };
  const relOf = (attrs) => (/\brel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] || '').toLowerCase();

  const alternate = candidates.find((attrs) => relOf(attrs) === 'alternate' && hrefOf(attrs));
  if (alternate) return hrefOf(alternate);
  const unlabelled = candidates.find((attrs) => !relOf(attrs) && hrefOf(attrs));
  if (unlabelled) return hrefOf(unlabelled);

  // Some feeds only carry a usable URL in the identifier.
  for (const name of ['guid', 'id']) {
    const value = toText(tag(block, name));
    if (/^https?:\/\//i.test(value)) return value;
  }
  return '';
}

const ENTRY_PATTERN = /<(?:[a-z0-9]+:)?(item|entry)\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?\1>/gi;

/**
 * Parse feed XML into raw entries. Field names stay close to the feed formats;
 * normalize.js turns these into the agent's topic shape.
 *
 * @param {string} xml
 * @returns {{feedTitle: string, entries: Array<object>}}
 * @throws {Error} code `feed_unrecognized` when the payload is not a feed
 */
export function parseFeed(xml) {
  const text = typeof xml === 'string' ? xml : '';
  const looksLikeFeed = /<(?:[a-z0-9]+:)?(rss|feed|rdf)\b/i.test(text);
  const hasEntries = /<(?:[a-z0-9]+:)?(item|entry)\b/i.test(text);

  if (!looksLikeFeed && !hasEntries) {
    const error = new Error('Response is not an RSS or Atom feed');
    error.code = 'feed_unrecognized';
    throw error;
  }

  // Channel/feed title lives outside the entries, so entry blocks are removed
  // first to stop an entry's own <title> from winning.
  const header = text.replace(ENTRY_PATTERN, ' ');
  const feedTitle = toText(tag(header, 'title'));

  const entries = [];
  for (const [, , block] of text.matchAll(ENTRY_PATTERN)) {
    entries.push({
      title: toText(tag(block, 'title')),
      url: extractLink(block),
      summary: toText(tag(block, 'description', 'summary', 'content:encoded', 'content', 'subtitle')),
      publishedAt: toText(tag(block, 'pubDate', 'published', 'updated', 'dc:date', 'date', 'created')),
      author: toText(tag(block, 'creator', 'author', 'name')),
      categories: [...block.matchAll(/<(?:[a-z0-9]+:)?category\b[^>]*>([\s\S]*?)<\//gi)]
        .map(([, value]) => toText(value))
        .filter(Boolean),
    });
  }

  return { feedTitle, entries };
}
