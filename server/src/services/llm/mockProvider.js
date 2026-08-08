/**
 * Deterministic mock provider.
 *
 * Two jobs, and they pull in the same direction:
 *
 *  - Tests drive it through a script to reproduce every failure the real
 *    provider can produce — malformed output, timeouts, rate limits, retries —
 *    without a network or a key.
 *  - Demo mode (LLM_PROVIDER=mock) runs the whole agent end to end on zero
 *    quota, which matters when an evaluator may watch for 48 hours.
 *
 * Determinism is the contract: the same prompt and schema always yield the same
 * object. Responses are synthesized *from the caller's schema*, so this file
 * needs no knowledge of what later phases will ask for — and contains no
 * editorial logic, which belongs to Phase 9.
 */
import { LlmError, llmError } from './errors.js';
import { parseJsonWithSchema } from './json.js';
import { estimateTokens, usageTracker } from './usage.js';
import { runWithRetries } from './retry.js';

/** FNV-1a: small, stable across runs, and good enough to pick a variant. */
function hash(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

const pick = (list, seed) => list[seed % list.length];

/** Sentences long enough to survive a minLength, short enough to stay cheap. */
const SENTENCES = [
  'The mechanism is described in enough detail to be verified independently.',
  'Corroborating reports from a second outlet raise confidence in the finding.',
  'The affected component is widely deployed, which makes the impact concrete.',
  'The disclosure includes a reproduction path rather than a vendor summary.',
];

const HEADLINES = [
  'A concrete failure in a widely deployed system',
  'What this disclosure actually changes',
  'The mechanism behind this week\'s advisory',
];

/**
 * Pull candidate titles out of a prompt, if it carries any.
 *
 * Demo output that echoes a real headline reads as a working agent; output full
 * of "string-1" reads as a stub. This only ever takes the first candidate — a
 * fixed choice, not a judgement, since selection is Phase 9's job.
 */
function firstCandidateTitle(prompt) {
  const match = String(prompt).match(/"title"\s*:\s*"((?:[^"\\]|\\.){4,200})"/);
  return match ? match[1].replace(/\\"/g, '"') : null;
}

/** Build a schema-valid value deterministically from a seed. */
function synthesize(schema, seed, context = {}) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.enum?.length) return pick(schema.enum, seed);

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case 'string': {
      const name = (context.key || '').toLowerCase();
      let value;
      if (/(title|headline|topic|subject)/.test(name) && context.candidateTitle) {
        value = context.candidateTitle;
      } else if (/(rationale|reason|why|justification|explanation)/.test(name)) {
        value = pick(SENTENCES, seed);
      } else if (/(text|body|content|post|draft)/.test(name)) {
        value = `${context.candidateTitle || pick(HEADLINES, seed)}\n\n${pick(SENTENCES, seed)} ${pick(SENTENCES, seed + 1)}`;
      } else if (/(url|link|source)/.test(name)) {
        value = context.candidateUrl || 'https://example.com/mock-source';
      } else if (/(id|slug)/.test(name)) {
        value = `mock-${seed % 1000}`;
      } else {
        value = pick(HEADLINES, seed);
      }
      if (schema.minLength && value.length < schema.minLength) {
        // Pad with real sentences rather than filler so the demo still reads well.
        let index = 0;
        while (value.length < schema.minLength) {
          value += ` ${pick(SENTENCES, seed + index)}`;
          index += 1;
        }
      }
      if (schema.maxLength && value.length > schema.maxLength) value = value.slice(0, schema.maxLength);
      return value;
    }
    case 'integer':
    case 'number': {
      const min = schema.minimum ?? 1;
      const max = schema.maximum ?? min + 9;
      const span = Math.max(0, max - min);
      const raw = min + (span ? seed % (span + 1) : 0);
      return type === 'integer' ? Math.round(raw) : Number(raw.toFixed(2));
    }
    case 'boolean':
      return seed % 2 === 0;
    case 'array': {
      const count = Math.max(schema.minItems ?? 1, 1);
      const capped = Math.min(count, schema.maxItems ?? count);
      return Array.from({ length: capped }, (_unused, index) =>
        synthesize(schema.items || { type: 'string' }, seed + index * 7, context));
    }
    case 'object':
    default: {
      const out = {};
      for (const [key, child] of Object.entries(schema.properties || {})) {
        out[key] = synthesize(child, hash(`${seed}:${key}`), { ...context, key });
      }
      return out;
    }
  }
}

/**
 * @param {{
 *   model?: string, usage?: object, retries?: number,
 *   script?: Array<object> | object | ((prompt: string, options: object) => object),
 *   latencyMs?: number
 * }} options `script` entries: {json}, {text}, {raw}, or {error: <code>}.
 *   A caller may pass the same shape per call as `options.fallbackScript`, used
 *   only when no constructor script is set.
 */
export function createMockProvider(options = {}) {
  const {
    model = 'mock-1',
    usage = usageTracker,
    retries = 1,
    script,
    latencyMs = 0,
  } = options;

  let cursor = 0;
  const calls = [];

  /**
   * What should this attempt do? Scripted entries win; otherwise synthesize.
   *
   * Precedence is deliberate. A constructor `script` is a test harness saying
   * "produce exactly this", and it must always win. `callOptions.fallbackScript`
   * is a caller saying "when nobody scripted me, this is coherent output for my
   * schema" — needed because synthesize() builds each field independently and so
   * cannot honour a cross-field rule like "skip implies a null index". Reversing
   * the order would let a caller's default silence a test's scripted failure.
   */
  function behaviourFor(prompt, callOptions) {
    const active = script ?? callOptions.fallbackScript;
    if (typeof active === 'function') return active(prompt, callOptions) || {};
    if (Array.isArray(active)) {
      // The last entry repeats, so a one-entry script covers every call.
      const entry = active[Math.min(cursor, active.length - 1)];
      cursor += 1;
      return entry || {};
    }
    if (active && typeof active === 'object') return active;
    return {};
  }

  async function callOnce(prompt, callOptions) {
    if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));

    const behaviour = behaviourFor(prompt, callOptions);

    if (behaviour.error) {
      throw behaviour.error instanceof Error
        ? behaviour.error
        : llmError(behaviour.message || `Mock provider failure (${behaviour.error})`, behaviour.error, { provider: 'mock', model });
    }

    let text;
    if (typeof behaviour.raw === 'string') {
      text = behaviour.raw;
    } else if (behaviour.json !== undefined) {
      text = JSON.stringify(behaviour.json);
    } else if (typeof behaviour.text === 'string') {
      text = behaviour.text;
    } else if (callOptions.schema) {
      const seed = hash(prompt);
      text = JSON.stringify(synthesize(callOptions.schema, seed, {
        candidateTitle: firstCandidateTitle(prompt),
      }), null, 0);
    } else {
      text = `${pick(HEADLINES, hash(prompt))}\n\n${pick(SENTENCES, hash(prompt))}`;
    }

    return {
      text,
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens(text),
      estimated: true,
    };
  }

  const run = (prompt, callOptions) => {
    calls.push({ prompt, options: callOptions });
    return runWithRetries({
      call: () => callOnce(prompt, callOptions),
      prompt,
      provider: 'mock',
      model,
      retries: callOptions.retries ?? retries,
      usage,
      backoffMs: 0,
      sleep: callOptions.sleep ?? (() => Promise.resolve()),
    });
  };

  return {
    name: 'mock',
    model,
    isConfigured: true,
    usage,

    /** Everything the mock was asked to do, for assertions. */
    calls,
    reset() {
      cursor = 0;
      calls.length = 0;
    },

    async generateText(prompt, callOptions = {}) {
      const result = await run(prompt, callOptions);
      return {
        text: result.text,
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          estimated: true,
        },
      };
    },

    async generateJSON(prompt, callOptions = {}) {
      const result = await run(prompt, callOptions);
      // Parsed and validated exactly like the real provider: a mock that
      // accepts output Gemini's path would reject is worse than no mock.
      const data = parseJsonWithSchema(result.text, callOptions.schema, {
        stripUnknown: callOptions.stripUnknown ?? true,
      });
      return {
        data,
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          estimated: true,
        },
      };
    },
  };
}

export { synthesize as synthesizeFromSchema, LlmError };
