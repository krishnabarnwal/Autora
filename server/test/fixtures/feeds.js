/**
 * Feed fixtures and a fake fetch, so the source tests never touch the network.
 *
 * The XML here is deliberately awkward in the ways real feeds are: CDATA,
 * escaped HTML, unescaped ampersands, Atom link variants, missing fields.
 */

/** RSS 2.0, the common case plus several malformed entries. */
export const RSS_SECURITY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example Security News</title>
    <link>https://security.example.com</link>
    <description>Security coverage</description>
    <item>
      <title>Indirect prompt injection lets attackers exfiltrate data from AI agents</title>
      <link>https://security.example.com/posts/indirect-prompt-injection?utm_source=rss&amp;utm_medium=feed</link>
      <description><![CDATA[<p>Researchers showed that a poisoned web page can steer an <b>LLM agent</b> into leaking a user's private data.</p>]]></description>
      <pubDate>Fri, 07 Aug 2026 09:12:00 GMT</pubDate>
      <dc:creator>A. Researcher</dc:creator>
      <category>prompt injection</category>
      <category>agents</category>
    </item>
    <item>
      <title>Critical RCE in a popular inference server hits GPU clusters</title>
      <link>https://security.example.com/posts/inference-server-rce</link>
      <description>A missing authentication check on the model loading endpoint allows remote code execution &amp; container escape.</description>
      <pubDate>Thu, 06 Aug 2026 18:40:00 GMT</pubDate>
    </item>
    <item>
      <title>Sponsored: buy our AI firewall webinar bundle today</title>
      <link>https://security.example.com/promo/webinar</link>
      <description>Register now for a free trial.</description>
      <pubDate>Fri, 07 Aug 2026 06:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Local bakery wins county pastry award for the third year</title>
      <link>https://security.example.com/posts/pastry-award</link>
      <description>No security content whatsoever.</description>
      <pubDate>Fri, 07 Aug 2026 07:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Prompt injection in early chatbots revisited by LLM security researchers</title>
      <link>https://security.example.com/posts/old-analysis</link>
      <description>Archive material about prompt injection and LLM security from long before this cycle.</description>
      <pubDate>Mon, 03 Mar 2025 08:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Entry with no link at all about model security</title>
      <description>Should be dropped: no usable URL.</description>
      <pubDate>Fri, 07 Aug 2026 08:00:00 GMT</pubDate>
    </item>
    <item>
      <link>https://security.example.com/posts/untitled</link>
      <description>Should be dropped: no title.</description>
      <pubDate>Fri, 07 Aug 2026 08:05:00 GMT</pubDate>
    </item>
    <item>
      <title>Short</title>
      <link>https://security.example.com/posts/short</link>
      <pubDate>Fri, 07 Aug 2026 08:10:00 GMT</pubDate>
    </item>
    <item>
      <title>Model weight exfiltration via a malicious pickle file in a shared registry</title>
      <link>javascript:alert('xss')</link>
      <description>Dropped: not an http(s) URL.</description>
      <pubDate>Fri, 07 Aug 2026 08:15:00 GMT</pubDate>
    </item>
    <item>
      <title>Guardrail bypass in a hosted LLM API leaks system prompts</title>
      <link>https://security.example.com/posts/guardrail-bypass</link>
      <description>A crafted request returns the system prompt verbatim.</description>
      <pubDate>banana</pubDate>
    </item>
  </channel>
</rss>`;

/** Atom, with self/alternate links and an entry whose date is only in <updated>. */
export const ATOM_RESEARCH = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Research Feed</title>
  <link rel="self" href="https://research.example.org/atom.xml"/>
  <updated>2026-08-07T10:00:00Z</updated>
  <entry>
    <title>Data poisoning attacks against fine-tuned language models</title>
    <link rel="alternate" href="https://research.example.org/papers/data-poisoning"/>
    <link rel="replies" href="https://research.example.org/papers/data-poisoning/comments"/>
    <summary>We show that poisoning 0.1% of a fine-tuning corpus reliably implants a backdoor in the resulting model.</summary>
    <published>2026-08-07T04:30:00Z</published>
    <author><name>Research Group</name></author>
  </entry>
  <entry>
    <title>Membership inference against production embedding APIs</title>
    <link href="https://research.example.org/papers/membership-inference"/>
    <content type="html">&lt;p&gt;An adversary with query access can determine whether a document was in the index.&lt;/p&gt;</content>
    <updated>2026-08-06T22:00:00Z</updated>
  </entry>
  <entry>
    <title>Agent sandbox escape through tool-calling confusion</title>
    <link href="https://research.example.org/papers/sandbox-escape"/>
    <summary>Tool schemas that overlap let an agent be steered into invoking a privileged tool.</summary>
  </entry>
</feed>`;

/** The same two stories another outlet covered, plus rewording and a repost. */
export const RSS_DUPLICATES = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Second Wire</title>
    <item>
      <title>INDIRECT PROMPT INJECTION lets attackers exfiltrate data from AI agents</title>
      <link>https://security.example.com/posts/indirect-prompt-injection</link>
      <description>Same story, different casing, same canonical URL after tracking params are stripped.</description>
      <pubDate>Fri, 07 Aug 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Attackers exfiltrate data from AI agents using indirect prompt injection</title>
      <link>https://wire.example.net/2026/08/agents-prompt-injection</link>
      <description>Reworded headline for the same story at a different URL, which title normalization must collapse.</description>
      <pubDate>Fri, 07 Aug 2026 11:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Critical remote code execution flaw in popular inference server threatens GPU clusters</title>
      <link>https://wire.example.net/2026/08/inference-server-rce-report</link>
      <description>Near-duplicate wording of the inference server RCE story, caught by keyword similarity rather than exact match.</description>
      <pubDate>Thu, 06 Aug 2026 19:30:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

export const MALFORMED_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Broken</title>
  <item><title>Truncated prompt injection advisory for LLM systems</title>
  <link>https://broken.example.com/a-story</link>
  <description>Feed cut off mid-document, closing tags missing`;

export const NOT_A_FEED = '<!doctype html><html><head><title>Login</title></head><body>Sign in</body></html>';

export const EMPTY_FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Quiet Feed</title><link>https://quiet.example.com</link></channel></rss>`;

export const HN_JSON = JSON.stringify({
  hits: [
    {
      objectID: '44100001',
      title: 'Show HN: a scanner for prompt injection in RAG pipelines',
      url: 'https://tools.example.dev/rag-injection-scanner',
      created_at: '2026-08-07T05:00:00.000Z',
      points: 214,
      _tags: ['story', 'author_someone'],
    },
    {
      objectID: '44100002',
      title: 'Ask HN: how are you securing autonomous coding agents in CI?',
      url: null,
      story_text: 'We run agents with repository write access and want to bound the damage.',
      created_at: '2026-08-06T21:15:00.000Z',
      points: 96,
      _tags: ['story', 'ask_hn'],
    },
    { objectID: '44100003', title: 'too short', url: 'https://x.example', created_at: '2026-08-07T05:30:00.000Z' },
  ],
});

/** Fixed clock: two hours after the newest fixture entry. */
export const NOW = Date.parse('2026-08-07T12:00:00.000Z');

/**
 * Fake fetch driven by a URL -> response map.
 *
 * A handler may be a string body, or `{ body, status, contentType }`, or
 * `{ hang: true }` to simulate a source that never answers (the request then
 * rejects only when the caller's AbortSignal fires), or `{ networkError }`.
 */
export function fakeFetch(routes, { calls = [] } = {}) {
  return function fetchImpl(url, options = {}) {
    calls.push(url);
    const key = Object.keys(routes).find((route) => url.startsWith(route));
    const handler = key ? routes[key] : { status: 404, body: 'not found' };
    const spec = typeof handler === 'string' ? { body: handler } : handler;

    if (spec.hang) {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted due to timeout');
          error.name = 'TimeoutError';
          reject(error);
        });
      });
    }

    if (spec.networkError) {
      const error = new Error(spec.networkError);
      error.code = 'ENOTFOUND';
      return Promise.reject(error);
    }

    const status = spec.status ?? 200;
    const body = spec.body ?? '';
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      url,
      body: null, // forces fetchText down the response.text() path
      headers: new Map([['content-type', spec.contentType || 'application/xml']]),
      text: async () => body,
    });
  };
}
