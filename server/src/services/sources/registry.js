/**
 * The source catalogue.
 *
 * Free, public, key-less feeds only. Several sources per topic area on purpose:
 * feeds go down, rebrand, or fall silent, and the agent must keep discovering
 * topics when any one of them does.
 *
 * tier drives source-quality scoring in Phase 7:
 *   primary    — vendor/research security teams and standards bodies; disclosures first-hand
 *   secondary  — established security and AI trade press
 *   aggregator — community signal; useful for breadth, weakest for authority
 *
 * tags are matched against the persona's domain and interests, so a persona
 * outside AI security still selects sensibly from this catalogue.
 */
import { createRssSource } from './rssAdapter.js';
import { createHackerNewsSource } from './hackerNewsAdapter.js';

/** @type {Array<object>} */
export const SOURCE_DEFINITIONS = [
  // --- AI security / LLM security, the persona's core beat ---
  { id: 'simon-willison', name: 'Simon Willison', kind: 'rss', tier: 'primary',
    url: 'https://simonwillison.net/atom/everything/',
    tags: ['ai', 'llm', 'ai security', 'prompt injection', 'agents'] },
  // The /tag/ feed for this blog exists but is permanently empty; /category/ carries the posts.
  { id: 'nvidia-ai-security', name: 'NVIDIA Technical Blog', kind: 'rss', tier: 'primary',
    url: 'https://developer.nvidia.com/blog/category/cybersecurity/feed/',
    tags: ['ai', 'ai security', 'model security', 'infrastructure'] },
  { id: 'google-security-blog', name: 'Google Online Security Blog', kind: 'rss', tier: 'primary',
    url: 'https://security.googleblog.com/feeds/posts/default',
    tags: ['security', 'ai security', 'vulnerabilities', 'infrastructure'] },
  { id: 'microsoft-security', name: 'Microsoft Security Blog', kind: 'rss', tier: 'primary',
    url: 'https://www.microsoft.com/en-us/security/blog/feed/',
    tags: ['security', 'ai security', 'threat intelligence', 'infrastructure'] },
  // Blogger's default feed inlines every post in full and blows the response
  // size cap; the summary feed carries the same headlines in a few KB.
  { id: 'project-zero', name: 'Google Project Zero', kind: 'rss', tier: 'primary',
    url: 'https://googleprojectzero.blogspot.com/feeds/posts/summary?alt=rss&max-results=25',
    tags: ['security', 'vulnerabilities', 'exploits'] },
  { id: 'trail-of-bits', name: 'Trail of Bits', kind: 'rss', tier: 'primary',
    url: 'https://blog.trailofbits.com/feed/',
    tags: ['security', 'ai security', 'research', 'vulnerabilities', 'model security'] },
  { id: 'unit42', name: 'Unit 42', kind: 'rss', tier: 'primary',
    url: 'https://unit42.paloaltonetworks.com/feed/',
    tags: ['security', 'threat intelligence', 'ai security', 'vulnerabilities'] },

  // --- Research preprints: where novel attacks appear first ---
  // Empty on weekends by design — the feed itself declares <skipDays>. Zero
  // items from these two on a Saturday is correct, not a broken source.
  { id: 'arxiv-cs-cr', name: 'arXiv cs.CR', kind: 'rss', tier: 'primary',
    url: 'https://rss.arxiv.org/rss/cs.CR',
    tags: ['research', 'security', 'ai security', 'cryptography', 'model security'] },
  { id: 'arxiv-cs-ai', name: 'arXiv cs.AI', kind: 'rss', tier: 'primary',
    url: 'https://rss.arxiv.org/rss/cs.AI',
    tags: ['research', 'ai', 'llm', 'agents'] },

  // --- Standards and advisories ---
  { id: 'cisa-advisories', name: 'CISA Advisories', kind: 'rss', tier: 'primary',
    url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml',
    tags: ['security', 'vulnerabilities', 'advisories', 'infrastructure'] },

  // --- Security trade press ---
  { id: 'the-hacker-news', name: 'The Hacker News', kind: 'rss', tier: 'secondary',
    url: 'https://feeds.feedburner.com/TheHackersNews',
    tags: ['security', 'ai security', 'vulnerabilities', 'breaches'] },
  { id: 'bleeping-computer', name: 'BleepingComputer', kind: 'rss', tier: 'secondary',
    url: 'https://www.bleepingcomputer.com/feed/',
    tags: ['security', 'vulnerabilities', 'breaches', 'malware'] },
  { id: 'securityweek', name: 'SecurityWeek', kind: 'rss', tier: 'secondary',
    url: 'https://www.securityweek.com/feed/',
    tags: ['security', 'ai security', 'vulnerabilities', 'industry'] },
  { id: 'dark-reading', name: 'Dark Reading', kind: 'rss', tier: 'secondary',
    url: 'https://www.darkreading.com/rss.xml',
    tags: ['security', 'ai security', 'threat intelligence', 'industry'] },
  { id: 'schneier', name: 'Schneier on Security', kind: 'rss', tier: 'secondary',
    url: 'https://www.schneier.com/feed/atom/',
    tags: ['security', 'ai security', 'policy', 'cryptography'] },

  // --- AI labs and AI press: model releases, capability and safety work ---
  { id: 'openai-news', name: 'OpenAI News', kind: 'rss', tier: 'primary',
    url: 'https://openai.com/news/rss.xml',
    tags: ['ai', 'llm', 'model security', 'research'] },
  { id: 'deepmind', name: 'Google DeepMind', kind: 'rss', tier: 'primary',
    url: 'https://deepmind.google/blog/rss.xml',
    tags: ['ai', 'llm', 'research', 'model security'] },
  { id: 'huggingface', name: 'Hugging Face Blog', kind: 'rss', tier: 'secondary',
    url: 'https://huggingface.co/blog/feed.xml',
    tags: ['ai', 'llm', 'models', 'open source', 'model security'] },
  { id: 'aws-security-blog', name: 'AWS Security Blog', kind: 'rss', tier: 'primary',
    url: 'https://aws.amazon.com/blogs/security/feed/',
    tags: ['security', 'infrastructure', 'cloud', 'ai security'] },
  { id: 'mit-tech-review-ai', name: 'MIT Technology Review AI', kind: 'rss', tier: 'secondary',
    url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed',
    tags: ['ai', 'llm', 'policy', 'technology'] },
  { id: 'venturebeat-ai', name: 'VentureBeat AI', kind: 'rss', tier: 'secondary',
    url: 'https://venturebeat.com/category/ai/feed/',
    tags: ['ai', 'llm', 'agents', 'industry'] },

  // --- Community signal, JSON rather than RSS ---
  // One concept per query: see the note on boolean syntax in hackerNewsAdapter.js.
  { id: 'hn-ai-security', name: 'Hacker News (AI security)', kind: 'hackernews', tier: 'aggregator',
    query: 'AI security', minPoints: 3,
    tags: ['ai security', 'llm', 'prompt injection', 'community'] },
  { id: 'hn-ai-agents', name: 'Hacker News (AI agents)', kind: 'hackernews', tier: 'aggregator',
    query: 'AI agents', minPoints: 10,
    tags: ['ai', 'agents', 'llm', 'community'] },
];

const BUILDERS = { rss: createRssSource, hackernews: createHackerNewsSource };

/**
 * Instantiate adapters from definitions.
 *
 * @param {{only?: string[], exclude?: string[], definitions?: object[]}} options
 * @returns {Array<{id:string,name:string,kind:string,tier:string,tags:string[],collect:Function}>}
 */
export function buildSources(options = {}) {
  const { only, exclude = [], definitions = SOURCE_DEFINITIONS } = options;
  return definitions
    .filter((def) => (only ? only.includes(def.id) : true))
    .filter((def) => !exclude.includes(def.id))
    .map((def) => {
      const build = BUILDERS[def.kind];
      if (!build) throw new Error(`Unknown source kind "${def.kind}" for source "${def.id}"`);
      return build(def);
    });
}

/** Every configured source, adapters built. */
export function defaultSources() {
  return buildSources();
}
