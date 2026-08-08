/**
 * Persona-domain relevance, computed locally (Phase 7).
 *
 * Deterministic keyword matching, no LLM. The point is to spend zero tokens
 * discarding the ~90% of a news feed that has nothing to do with the persona,
 * so the editorial call in Phase 9 only ever sees plausible candidates.
 *
 * The lexicon expands a persona's own words; it does not replace them. A
 * persona outside AI security still scores sensibly from its domain and
 * interests alone, which is why Sentinel is a default and not a hard-coding.
 */
import { normalizeText, extractKeywords } from '../../utils/text.js';

/**
 * Concept groups. `triggers` decide whether a group applies to a persona;
 * `terms` are what we then look for in article text.
 */
export const CONCEPTS = [
  {
    id: 'ai',
    triggers: ['ai', 'artificial intelligence', 'machine learning', 'ml', 'llm', 'genai', 'model'],
    terms: ['ai', 'artificial intelligence', 'machine learning', 'llm', 'large language model',
      'chatbot', 'gpt', 'claude', 'gemini', 'llama', 'mistral', 'deepseek', 'transformer',
      'neural network', 'foundation model', 'frontier model', 'fine tuning', 'inference',
      'embedding', 'rag', 'retrieval augmented generation', 'multimodal', 'open weight',
      'training data', 'benchmark', 'reasoning model'],
  },
  {
    id: 'security',
    triggers: ['security', 'cyber', 'cybersecurity', 'infosec', 'vulnerability', 'threat', 'hacking'],
    terms: ['security', 'vulnerability', 'exploit', 'cve', 'zero day', 'patch', 'breach', 'attack',
      'attacker', 'malware', 'ransomware', 'phishing', 'backdoor', 'privilege escalation',
      'authentication', 'authorization', 'encryption', 'threat actor', 'incident response',
      'disclosure', 'advisory', 'bug bounty', 'red team', 'penetration testing', 'credential',
      'data leak', 'botnet', 'command injection', 'remote code execution'],
  },
  {
    id: 'ai-security',
    triggers: ['ai security', 'llm security', 'model security', 'prompt injection', 'ai safety',
      'agent security', 'ai risk', 'ai infrastructure security'],
    terms: ['prompt injection', 'indirect prompt injection', 'jailbreak', 'jailbreaking',
      'system prompt leak', 'data exfiltration', 'model extraction', 'model inversion',
      'membership inference', 'data poisoning', 'model poisoning', 'adversarial example',
      'adversarial attack', 'guardrail', 'alignment', 'ai red teaming', 'model weights',
      'weight exfiltration', 'supply chain attack', 'malicious model', 'pickle deserialization',
      'safetensors', 'sandbox escape', 'excessive agency', 'owasp llm', 'ai firewall',
      'content filter bypass', 'unsafe output', 'hallucination', 'deepfake', 'ai governance'],
  },
  {
    id: 'agents',
    triggers: ['agent', 'agents', 'agentic', 'autonomous', 'automation'],
    terms: ['agent', 'agentic', 'autonomous agent', 'multi agent', 'tool calling',
      'function calling', 'mcp', 'model context protocol', 'orchestration', 'browser agent',
      'computer use', 'copilot', 'coding agent', 'agent framework'],
  },
  {
    id: 'infrastructure',
    triggers: ['infrastructure', 'cloud', 'devops', 'platform', 'mlops', 'systems'],
    terms: ['kubernetes', 'container', 'docker', 'cloud', 'aws', 'azure', 'gcp', 'api gateway',
      'ci cd', 'serverless', 'gpu', 'inference server', 'vector database', 'deployment',
      'observability', 'sbom', 'dependency'],
  },
  {
    id: 'policy',
    triggers: ['policy', 'regulation', 'governance', 'compliance', 'law', 'ethics', 'privacy'],
    terms: ['regulation', 'eu ai act', 'compliance', 'governance', 'nist', 'iso 42001',
      'executive order', 'audit', 'privacy', 'gdpr', 'liability', 'standard'],
  },
];

/** Raw score at which an item is considered fully on-topic. */
const SATURATION = 18;
/** Multi-word matches are far stronger evidence than a single common word. */
const PHRASE_BONUS = 1.6;

const pad = (value) => ` ${normalizeText(value)} `;

/** Word-boundary occurrence count of an already-normalized term. */
function countTerm(paddedHaystack, term) {
  const needle = ` ${term} `;
  let count = 0;
  let index = paddedHaystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = paddedHaystack.indexOf(needle, index + needle.length - 1);
  }
  return count;
}

function addTerm(map, term, weight) {
  const key = normalizeText(term);
  if (!key || key.length < 2) return;
  map.set(key, Math.max(map.get(key) || 0, weight));
}

/**
 * Build the matcher for a persona once per cycle, then reuse it per item.
 *
 * @param {{name?:string, domain?:string, interests?:string[], identity?:string}} persona
 * @returns {{domain:string, terms:Map<string,number>, core:Set<string>, concepts:string[]}}
 */
export function buildPersonaProfile(persona = {}) {
  const domain = normalizeText(persona.domain || '');
  const interests = (persona.interests || []).map((interest) => normalizeText(interest)).filter(Boolean);
  const identity = normalizeText(persona.identity || '');

  const terms = new Map();
  const core = new Set();

  const markCore = (term, weight) => {
    addTerm(terms, term, weight);
    const key = normalizeText(term);
    if (key) core.add(key);
  };

  // The persona's own words are the strongest signal available.
  if (domain) markCore(domain, 3);
  for (const keyword of extractKeywords(domain, 6)) markCore(keyword, 2);
  for (const interest of interests) {
    markCore(interest, 3);
    for (const keyword of extractKeywords(interest, 4)) markCore(keyword, 2);
  }

  // Concepts triggered by the domain are core; those only implied by interests
  // or identity are supporting signal.
  const concepts = [];
  const interestBlob = ` ${[...interests, identity].join(' ')} `;
  const domainBlob = ` ${domain} `;

  for (const concept of CONCEPTS) {
    const inDomain = concept.triggers.some((trigger) => domainBlob.includes(` ${normalizeText(trigger)} `));
    const inInterests = concept.triggers.some((trigger) => interestBlob.includes(` ${normalizeText(trigger)} `));
    if (!inDomain && !inInterests) continue;

    concepts.push(concept.id);
    for (const term of concept.terms) {
      if (inDomain) markCore(term, 2);
      else addTerm(terms, term, 1.25);
    }
  }

  return { domain, terms, core, concepts };
}

/**
 * Score one item against a persona profile.
 *
 * @returns {{score:number, raw:number, coreHits:number, matched:string[]}}
 *   score is 0..1; coreHits counts matches on the persona's own beat.
 */
export function scoreRelevance(item = {}, profile) {
  const title = pad(item.title || '');
  // Deliberately excludes sourceTags: those describe the feed, not the article.
  // Counting them would make every item from a security feed look on-topic,
  // which is exactly the mistake this filter exists to prevent.
  const body = pad([item.summary || '', (item.categories || []).join(' ')].join(' '));

  let raw = 0;
  let coreHits = 0;
  const matched = [];

  for (const [term, weight] of profile.terms) {
    const inTitle = countTerm(title, term);
    // Counted once per term: repetition inside one article is not new evidence.
    const hit = inTitle > 0 ? 2 : (countTerm(body, term) > 0 ? 1 : 0);
    if (!hit) continue;

    raw += weight * (term.includes(' ') ? PHRASE_BONUS : 1) * hit;
    matched.push(term);
    if (profile.core.has(term)) coreHits += 1;
  }

  return {
    score: Math.min(1, raw / SATURATION),
    raw: Number(raw.toFixed(2)),
    coreHits,
    matched: matched.sort((a, b) => b.length - a.length).slice(0, 8),
  };
}
