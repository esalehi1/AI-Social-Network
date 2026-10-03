import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { DailyEditor, nextStart, selectPosts, validateSummary, renderPost, MINUTE, DAY, INTERVAL } from '../src/worker.js';

const now = Date.parse('2026-10-03T00:00:00Z');
const post = (id, extra = {}) => ({ id, title: 'A distinct post ' + id, content: 'source', created_at: new Date(now - MINUTE).toISOString(), upvotes: 100, comment_count: 50, author: { name: 'agent' }, ...extra });
const editorial = { title: 'چرا خلاصه‌سازی می‌تواند خطا را پنهان کند؟', summary: 'نویسنده در این مطلب توضیح می‌دهد که خلاصه‌سازی پیاپی ممکن است یک خطای کوچک را به اطلاعات پذیرفته‌شده تبدیل کند. وقتی عامل‌های بعدی تنها خلاصهٔ مرحلهٔ قبل را می‌بینند، امکان مراجعه به دادهٔ اصلی را از دست می‌دهند. پیشنهاد مطرح‌شده در نوشته، نگه‌داشتن ارجاع به منبع و بررسی دادهٔ اصلی پیش از تصمیم‌گیری است.' };
function harness(state) {
  const values = new Map([['state', structuredClone(state)]]); let alarm;
  const storage = {
    async get(key) { return Array.isArray(key) ? new Map(key.filter(k => values.has(k)).map(k => [k, structuredClone(values.get(k))])) : structuredClone(values.get(key)); },
    async put(key, value) { for (const [k,v] of typeof key === 'string' ? [[key,value]] : Object.entries(key)) values.set(k,structuredClone(v)); },
    async delete(keys) { for (const k of keys) values.delete(k); },
    async transaction(fn) { return fn(storage); },
    async setAlarm(t) { alarm = t; }, async deleteAlarm() { alarm = null; }
  };
  const obj = new DailyEditor({ storage }, { TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_CHAT_ID: '-100test', DAILY_START: '04:00' });
  return { obj, state: () => { const s = structuredClone(values.get('state')); if (s.itemIds) s.items = s.itemIds.map(id => structuredClone(values.get('item:'+id))); return s; }, alarm: () => alarm };
}
const base = () => ({ enabled: true, items: [], seen: [], batches: [], errors: [], lastAttempt: 0, nextCollection: Date.now() + DAY, nextStart: Date.now() + DAY });
const item = (id, dueAt = Date.now() - MINUTE) => ({ id, post: post(id), editorial, status: 'queued', dueAt, collectedAt: now });

test('Tehran cycle crosses UTC midnight correctly and 15 posts have 90-minute gaps', () => {
  const first = nextStart(now, '04:00');
  assert.equal(new Date(first).toISOString(), '2026-10-03T00:30:00.000Z');
  assert.equal(nextStart(first, '04:00'), first + DAY);
  const times = Array.from({ length: 15 }, (_, i) => first + INTERVAL * i);
  assert.equal(first + DAY - times.at(-1), 3 * 60 * MINUTE);
  assert.throws(() => nextStart(now, '25:00'));
});

test('ranking deduplicates feeds, titles, seen stories and removes stale/spam posts', () => {
  const seen = [{ id: 'seen', title: 'alreadycovered' }];
  const hot = [post('first'), post('same', { title: 'A distinct post first' }), post('seen'), post('old', { created_at: new Date(now - 8 * DAY).toISOString() }), post('spam', { is_spam: true }), post('future', { created_at: new Date(now + DAY).toISOString() }), post('second')];
  const result = selectPosts(hot, [post('first'), post('third')], seen, now);
  assert.deepEqual(result.map(x => x.id), ['first', 'second', 'third']);
  assert.equal(selectPosts(Array.from({ length: 100 }, (_, i) => post('id' + i)), [], [], now).length, 15);
});

test('editor rejects non-Persian, injection links, malformed and empty content', () => {
  assert.deepEqual(validateSummary(JSON.stringify(editorial)), editorial);
  assert.throws(() => validateSummary({ title: 'English title', summary: 'English '.repeat(50) }));
  assert.throws(() => validateSummary({ ...editorial, summary: editorial.summary + ' https://evil.test' }));
  assert.throws(() => validateSummary({ ...editorial, title: 'سلام 中文' }));
  assert.throws(() => validateSummary('not json'));
});

test('Telegram HTML escapes external text and isolates Latin author', () => {
  const i = item('abc'); i.post.author.name = '<b>&';
  const output = renderPost(i);
  assert.match(output, /&lt;b&gt;&amp;/);
  assert.match(output, /https:\/\/www.moltbook.com\/post\/abc/);
  assert.ok(output.length < 4096);
});

test('crash recovery never resends a persisted sending intent', async () => {
  const s = base(); s.items = [{ ...item('abc'), status: 'sending' }];
  const h = harness(s);
  await h.obj.tick();
  assert.equal(h.state().items[0].status, 'unknown');
});

test('two concurrent ticks serialize and send exactly once', async () => {
  const oldFetch = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async () => { count++; await new Promise(r => setTimeout(r, 5)); return Response.json({ ok: true, result: { message_id: 123 } }); };
  try {
    const s = base(); s.items = [item('abc')]; const h = harness(s);
    await Promise.all([h.obj.locked(() => h.obj.tick()), h.obj.locked(() => h.obj.tick())]);
    assert.equal(count, 1); assert.equal(h.state().items[0].status, 'sent');
  } finally { globalThis.fetch = oldFetch; }
});

test('ambiguous Telegram timeout is recorded, not retried', async () => {
  const oldFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('timeout'); };
  try {
    const s = base(); s.items = [item('abc')]; const h = harness(s);
    await h.obj.tick(); await h.obj.tick();
    assert.equal(calls, 1); assert.equal(h.state().items[0].status, 'unknown');
  } finally { globalThis.fetch = oldFetch; }
});

test('late items expire and missed schedule never floods the channel', async () => {
  const s = base(); s.lastAttempt = Date.now() - 20 * MINUTE;
  s.items = [item('expired', Date.now() - 2 * INTERVAL), item('current')];
  const h = harness(s); await h.obj.tick();
  assert.equal(h.state().items[0].status, 'expired'); assert.equal(h.state().items[1].status, 'queued');
});

test('AI failures retain pending items with backoff and a persisted error', async () => {
  const s = base(); s.items = [{ ...item('abc', Date.now() + INTERVAL), status: 'pending', nextRetry: 0, attempts: 0 }];
  const h = harness(s); h.obj.prepare = async () => { throw new Error('AI unavailable'); };
  await h.obj.tick(); assert.equal(h.state().items[0].attempts, 1); assert.equal(h.state().items[0].status, 'pending');
  assert.ok(h.state().items[0].nextRetry > Date.now()); assert.equal(h.state().errors[0].scope, 'editorial');
});

test('daily collection is persisted and not repeated on subsequent ticks', async () => {
  const oldFetch = globalThis.fetch; let feedCalls = 0;
  globalThis.fetch = async () => { feedCalls++; return Response.json({ success: true, posts: [post('unique', { created_at: new Date(Date.now() - MINUTE).toISOString() })] }); };
  try {
    const s = base(); s.nextCollection = 0; s.nextStart = Date.now() + INTERVAL;
    const h = harness(s); h.obj.prepare = async i => { i.editorial = editorial; i.status = 'queued'; };
    await h.obj.tick(); await h.obj.tick();
    assert.equal(feedCalls, 2); assert.equal(h.state().batches.length, 1); assert.equal(h.state().items.length, 1);
    assert.equal(h.state().nextCollection, s.nextStart + DAY - 30 * MINUTE);
  } finally { globalThis.fetch = oldFetch; }
});

test('public requests cannot read queue or trigger actions', async () => {
  assert.equal((await worker.fetch(new Request('https://example/admin/status'), { ADMIN_TOKEN: 'secret' })).status, 401);
  assert.equal((await worker.fetch(new Request('https://example/health'), {})).status, 200);
  assert.equal((await worker.fetch(new Request('https://example/admin/start', { headers: { Authorization: 'Bearer secret' } }), { ADMIN_TOKEN: 'secret' })).status, 405);
});
