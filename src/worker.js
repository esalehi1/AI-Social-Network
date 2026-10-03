import { CATEGORIES, TOPIC_COMMUNITIES, CLASSIFIER_PROMPT, modelText, parseLabels, chooseMix } from './audience.js';
import { EDITORIAL_VERSION, NARRATOR_PROMPT, DISCUSSION_PROMPT, selectComments, validateDiscussion, GAMING_POST_ID, GAMING_CORRECTION, MORNING_POST_ID } from './discussion.js';
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const INTERVAL = 90 * MINUTE;
const TEHRAN = 210 * MINUTE;
const SOURCE = 'https://www.moltbook.com/api/v1';
const DAILY_COUNT = 15;
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

export function recoverReadySlot(state, now) {
  if (now - state.lastAttempt < INTERVAL) return null;
  const current = state.items.find(i => i.dueAt <= now && now < i.dueAt + INTERVAL && ['pending','failed','queued'].includes(i.status));
  if (!current) return null;
  const delivered = state.items.filter(i => i.batch === current.batch && ['sent','sending','unknown'].includes(i.status));
  const technical = delivered.filter(i => !i.category || i.category === 'technical').length;
  const allowed = i => i.category && i.category !== 'technical' || (technical + 1) / (delivered.length + 1) <= .3;
  if (current.status === 'queued' && current.editorial && allowed(current)) return null;
  const ready = state.items.filter(i => i.batch === current.batch && i.dueAt > now && i.status === 'queued' && i.editorial && allowed(i))
    .sort((a,b) => a.dueAt - b.dueAt)[0];
  if (!ready) return null;
  const from = ready.dueAt, to = current.dueAt;
  for (const i of [ready,current]) { i.originalDueAt ??= i.dueAt; i.rescheduledAt = now; }
  [ready.dueAt,current.dueAt] = [current.dueAt,ready.dueAt];
  [ready.rank,current.rank] = [current.rank,ready.rank];
  state.items.sort((a,b) => a.dueAt - b.dueAt);
  return {id:ready.id,displaced:current.id,from,to};
}

export function nextStart(now, clock = '04:00') {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) throw new Error('Invalid DAILY_START');
  const [hour, minute] = clock.split(':').map(Number);
  let start = Math.floor((now + TEHRAN) / DAY) * DAY - TEHRAN + (hour * 60 + minute) * MINUTE;
  if (start <= now) start += DAY;
  return start;
}

export function selectPosts(hot, rising, seen, now, count = DAILY_COUNT) {
  const ids = new Set(seen.map(x => x.id));
  const titles = new Set(seen.map(x => x.title));
  const normalized = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const candidates = new Map();
  for (const [feed, posts] of [['hot', hot], ['rising', rising]]) {
    posts.forEach((p, rank) => {
      const time = Date.parse(p.created_at);
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(p.id) || !p.title || !Number.isFinite(time)) return;
      if (p.is_deleted || p.is_spam || p.is_pinned || ids.has(p.id) || titles.has(normalized(p.title))) return;
      if (now - time > 7 * DAY || time > now + 5 * MINUTE) return;
      const previous = candidates.get(p.id);
      // Reciprocal rank fusion: official hot ranking dominates; rising adds emerging stories.
      const rankScore = (feed === 'hot' ? 2 : 1) / (20 + rank);
      candidates.set(p.id, { ...p, trend_score: (previous?.trend_score || 0) + rankScore, title_key: normalized(p.title) });
    });
  }
  const output = [];
  for (const p of [...candidates.values()].sort((a, b) => b.trend_score - a.trend_score)) {
    if (titles.has(p.title_key)) continue;
    output.push(p); titles.add(p.title_key);
    if (output.length === count) break;
  }
  return output;
}

export function validateSummary(raw) {
  let value = typeof raw === 'string' ? raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : raw;
  if (typeof value === 'string') {
    value = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    value = JSON.parse(value);
  }
  if (!value || typeof value.title !== 'string' || typeof value.summary !== 'string') throw new Error('Invalid editorial JSON');
  const clean = s => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  const title = clean(value.title), summary = clean(value.summary);
  if (title.length < 8 || title.length > 160 || summary.length < 180 || summary.length > 1800) throw new Error('Editorial length out of bounds');
  for (const text of [title, summary]) {
    const letters = text.match(/\p{L}/gu) || [];
    const persian = text.match(/[\u0600-\u06ff]/g) || [];
    if (persian.length / Math.max(1, letters.length) < .65 || /[\u3400-\u9fff]/u.test(text)) throw new Error('Editorial language must be Persian');
  }
  if (/https?:\/\/|t\.me\/|@[a-zA-Z0-9_]{4,}/i.test(title + summary)) throw new Error('Unapproved link in generated text');
  return { title, summary };
}

export function escapeHTML(s) { return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function persianNumber(n) { return new Intl.NumberFormat('fa-IR').format(n); }
function rtl(s) { return '\u200f' + s.replace(/[A-Za-z][A-Za-z0-9_.+/#-]*(?: [A-Za-z0-9_.+/#-]+)*/g, '\u2066$&\u2069'); }
export function renderPost(item) {
  const p = item.post, e = item.editorial;
  const date = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', month: 'long', day: 'numeric' }).format(new Date(item.collectedAt));
  return `🦞 <b>${escapeHTML(rtl(e.title))}</b>\n\n${escapeHTML(rtl(e.summary))}\n\n` +
    (e.discussion?.length ? `💬 <b>زیر پست چه خبر بود؟</b>\n\n${e.discussion.map(reply => `🤖 <code>${escapeHTML(reply.author)}</code>${reply.parent_author ? `، در پاسخ به <code>${escapeHTML(reply.parent_author)}</code>` : ''}:\n${escapeHTML(rtl(reply.summary))}`).join('\n\n')}\n\n` : '') +
    `📌 روایت و خلاصهٔ گفت‌وگوی ربات‌ها در مولت‌بوک\n` +
    `👍 ${persianNumber(Math.max(0, Number(p.upvotes) || 0))} رأی مثبت | 💬 ${persianNumber(Math.max(0, Number(p.comment_count) || 0))} نظر\n` +
    `📅 آمار هنگام بررسی: ${date}\n` +
    `✍️ <code>${escapeHTML(String(p.author?.name || 'unknown').slice(0,100))}</code>\n` +
    `🔗 <a href="https://www.moltbook.com/post/${p.id}">خواندن مطلب اصلی</a>\n\n@aisocialnetwork`;
}

async function sourceJSON(path) {
  const response = await fetch(SOURCE + path, { headers: { Accept: 'application/json', 'User-Agent': 'AI-Social-Network/1.0' }, signal: AbortSignal.timeout(25_000), redirect: 'manual' });
  if (!response.ok) throw new Error(`Moltbook HTTP ${response.status}`);
  const data = await response.json();
  if (data.success === false) throw new Error('Moltbook rejected request');
  return data;
}



export class DailyEditor {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.serial = Promise.resolve(); }
  locked(fn) {
    const task = this.serial.then(fn, fn);
    this.serial = task.catch(() => {});
    return task;
  }
  async load() {
    const state = await this.ctx.storage.get('state');
    if (!state) return { version: 2, enabled: false, items: [], seen: [], batches: [], lastAttempt: 0, nextStart: null, nextCollection: null, errors: [] };
    if (state.itemIds) {
      const rows = state.itemIds.length ? await this.ctx.storage.get(state.itemIds.map(id => 'item:' + id)) : new Map();
      state.items = state.itemIds.map(id => rows.get('item:' + id)).filter(Boolean);
    }
    return state;
  }
  async save(state) {
    // Each item has its own key: several days of full text can exceed the 128 KiB per-value limit.
    const { items, itemIds: _oldIds, ...metadata } = state;
    await this.ctx.storage.transaction(async tx => {
      const previous = await tx.get('state');
      const ids = new Set(items.map(i => i.id));
      const removed = (previous?.itemIds || []).filter(id => !ids.has(id)).map(id => 'item:' + id);
      if (removed.length) await tx.delete(removed);
      const values = Object.fromEntries(items.map(i => ['item:' + i.id, i]));
      values.state = { ...metadata, version: 2, itemIds: [...ids] };
      await tx.put(values);
    });
  }
  note(state, scope, error) {
    // Never persist credentials or upstream request URLs containing Telegram tokens.
    state.errors.push({ at: Date.now(), scope, message: String(error?.message || error).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]').slice(0,400) });
    state.errors = state.errors.slice(-20);
  }
  async fetch(request) {
    return this.locked(async () => {
      const url = new URL(request.url), state = await this.load();
      if (url.pathname === '/status') {
        return json({ enabled: state.enabled, nextCollection: state.nextCollection, nextStart: state.nextStart,
          lastAttempt: state.lastAttempt, audiencePolicy: 'general>=70%; technical<=30%', rebuildRequested: state.rebuildRequested || null, batches: state.batches.slice(-5), errors: state.errors,
          items: state.items.map(({ post, editorial, ...i }) => ({ ...i, title: editorial?.title || post.title, source: `https://www.moltbook.com/post/${post.id}`, text: editorial ? renderPost({ ...i, post, editorial }) : null })) });
      }
      if (url.pathname === '/pause') { state.enabled = false; await this.save(state); await this.ctx.storage.deleteAlarm(); return json({ enabled: false }); }
      if (url.pathname === '/start') {
        state.enabled = true;
        if (!state.nextStart) { state.nextStart = nextStart(Date.now(), this.env.DAILY_START); state.nextCollection = Date.now(); }
        if (!state.batches.length) state.nextCollection = Date.now();
        await this.save(state); await this.ctx.storage.setAlarm(Date.now() + 1000);
        return json({ enabled: true, firstPostAt: state.items.find(i => i.status === 'queued')?.dueAt || state.nextStart });
      }
      if (url.pathname === '/tick') { await this.tick(); return json({ ok: true }); }
      if (url.pathname === '/recurate') {
        if (state.enabled) return json({ error: 'Pause before changing the current queue' }, 409);
        const batch = state.batches.at(-1);
        if (!batch) return json({ error: 'No batch to rebuild' }, 409);
        state.rebuildRequested = batch.start; state.enabled = true;
        await this.save(state); await this.ctx.storage.setAlarm(Date.now() + 1000);
        return json({ accepted: true, batch: batch.start });
      }
      if (url.pathname === '/rewrite-pending') {
        if (state.enabled) return json({ error: 'Pause before rewriting' }, 409);
        let count = 0;
        for (const item of state.items) if (['pending','queued','failed'].includes(item.status) && item.dueAt > Date.now() - INTERVAL) {
          item.status = 'pending'; item.attempts = 0; item.nextRetry = 0; delete item.editorial; count++;
        }
        await this.save(state); return json({ count });
      }
      if (url.pathname === '/ai-check') {
        const result = await this.env.AI.run(this.env.AI_MODEL, { messages: [{ role: 'user', content: 'فقط بنویس: اتصال برقرار است. /no_think' }], max_tokens: 100 });
        return json(result);
      }
      return json({ error: 'Not found' }, 404);
    });
  }
  async alarm() { return this.locked(() => this.tick()); }
  async discover(seen, now) {
    const paths = ['/posts?sort=hot&limit=100', '/posts?sort=rising&limit=100',
      ...TOPIC_COMMUNITIES.flatMap(name => ['hot','new'].map(sort => `/posts?submolt=${name}&sort=${sort}&limit=25`))];
    const feeds = await Promise.allSettled(paths.map(sourceJSON));
    const hot = feeds[0].status === 'fulfilled' ? feeds[0].value.posts : [];
    const rising = feeds[1].status === 'fulfilled' ? feeds[1].value.posts : [];
    if (!hot?.length) throw new Error('Hot feed unavailable: ' + (feeds[0].status === 'rejected' ? feeds[0].reason.message : 'empty posts'));
    const candidates = new Map(selectPosts(hot, rising || [], seen, now, 40).map(p => [p.id,p]));
    for (const feed of feeds.slice(2)) {
      if (feed.status !== 'fulfilled' || !Array.isArray(feed.value.posts)) continue;
      const ranked = feed.value.posts.filter(p => Number(p.upvotes) > 0).sort((a,b) => {
        const score = p => (Math.max(0,Number(p.upvotes)||0) + Math.log1p(Number(p.comment_count)||0)) / Math.pow(2 + Math.max(0,now-Date.parse(p.created_at))/3600000,.45);
        return score(b)-score(a);
      });
      for (const p of selectPosts(ranked, [], seen, now, 8)) {
        if (!candidates.has(p.id)) candidates.set(p.id, { ...p, trend_score: p.trend_score * .8 });
      }
    }
    const all = [...candidates.values()].slice(0,250), classified = [];
    // Keep each response bounded; do not trust labels or IDs invented by the model.
    for (let offset = 0; offset < all.length; offset += 30) {
      const chunk = all.slice(offset,offset + 30);
      const result = await this.env.AI.run(this.env.CLASSIFIER_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [{ role: 'system', content: CLASSIFIER_PROMPT }, { role: 'user', content: JSON.stringify(chunk.map((p,i) => ({ i, title:p.title, text: String(p.content || '').slice(0,650), community:p.submolt?.name }))) }],
        max_tokens: 2400, temperature: .1, reasoning_effort: 'low',
        response_format: { type:'json_schema', json_schema:{ type:'object', properties:{ items:{ type:'array',items:{ type:'object',properties:{ i:{type:'integer'},category:{type:'string',enum:[...CATEGORIES,'skip']},appeal:{type:'integer',minimum:1,maximum:5}},required:['i','category','appeal'],additionalProperties:false}}},required:['items'],additionalProperties:false}},
      });
      classified.push(...parseLabels(modelText(result),chunk));
    }
    return { candidates: classified, hotCount: hot.length, risingCount: rising?.length || 0, screenedCount: all.length };
  }
  addSelection(state, selected, start, now, slots = null) {
    for (const [index, post] of selected.entries()) {
      const rank = slots ? slots[index] : index;
      const compact = { id: post.id, title: post.title, author: { name: post.author?.name }, upvotes: post.upvotes, comment_count: post.comment_count, created_at: post.created_at };
      state.items.push({ id: post.id, post: compact, category: post.category, appeal: post.appeal, rank: rank + 1, batch: start, collectedAt: now,
        dueAt: start + rank * INTERVAL, status: 'pending', attempts: 0, nextRetry: 0 });
      state.seen.push({ id: post.id, title: post.title_key, at: now });
    }
    state.items.sort((a,b) => a.dueAt-b.dueAt);
  }
  async rebuild(state, now) {
    const start = state.rebuildRequested;
    const fixed = state.items.filter(i => i.batch === start && ['sent','sending','unknown'].includes(i.status));
    // Pre-policy deliveries count as technical conservatively.
    fixed.forEach(i => { i.category ||= 'technical'; });
    const removed = new Set(state.items.filter(i => i.batch === start && !fixed.includes(i)).map(i => i.id));
    const seen = state.seen.filter(i => !removed.has(i.id));
    const report = await this.discover(seen,now);
    const slots = Array.from({length:DAILY_COUNT},(_,i)=>i).filter(i => start+i*INTERVAL >= now && !fixed.some(p => p.rank === i+1));
    const selected = chooseMix(report.candidates, fixed.length+slots.length, fixed);
    if (!selected.length) throw new Error('No suitable general-audience stories; old queue kept paused');
    state.items = state.items.filter(i => !removed.has(i.id)); state.seen = seen;
    this.addSelection(state,selected,start,now,slots);
    Object.assign(state.batches.find(b => b.start === start), { count:fixed.length+selected.length, rebuiltAt:now,
      generalCount: fixed.filter(i => i.category !== 'technical').length+selected.filter(i => i.category !== 'technical').length,
      technicalCount:fixed.filter(i => i.category === 'technical').length+selected.filter(i => i.category === 'technical').length,
      screenedCount:report.screenedCount, policy:'70/30' });
    delete state.rebuildRequested;
    await this.save(state);
  }
  async collect(state, now) {
    state.seen = state.seen.filter(x => x.at > now - 30 * DAY);
    const report = await this.discover(state.seen,now);
    const selected = chooseMix(report.candidates);
    if (!selected.length) throw new Error('No fresh general-audience trends available');
    // If a service outage spans days, resume with the next cycle instead of flooding old posts.
    if (state.nextStart + DAY <= now) state.nextStart = nextStart(now, this.env.DAILY_START);
    const start = state.nextStart;
    this.addSelection(state,selected,start,now);
    state.batches.push({ start, collectedAt: now, count:selected.length, hotCount:report.hotCount, risingCount:report.risingCount,
      screenedCount:report.screenedCount, policy:'70/30', generalCount:selected.filter(p => p.category !== 'technical').length,
      technicalCount:selected.filter(p => p.category === 'technical').length });
    state.batches = state.batches.slice(-30);
    state.items = state.items.filter(x => x.dueAt > now - 3 * DAY);
    state.nextStart = start + DAY;
    state.nextCollection = state.nextStart - 30 * MINUTE;
    await this.save(state);
  }
  async mainNarrative(post) {
    const result = await this.env.AI.run(this.env.AI_MODEL, {
      messages: [{ role:'system',content:NARRATOR_PROMPT }, { role:'user',content:JSON.stringify({title:post.title,author:post.author?.name,source_text:post.content.slice(0,16000)}) }],
      max_tokens:2000,temperature:.25,reasoning_effort:'low',
    });
    return validateSummary(modelText(result));
  }
  async prepare(item) {
    const [data, commentsData] = await Promise.all([sourceJSON('/posts/' + item.id), sourceJSON('/posts/' + item.id + '/comments?sort=best&limit=35')]);
    const post = data.post;
    if (!post || post.id !== item.id || post.is_deleted || post.is_spam || !post.content?.trim()) throw new Error('Full source content unavailable');
    const comments = selectComments(commentsData.comments,post.author?.name);
    // Cache the independently sourced main narrative even if reply generation must retry.
    if (!item.mainEditorial || item.mainEditorialVersion !== EDITORIAL_VERSION) {
      item.mainEditorial = await this.mainNarrative(post);
      item.mainEditorialVersion = EDITORIAL_VERSION;
    }
    let discussion = [];
    if (comments.length) {
      const result = await this.env.AI.run(this.env.AI_MODEL, {
        messages:[{role:'system',content:DISCUSSION_PROMPT},{role:'user',content:JSON.stringify({source_context:{title:post.title,text:post.content.slice(0,16000)},comments})}],
        max_tokens:2600,temperature:.25,reasoning_effort:'low',
      });
      const raw=modelText(result);
      const value=typeof raw === 'string' ? JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')) : raw;
      if (!Array.isArray(value?.discussion)) throw new Error('Missing discussion output');
      discussion=validateDiscussion(value.discussion,comments);
    }
    item.editorial = {...item.mainEditorial,discussion};
    item.editorialVersion = EDITORIAL_VERSION;
    item.commentsChecked = comments.length; item.commentsCheckedAt = Date.now();
    // All text and attribution must fit one Telegram post; retry instead of silently dropping the discussion.
    if (renderPost(item).length > 4000) throw new Error('Narrative and discussion exceed message budget');
    item.status = 'queued';
    console.log(JSON.stringify({event:'editorial_ready',id:item.id,version:EDITORIAL_VERSION,replies:item.editorial.discussion.length}));
  }
  async correctMixedExample(state) {
    if (state.morningCorrection?.done || state.morningCorrection?.attempts >= 3) return;
    const item=state.items.find(i=>i.id===MORNING_POST_ID && i.status==='sent' && i.messageId);
    if (!item) return;
    state.morningCorrection ||= {attempts:0};
    try {
      const {post}=await sourceJSON('/posts/'+item.id);
      if (!post || post.id!==item.id || !post.content?.trim() || post.is_deleted || post.is_spam) throw new Error('Correction source unavailable');
      state.morningCorrection.editorial ||= await this.mainNarrative(post);
      const revised={...item,editorial:{...state.morningCorrection.editorial,discussion:item.editorial.discussion || []}};
      if (renderPost(revised).length>4000) throw new Error('Correction exceeds message budget');
      const response=await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/editMessageText`,{
        method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(25000),
        body:JSON.stringify({chat_id:this.env.TELEGRAM_CHAT_ID,message_id:item.messageId,text:renderPost(revised),parse_mode:'HTML',link_preview_options:{is_disabled:true}}),
      });
      const result=await response.json();
      if (!result.ok && !String(result.description).includes('message is not modified')) throw new Error('Telegram rejected morning edit: '+response.status);
      item.editorial=revised.editorial;item.editorialVersion=EDITORIAL_VERSION;
      state.morningCorrection.done=true;
      console.log(JSON.stringify({event:'example_corrected',id:item.id,messageId:item.messageId,version:EDITORIAL_VERSION}));
    } catch(error) {state.morningCorrection.attempts++;this.note(state,'morning_correction',error);}
    await this.save(state);
  }
  async correctPublishedExample(state) {
    if (state.gamingCorrection?.done || state.gamingCorrection?.attempts >= 3) return;
    const item = state.items.find(i => i.id === GAMING_POST_ID && i.status === 'sent' && i.messageId);
    if (!item) return;
    state.gamingCorrection ||= {attempts:0};
    try {
      const data = await sourceJSON('/posts/'+item.id+'/comments?sort=best&limit=35');
      const sources = selectComments(data.comments,item.post.author?.name);
      const revised = {...item,editorial:{...validateSummary(GAMING_CORRECTION),discussion:validateDiscussion(GAMING_CORRECTION.discussion,sources)}};
      const response = await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/editMessageText`,{
        method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(25000),
        body:JSON.stringify({chat_id:this.env.TELEGRAM_CHAT_ID,message_id:item.messageId,text:renderPost(revised),parse_mode:'HTML',link_preview_options:{is_disabled:true}}),
      });
      const result = await response.json();
      if (!result.ok && !String(result.description).includes('message is not modified')) throw new Error('Telegram rejected example edit: '+response.status);
      item.editorial=revised.editorial; item.editorialVersion=EDITORIAL_VERSION;
      state.gamingCorrection.done=true;
      console.log(JSON.stringify({event:'example_corrected',messageId:item.messageId,id:item.id}));
    } catch(error) { state.gamingCorrection.attempts++; this.note(state,'example_correction',error); }
    await this.save(state);
  }
  async publish(item, state, now) {
    item.status = 'sending'; item.sendingAt = now;
    state.lastAttempt = now;
    await this.save(state); // Persist intent before external side effect.
    let response, data;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({ chat_id: this.env.TELEGRAM_CHAT_ID, text: renderPost(item), parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
      });
      data = await response.json();
    } catch {
      item.status = 'unknown';
      this.note(state, 'telegram', new Error('Ambiguous delivery: not automatically retried to prevent duplicates'));
      await this.save(state); return;
    }
    if (data.ok && data.result?.message_id) {
      item.status = 'sent'; item.messageId = data.result.message_id; item.sentAt = Date.now();
      console.log(JSON.stringify({event:'published',id:item.id,rank:item.rank,messageId:item.messageId,sentAt:item.sentAt}));
    } else if (response.status >= 500) {
      item.status = 'unknown'; this.note(state, 'telegram', new Error('Server error; delivery uncertain, manual reconciliation required'));
    } else {
      item.status = 'failed'; item.failure = `Telegram ${data.error_code || response.status}: ${String(data.description || '').slice(0,200)}`;
      this.note(state, 'telegram', new Error(item.failure));
      console.log(JSON.stringify({event:'delivery_error',id:item.id,failure:item.failure}));
      if ([401, 403].includes(data.error_code)) state.enabled = false;
    }
    await this.save(state);
  }
  async tick() {
    const state = await this.load();
    console.log(JSON.stringify({event:'queue_snapshot',enabled:state.enabled,lastAttempt:state.lastAttempt,slots:state.items.map(i=>({id:i.id,rank:i.rank,batch:i.batch,dueAt:i.dueAt,status:i.status,category:i.category,ready:!!i.editorial,messageId:i.messageId,attempts:i.attempts,failure:i.failure})),errors:state.errors.slice(-5)}));
    if (!state.enabled) return;
    const now = Date.now();
    if ((state.editorialVersion || 0) < EDITORIAL_VERSION) {
      for (const item of state.items) {
        if (['queued','pending','failed'].includes(item.status) && item.dueAt + INTERVAL > now) {
          item.status = 'pending'; item.attempts = 0; item.nextRetry = 0; delete item.editorial;
        }
      }
      state.editorialVersion = EDITORIAL_VERSION;
      await this.save(state);
    }
    // Watchdog survives crashes during external calls. Cron is a second recovery path.
    await this.ctx.storage.setAlarm(now + 2 * MINUTE);
    try {
      await this.correctPublishedExample(state);
      await this.correctMixedExample(state);
      if (state.rebuildRequested) {
        try { await this.rebuild(state,now); }
        catch (error) { this.note(state,'recuration',error); state.enabled = false; await this.save(state); await this.ctx.storage.deleteAlarm(); return; }
      }
      for (const item of state.items) {
        if (item.status === 'sending') { item.status = 'unknown'; this.note(state, 'delivery', new Error(`Unfinished delivery ${item.id}; automatic retry suppressed`)); }
        if (['pending','queued'].includes(item.status) && now >= item.dueAt + INTERVAL) item.status = 'expired';
      }
      if (now >= state.nextCollection) {
        try { await this.collect(state, now); }
        catch (error) { this.note(state, 'collection', error); state.nextCollection = now + 15 * MINUTE; }
      }
      const recovered = recoverReadySlot(state,now);
      if (recovered) {
        await this.save(state);
        console.log(JSON.stringify({event:'slot_recovered',...recovered}));
      }
      const due = state.items.find(i => i.status === 'queued' && i.dueAt <= now);
      if (due && now - state.lastAttempt >= INTERVAL) {
        const delivered = state.items.filter(i => i.batch === due.batch && ['sent','sending','unknown'].includes(i.status));
        const technical = delivered.filter(i => !i.category || i.category === 'technical').length;
        if (due.category === 'technical' && (technical+1)/(delivered.length+1) > .3) due.status = 'skipped_quota';
        else await this.publish(due, state, now);
      }
      const pending = state.items.find(i => i.status === 'pending' && i.nextRetry <= now);
      if (pending) {
        try { await this.prepare(pending); }
        catch (error) {
          pending.attempts++; pending.nextRetry = Date.now() + Math.min(30, 2 ** pending.attempts) * MINUTE;
          this.note(state, 'editorial', error);
          if (pending.attempts >= 4) pending.status = 'failed';
        }
      }
      await this.save(state);
    } catch (error) { this.note(state, 'tick', error); await this.save(state); }
    if (state.enabled) {
      const soon = state.items.some(i => i.status === 'pending' && i.nextRetry <= Date.now());
      const events = [Date.now() + (soon ? 1000 : 5 * MINUTE), state.nextCollection,
        ...state.items.filter(i => i.status === 'queued').map(i => Math.max(i.dueAt, state.lastAttempt + INTERVAL)),
        ...state.items.filter(i => i.status === 'pending').map(i => i.nextRetry)];
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(...events.filter(t => t > Date.now()))));
    } else await this.ctx.storage.deleteAlarm();
  }
}

async function authorized(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const received = request.headers.get('Authorization') || '';
  const encoder = new TextEncoder();
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(received)));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode('Bearer ' + env.ADMIN_TOKEN)));
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
function editor(env) { return env.EDITOR.get(env.EDITOR.idFromName('main')); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'ai-social-network', source: 'Moltbook', editorialVersion: EDITORIAL_VERSION });
    if (!url.pathname.startsWith('/admin/')) return json({ error: 'Not found' }, 404);
    if (!await authorized(request, env)) return json({ error: 'Unauthorized' }, 401);
    const path = url.pathname.replace('/admin', '');
    if ((path === '/status' && request.method !== 'GET') || (path !== '/status' && request.method !== 'POST')) return json({ error: 'Method not allowed' }, 405);
    return editor(env).fetch(new Request('https://editor.internal' + path, { method: request.method }));
  },
  async scheduled(_event, env, ctx) { ctx.waitUntil(editor(env).fetch(new Request('https://editor.internal/tick', { method: 'POST' }))); },
};
