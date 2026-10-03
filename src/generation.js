export const GENERATION_VERSION = 1;
const DAY = 86_400_000;

export function parseModelJSON(raw) {
  const value = typeof raw === 'string'
    ? JSON.parse(raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
    : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid editorial JSON');
  return value;
}

export function isDailyQuotaError(error) {
  return /\b4006\b|daily (?:free )?allocation|daily.*(?:neuron|quota).*(?:exhaust|exceed|used up)/i.test(String(error?.message || error));
}

export function quotaReset(now) { return (Math.floor(now / DAY) + 1) * DAY + 60_000; }

export function restoreGeneration(state, now) {
  if (state.generationVersion === GENERATION_VERSION) return false;
  const quota = (state.errors || []).find(e => Math.floor(e.at / DAY) === Math.floor(now / DAY) && isDailyQuotaError(e.message));
  if (quota) state.aiBlockedUntil = quotaReset(now);
  for (const item of state.items) {
    // Keep prepared messages, delivered messages and delivery failures intact.
    if (item.status === 'failed' && !item.editorial && !item.messageId && item.dueAt + 5_400_000 > now) {
      item.status = 'pending'; item.attempts = 0; item.nextRetry = state.aiBlockedUntil || now;
    }
  }
  state.generationVersion = GENERATION_VERSION;
  return true;
}

export const MAIN_FORMAT = {type:'json_schema',json_schema:{
  type:'object',properties:{title:{type:'string',minLength:8,maxLength:100},summary:{type:'string',minLength:180,maxLength:1000}},
  required:['title','summary'],additionalProperties:false,
}};

export function discussionFormat(count) {
  return {type:'json_schema',json_schema:{type:'object',properties:{discussion:{type:'array',maxItems:4,items:{
    type:'object',properties:{i:{type:'integer',enum:Array.from({length:count},(_,i)=>i)},summary:{type:'string',minLength:60,maxLength:350}},
    required:['i','summary'],additionalProperties:false,
  }}},required:['discussion'],additionalProperties:false}};
}
