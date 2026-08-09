import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isEnabled,
  addEpisode,
  searchMemory,
  buildEpisodeContent,
  BREETH_ERROR,
  EPISODE,
} from '../../src/services/breeth/index.js';
import { clearActivity, recentActivity } from '../../src/utils/logger.js';

/**
 * Phase 12.5 — the Breeth client in isolation.
 *
 * Every test injects `fetchImpl`, so the real Breeth API is never contacted by
 * the suite. What is under test is the safety contract: the service resolves for
 * every failure mode rather than throwing, it makes no request at all when
 * disabled or unkeyed, and neither its return values nor its log lines can carry
 * a credential.
 */

/** Enabled config with an obviously-synthetic key. Never a real credential. */
const KEY = 'ck_live_FAKE_KEY_NOT_A_SECRET';
const enabled = (fetchImpl, extra = {}) => ({
  enabled: true, apiKey: KEY, baseUrl: 'https://api.example.test',
  groupId: 'test-group', timeoutMs: 500, fetchImpl, ...extra,
});

/** A fetch double recording every call, answering with a canned response. */
function fakeFetch({ status = 200, body = { ok: true, episode_name: 'ep_1' }, json } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: json ?? (async () => body),
    };
  };
  impl.calls = calls;
  return impl;
}

/** A fetch that never settles until aborted, to exercise the timeout path. */
const hangingFetch = () => async (_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => {
    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  });
});

// --- Test 1: disabled means no network request at all -------------------------

test('disabled: no request is made and the failure is reported, not thrown', async () => {
  const fetchImpl = fakeFetch();

  const write = await addEpisode(
    { event: EPISODE.PUBLISHED, topic: 'A topic', persona: 'Sentinel' },
    { enabled: false, apiKey: KEY, fetchImpl }
  );
  const read = await searchMemory('A topic', { enabled: false, apiKey: KEY, fetchImpl });

  assert.equal(fetchImpl.calls.length, 0, 'a disabled Breeth must not touch the network');
  assert.deepEqual(
    { ok: write.ok, available: write.available, errorCode: write.errorCode },
    { ok: false, available: false, errorCode: BREETH_ERROR.DISABLED }
  );
  assert.equal(read.errorCode, BREETH_ERROR.DISABLED);
  assert.deepEqual(read.facts, [], 'a disabled read yields an empty list, never undefined');
  assert.equal(isEnabled({ enabled: false, apiKey: KEY, fetchImpl }), false);
});

// --- Test 2: a missing API key is "unavailable", never an exception -----------

test('missing API key: reported unavailable with no request attempted', async () => {
  const fetchImpl = fakeFetch();

  const write = await addEpisode(
    { event: EPISODE.PUBLISHED, topic: 'A topic' },
    { enabled: true, apiKey: '', fetchImpl }
  );

  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(write.ok, false);
  assert.equal(write.available, false);
  assert.equal(write.errorCode, BREETH_ERROR.NOT_CONFIGURED);
  assert.equal(isEnabled({ enabled: true, apiKey: '   ', fetchImpl }), false, 'whitespace is not a key');
});

// --- Test 3: a successful episode, against the verified API contract ----------

test('successful episode: posts to /v1/episodes with a bearer token and the documented fields', async () => {
  const fetchImpl = fakeFetch({
    body: { ok: true, episode_name: 'ep_abc', extracted: { entities: ['a', 'b'], edges: ['e'] } },
  });

  const result = await addEpisode({
    event: EPISODE.PUBLISHED,
    agentId: 'agt_1',
    persona: 'Sentinel',
    topic: 'Prompt injection bypasses a guardrail',
    reason: 'Novel and well sourced.',
    confidence: 0.91,
  }, enabled(fetchImpl));

  assert.equal(result.ok, true);
  assert.equal(result.available, true);
  assert.equal(result.episodeName, 'ep_abc');

  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.example.test/v1/episodes');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, `Bearer ${KEY}`);

  // Exactly the documented request fields, and nothing extra.
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ['content', 'extract_intent', 'group_id', 'source_description']);
  assert.equal(body.group_id, 'test-group');
  assert.ok(body.content.includes('Prompt injection bypasses a guardrail'));
  assert.ok(body.content.includes('Sentinel'));
  assert.ok(body.content.includes('0.91'), 'confidence is carried as strategic detail');
  assert.equal(body.extract_intent, false, 'the metered flag stays off unless opted into');
  assert.ok(body.source_description.length <= 120, "Breeth's documented cap");
});

test('search returns the edge facts and asks for the documented fields only', async () => {
  const fetchImpl = fakeFetch({
    body: {
      edges: [
        { fact: 'The agent published about prompt injection.', name: 'published' },
        { fact: 'The agent deferred a duplicate topic.' },
        { fact: '   ' },
      ],
    },
  });

  const result = await searchMemory('prompt injection', { ...enabled(fetchImpl), limit: 5 });

  assert.equal(result.ok, true);
  assert.equal(result.count, 2, 'blank facts are dropped');
  assert.equal(result.facts[0], 'The agent published about prompt injection.');

  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.example.test/v1/search');
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ['group_id', 'limit', 'query']);
  assert.equal(body.limit, 5);
});

// --- Test 4: a timeout resolves as a timeout ---------------------------------

test('timeout: the request is abandoned and reported, never thrown', async () => {
  const result = await addEpisode(
    { event: EPISODE.PUBLISHED, topic: 'A topic' },
    enabled(hangingFetch(), { timeoutMs: 250 })
  );

  assert.equal(result.ok, false);
  assert.equal(result.available, false);
  assert.equal(result.errorCode, BREETH_ERROR.TIMEOUT);
});

// --- Test 5: a 500 and the rest of the documented error envelope -------------

test('a 500 is reported as rejected with the error slug only, not provider prose', async () => {
  const fetchImpl = fakeFetch({
    status: 500,
    body: { error: 'internal_error', message: 'Something broke at api.thebreeth.com request 12345' },
  });

  const result = await addEpisode({ event: EPISODE.PUBLISHED, topic: 'A topic' }, enabled(fetchImpl));

  assert.equal(result.ok, false);
  assert.equal(result.available, false);
  assert.equal(result.errorCode, BREETH_ERROR.REJECTED);
  assert.equal(result.status, 500);
  assert.equal(result.reason, 'internal_error');
  assert.ok(!JSON.stringify(result).includes('Something broke'), 'provider prose is not propagated');
});

test('quota, auth, and scope failures all resolve to the same safe shape', async () => {
  for (const [status, slug] of [[401, 'unauthenticated'], [403, 'missing_scope'], [429, 'quota_exceeded']]) {
    const result = await addEpisode(
      { event: EPISODE.PUBLISHED, topic: 'A topic' },
      enabled(fakeFetch({ status, body: { error: slug } }))
    );
    assert.equal(result.ok, false, `${status} must not throw`);
    assert.equal(result.errorCode, BREETH_ERROR.REJECTED);
    assert.equal(result.reason, slug);
  }
});

test('a network error and malformed JSON both resolve safely', async () => {
  const exploding = async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); };
  const network = await addEpisode({ event: EPISODE.PUBLISHED, topic: 'T' }, enabled(exploding));
  assert.equal(network.errorCode, BREETH_ERROR.UNAVAILABLE);

  const badJson = fakeFetch({ json: async () => { throw new Error('not json'); } });
  const malformed = await addEpisode({ event: EPISODE.PUBLISHED, topic: 'T' }, enabled(badJson));
  assert.equal(malformed.errorCode, BREETH_ERROR.BAD_RESPONSE);

  // A 200 whose `edges` is the wrong type must not throw either.
  const wrongShape = fakeFetch({ body: { edges: 'not-an-array' } });
  const search = await searchMemory('q', enabled(wrongShape));
  assert.equal(search.ok, true);
  assert.deepEqual(search.facts, []);
});

test('an empty topic is rejected locally without a request', async () => {
  const fetchImpl = fakeFetch();
  const result = await addEpisode({ event: EPISODE.PUBLISHED, topic: '   ' }, enabled(fetchImpl));

  assert.equal(result.errorCode, BREETH_ERROR.INVALID_INPUT);
  assert.equal(fetchImpl.calls.length, 0, 'no point spending a request on an empty episode');
});

// --- Test 6: secret safety -----------------------------------------------------

test('secrets never reach the episode payload, the result, or the activity log', async () => {
  clearActivity();
  // Synthetic credentials, deliberately fake, fed in as if a caller leaked them.
  const FAKE_URI = 'mongodb+srv://admin:FAKE_PLACEHOLDER_NOT_A_SECRET@cluster0.example.net/db';
  const FAKE_BEARER = 'Bearer ck_live_FAKE_LEAKED_TOKEN_VALUE_1234567890';

  const fetchImpl = fakeFetch({ status: 500, body: { error: 'internal_error' } });
  const result = await addEpisode({
    event: EPISODE.PUBLISHED,
    agentId: 'agt_secret',
    topic: `Outage while connecting to ${FAKE_URI}`,
    reason: `Upstream rejected ${FAKE_BEARER} and api_key=FAKE_INLINE_KEY_VALUE`,
  }, enabled(fetchImpl));

  // The payload that would have gone to Breeth carries no credential.
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.ok(!sent.content.includes('FAKE_PLACEHOLDER_NOT_A_SECRET'), 'no password in the episode');
  assert.ok(!sent.content.includes('mongodb+srv://'), 'no connection string in the episode');
  assert.ok(!sent.content.includes('FAKE_LEAKED_TOKEN_VALUE'), 'no bearer token in the episode');
  assert.ok(!sent.content.includes('FAKE_INLINE_KEY_VALUE'), 'no inline api key in the episode');

  // Neither does the returned value.
  assert.ok(!JSON.stringify(result).includes('FAKE_PLACEHOLDER_NOT_A_SECRET'));

  // Nor the activity buffer, which the dashboard reads. The Breeth API key is
  // the most important thing here: it must never be logged in any form.
  const logged = JSON.stringify(recentActivity({ limit: 50 }));
  assert.ok(!logged.includes(KEY), 'the Breeth API key must never be logged');
  assert.ok(!logged.includes('Bearer '), 'no authorization header in the log');
  assert.ok(!logged.includes('FAKE_PLACEHOLDER_NOT_A_SECRET'), 'no MongoDB password in the log');
  assert.ok(!logged.includes('mongodb+srv://'), 'no connection string in the log');
  clearActivity();
});

test('the outgoing key lives only in the header, never in the body or the URL', async () => {
  const fetchImpl = fakeFetch();
  await addEpisode({ event: EPISODE.PUBLISHED, topic: 'A topic' }, enabled(fetchImpl));

  const { url, init } = fetchImpl.calls[0];
  assert.ok(!url.includes(KEY), 'the key is not a query parameter');
  assert.ok(!init.body.includes(KEY), 'the key is not in the payload');
  assert.equal(init.headers.authorization, `Bearer ${KEY}`);
});

// --- Episode content shaping ---------------------------------------------------

test('episode content is a concise sentence per event type, length-capped', async () => {
  const published = buildEpisodeContent({ event: EPISODE.PUBLISHED, persona: 'Sentinel', topic: 'Topic A' });
  assert.match(published, /^Sentinel published a post about "Topic A"\./);

  const skipped = buildEpisodeContent({ event: EPISODE.REPETITION_SKIP, persona: 'Sentinel', topic: 'Topic A' });
  assert.match(skipped, /repeats a topic already covered/);

  const deferred = buildEpisodeContent({ event: EPISODE.DEFERRED, persona: 'Sentinel', topic: 'Topic A' });
  assert.match(deferred, /decided not to publish/);

  // A pathological topic cannot bloat an episode.
  const huge = buildEpisodeContent({
    event: EPISODE.PUBLISHED, persona: 'Sentinel', topic: 'x'.repeat(5_000), reason: 'y'.repeat(5_000),
  });
  assert.ok(huge.length <= 1_000, `content length ${huge.length} must be capped`);
});
