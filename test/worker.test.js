import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { DailyEditor, nextStart, selectPosts, validateSummary, renderPost, MINUTE, DAY, INTERVAL } from '../src/worker.js';
import { chooseMix, parseLabels } from '../src/audience.js';
import { EDITORIAL_VERSION, selectComments, validateDiscussion, GAMING_CORRECTION, MORNING_POST_ID } from '../src/discussion.js';

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
const base = () => ({ editorialVersion: EDITORIAL_VERSION, enabled: true, items: [], seen: [], batches: [], errors: [], lastAttempt: 0, nextCollection: Date.now() + DAY, nextStart: Date.now() + DAY });
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
    h.obj.discover = async () => { feedCalls++; return { candidates:[{...post('unique'),category:'human',appeal:4,trend_score:1}],hotCount:1,risingCount:1,screenedCount:1 }; };
    await h.obj.tick(); await h.obj.tick();
    assert.equal(feedCalls, 1); assert.equal(h.state().batches.length, 1); assert.equal(h.state().items.length, 1);
    assert.equal(h.state().nextCollection, s.nextStart + DAY - 30 * MINUTE);
  } finally { globalThis.fetch = oldFetch; }
});

function audiencePool(g = 20, t = 10) {
  return Array.from({length:g+t},(_,i)=>({...post('mix'+i),author:{name:'author'+i},category:i<g ? ['human','rights','fun','business','finance'][i%5] : 'technical', appeal:4, trend_score:1/(i+1)}));
}
test('audience mix has at least 11 general posts and no more than 4 technical per 15',()=>{
  const result=chooseMix(audiencePool()); assert.equal(result.length,15);
  assert.equal(result.filter(x=>x.category==='technical').length,4);
  for(let i=1;i<=result.length;i++) assert.ok(result.slice(0,i).filter(x=>x.category==='technical').length/i<=.3);
});
test('technical shortage is filled with general stories; general shortage never breaks the cap',()=>{
  assert.equal(chooseMix(audiencePool(20,0)).length,15);
  const short=chooseMix(audiencePool(5,20));
  assert.equal(short.length,7); assert.ok(short.filter(x=>x.category==='technical').length/short.length<=.3);
  assert.equal(chooseMix(audiencePool(0,30)).length,0);
});
test('rebuild includes existing technical delivery in the daily cap',()=>{
  const fixed=[{...post('sent'),category:'technical'}];
  const result=chooseMix(audiencePool(),15,fixed);
  assert.equal(result.length,14); assert.equal(result.filter(x=>x.category==='technical').length,3);
});
test('classification rejects invented indices, missing labels, duplicates and low-interest or skipped posts',()=>{
  const result=parseLabels(JSON.stringify({items:[{i:0,category:'human',appeal:4},{i:0,category:'rights',appeal:5},{i:500,category:'human',appeal:4},{i:1,category:'skip',appeal:5},{i:2,category:'fun',appeal:2}]}),[post('a'),post('b'),post('c')]);
  assert.deepEqual(result.map(x=>x.id),['a']);
});
test('technical publication is held when failed general stories would violate the actual delivery mix',async()=>{
  const s=base(); s.items=[{...item('tech'),category:'technical',batch:123}];
  const h=harness(s); await h.obj.tick(); assert.equal(h.state().items[0].status,'skipped_quota');
});
test('recuration preserves sent message and rebuilds only future slots, including its technical budget',async()=>{
  const s=base(),start=Date.now()-10*MINUTE;
  s.rebuildRequested=start; s.batches=[{start,count:15}];
  s.items=[{...item('sent',start),rank:1,batch:start,status:'sent',messageId:77},{...item('old',start+INTERVAL),rank:2,batch:start}];
  s.seen=[{id:'sent',at:Date.now()},{id:'old',at:Date.now()}];
  const h=harness(s); h.obj.discover=async()=>({candidates:audiencePool(),screenedCount:30});
  await h.obj.rebuild(s,Date.now());
  const saved=h.state(); assert.equal(saved.items.length,15); assert.equal(saved.items[0].messageId,77);
  assert.ok(!saved.items.some(i=>i.id==='old')); assert.equal(saved.batches[0].technicalCount,4);
  assert.equal(saved.batches[0].generalCount,11); assert.equal(saved.items[1].dueAt,start+INTERVAL);
  assert.ok(!saved.rebuildRequested);
});

test('public requests cannot read queue or trigger actions', async () => {
  assert.equal((await worker.fetch(new Request('https://example/admin/status'), { ADMIN_TOKEN: 'secret' })).status, 401);
  assert.equal((await worker.fetch(new Request('https://example/health'), {})).status, 200);
  assert.equal((await worker.fetch(new Request('https://example/admin/start', { headers: { Authorization: 'Bearer secret' } }), { ADMIN_TOKEN: 'secret' })).status, 405);
});

test('reply selection keeps parent attribution and author replies while limiting repetitive commenters',()=>{
  const source=[{id:'root',author:{name:'second'},content:'A real experience',upvotes:2,replies:[
    ...Array.from({length:10},(_,i)=>({id:'spam'+i,author:{name:'repeater'},content:'Repeated question '+i,replies:[]})),
    {id:'reply',author:{name:'writer'},content:'A substantive answer',replies:[{id:'followup',author:{name:'second'},content:'Follow-up',replies:[]}]},
  ]}];
  const result=selectComments(source,'writer');
  assert.equal(result[1].id,'reply'); assert.equal(result[2].id,'followup');
  assert.equal(result[2].parent_author,'writer'); assert.ok(result.filter(x=>x.author==='repeater').length<=3);
});
test('discussion attribution cannot be invented or overridden by the model',()=>{
  const source=[{id:'real',author:'real-author',parent_id:'parent',parent_author:'other',text:'source'}];
  const summary='می‌گه گاهی انسانش فقط می‌خواد از تماشای فیلم لذت ببره و نیازی به ساختن چیز تازه‌ای نیست.';
  const result=validateDiscussion([{id:'real',author:'imposter',summary}],source);
  assert.equal(result[0].author,'real-author'); assert.equal(result[0].parent_author,'other');
  assert.throws(()=>validateDiscussion([{id:'invented',summary}],source));
  assert.throws(()=>validateDiscussion([{id:'real',summary},{id:'real',summary}],source));
  assert.deepEqual(validateDiscussion([],[]),[]);
});
test('editorial migration rewrites unsent items once and preserves delivered messages',async()=>{
  const s=base(); s.editorialVersion=0; s.items=[{...item('sent'),status:'sent',messageId:5},item('next',Date.now()+INTERVAL)];
  const h=harness(s); let prepared=0;
  h.obj.prepare=async i=>{prepared++;i.editorial=editorial;i.status='queued';i.editorialVersion=EDITORIAL_VERSION;};
  await h.obj.tick();await h.obj.tick();
  assert.equal(prepared,1); assert.equal(h.state().items[0].messageId,5); assert.equal(h.state().items[0].status,'sent');
});
test('reviewed gaming correction and its discussion fit a single Telegram post',()=>{
  const i=item('gaming'); i.editorial={...validateSummary(GAMING_CORRECTION),discussion:validateDiscussion(GAMING_CORRECTION.discussion,GAMING_CORRECTION.discussion.map((x,n)=>({id:x.id,author:n===1?'triii':'manty',parent_author:n>0?'triii':null})))};
  assert.ok(renderPost(i).length<4000); assert.match(renderPost(i),/انسانش/); assert.match(renderPost(i),/زیر پست/);
});

test('main model never receives replies, and a reply retry reuses the cached main narrative',async()=>{
  const oldFetch=globalThis.fetch, s=base(), h=harness(s);
  const comment={id:'comment',author:{name:'reply-author'},content:'REPLY_ONLY_SENTINEL',replies:[]};
  globalThis.fetch=async url=>Response.json(String(url).includes('/comments?') ? {comments:[comment]} : {post:post('isolated',{content:'MAIN_ONLY_SENTINEL'})});
  let mainCalls=0,replyCalls=0;
  h.obj.env.AI={run:async(_model,input)=>{
    const data=JSON.parse(input.messages[1].content);
    if ('source_text' in data) {
      mainCalls++;
      assert.equal(data.source_text,'MAIN_ONLY_SENTINEL');
      assert.equal(data.comments,undefined);
      assert.ok(!input.messages.some(m=>m.content.includes('REPLY_ONLY_SENTINEL')));
      return {response:JSON.stringify(editorial)};
    }
    replyCalls++;
    assert.equal(data.comments[0].text,'REPLY_ONLY_SENTINEL');
    if (replyCalls===1) throw new Error('Temporary reply failure');
    return {response:JSON.stringify({discussion:[{id:'comment',summary:'می‌گه انسانش ترجیح می‌ده خودش تصمیم بگیره و ربات فقط وقتی ازش کمک می‌خوان وارد ماجرا بشه.'}]})};
  }};
  const i=item('isolated');
  try {
    await assert.rejects(h.obj.prepare(i),/Temporary reply failure/);
    await h.obj.prepare(i);
    assert.equal(mainCalls,1);assert.equal(replyCalls,2);
    assert.equal(i.editorial.summary,editorial.summary);
    assert.equal(i.editorial.discussion[0].author,'reply-author');
    const text=renderPost(i);
    assert.ok(text.indexOf(editorial.summary)<text.indexOf('زیر پست چه خبر بود؟'));
    assert.ok(text.indexOf(i.editorial.discussion[0].summary)>text.indexOf('زیر پست چه خبر بود؟'));
  } finally {globalThis.fetch=oldFetch;}
});

test('mixed example correction edits its stored message once and preserves the reply section',async()=>{
  const oldFetch=globalThis.fetch,s=base(),reply={id:'existing',author:'other',summary:'می‌گه پیام خودکار ممکنه حال واقعی انسانش در آن لحظه را منعکس نکنه و بهتره همراهش اطلاعاتی داشته باشه.'};
  s.items=[{...item(MORNING_POST_ID),status:'sent',messageId:45,editorial:{...editorial,discussion:[reply]}}];
  const h=harness(s);let edits=0;
  h.obj.mainNarrative=async()=>editorial;
  globalThis.fetch=async(url,options)=>{
    if (!String(url).includes('editMessageText')) return Response.json({post:post(MORNING_POST_ID)});
    edits++;
    const body=JSON.parse(options.body);
    assert.equal(body.message_id,45);assert.ok(body.text.includes(reply.summary));
    return Response.json({ok:true});
  };
  try {
    await h.obj.correctMixedExample(s);await h.obj.correctMixedExample(s);
    assert.equal(edits,1);assert.equal(s.items[0].messageId,45);
    assert.deepEqual(s.items[0].editorial.discussion,[reply]);assert.ok(s.morningCorrection.done);
  } finally {globalThis.fetch=oldFetch;}
});

test('a post without comments uses only its independently generated main narrative',async()=>{
  const oldFetch=globalThis.fetch,h=harness(base());let calls=0;
  globalThis.fetch=async url=>Response.json(String(url).includes('/comments?') ? {comments:[]} : {post:post('no-replies')});
  h.obj.env.AI={run:async(_model,input)=>{
    calls++;const payload=JSON.parse(input.messages[1].content);
    assert.equal(payload.source_text,'source');assert.equal(payload.comments,undefined);
    return {response:JSON.stringify({...editorial,discussion:[{id:'invented'}]})};
  }};
  try {
    const i=item('no-replies');await h.obj.prepare(i);
    assert.equal(calls,1);assert.deepEqual(i.editorial,{...editorial,discussion:[]});
    assert.equal(i.status,'queued');assert.ok(!renderPost(i).includes('زیر پست چه خبر بود؟'));
  } finally {globalThis.fetch=oldFetch;}
});

test('missing reply output is retried without silently discarding existing source comments',async()=>{
  const oldFetch=globalThis.fetch,h=harness(base());let mainCalls=0;
  globalThis.fetch=async url=>Response.json(String(url).includes('/comments?') ? {comments:[{id:'real',author:{name:'other'},content:'A substantive reply',replies:[]}]} : {post:post('malformed-replies')});
  h.obj.env.AI={run:async(_model,input)=>{
    const payload=JSON.parse(input.messages[1].content);
    if ('source_text' in payload) {mainCalls++;return {response:JSON.stringify(editorial)};}
    return {response:'{"summary":"invalid reply output"}'};
  }};
  try {
    const i={...item('malformed-replies'),status:'pending'};delete i.editorial;
    await assert.rejects(h.obj.prepare(i),/Missing discussion output/);
    await assert.rejects(h.obj.prepare(i),/Missing discussion output/);
    assert.equal(mainCalls,1);assert.equal(i.status,'pending');assert.equal(i.editorial,undefined);
  } finally {globalThis.fetch=oldFetch;}
});

test('editorial upgrade retries future failed drafts while preserving delivered and ambiguous messages',async()=>{
  const s=base();s.editorialVersion=EDITORIAL_VERSION-1;
  s.items=['failed','queued','pending','sent','unknown'].map((status,n)=>({...item('upgrade'+n,Date.now()+INTERVAL),status,attempts:4,nextRetry:Date.now()+DAY,messageId:status==='sent'?71:undefined}));
  const h=harness(s);let prepared=0;
  h.obj.prepare=async i=>{prepared++;i.editorial=editorial;i.status='queued';};
  await h.obj.tick();
  const saved=h.state();assert.equal(prepared,1);
  assert.equal(saved.items[0].status,'queued');assert.equal(saved.items[0].attempts,0);
  assert.equal(saved.items[1].status,'pending');assert.equal(saved.items[2].status,'pending');
  assert.equal(saved.items[3].status,'sent');assert.equal(saved.items[3].messageId,71);
  assert.equal(saved.items[4].status,'unknown');
});
