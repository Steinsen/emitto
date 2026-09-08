// worker/index.js – allt utom /api/* serveras som statiska filer, precis som förr. Det enda
// som ändras är att /api/coach nu finns: den tar mätvärdena (och de bildrutor användaren valt
// att skicka), frågar en språkmodell och lämnar tillbaka en formulerad text.
//
// Vad som aldrig passerar här: videon. Klippet läses i webbläsaren och stannar där – det är
// produktlöftet, och det är också därför den här filen bara känner till siffror och enstaka
// beskurna JPEG:ar.
//
// Ingenting sparas och ingenting loggas om spelaren. Uppströmssvaret går aldrig vidare till
// klienten: går något fel svarar vi med en kod i samma stil som analysens egna (E_NO_SHOT), och
// klienten faller tillbaka på rules.js texter.

import { METRIC_KEYS } from '../rules.js';
import { systemPrompt } from './prompt.js';

const API = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
const UPSTREAM_TIMEOUT_MS = 45000;
const MAX_TOKENS = 4000;

const MAX_BODY = 1_400_000;      // 5 bilder à 200 kB base64 + siffrorna, med marginal
const MAX_FRAMES = 5;
const MAX_FRAME_BYTES = 200 * 1024;
const PHASES = ['lowest', 'set', 'release', 'follow', 'landing'];
const STATUS = ['good', 'meh', 'poor', 'na'];

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store' },
});
const fail = (code, status) => json({ error: code }, status);

// ---------------------------------------------------------------- svarets form
//
// Schemat är det modellen tvingas följa (structured outputs). Att det håller betyder bara att
// fälten finns – att innehållet stämmer med vår prioritering kontrolleras separat i checkShape.

const str = { type: 'string' };
const strList = { type: 'array', items: str };
const nullable = schema => ({ anyOf: [{ type: 'null' }, schema] });

export const SCHEMA = {
  type: 'object',
  properties: {
    summary: str,
    strengths: strList,
    priority: nullable({
      type: 'object',
      properties: { key: str, title: str, what: str, why: str, drill: str, encouragement: str },
      required: ['key', 'title', 'what', 'why', 'drill', 'encouragement'],
      additionalProperties: false,
    }),
    secondary: {
      type: 'array',
      items: { type: 'object', properties: { key: str, text: str }, required: ['key', 'text'], additionalProperties: false },
    },
    observations: strList,
    uncertainties: strList,
    after: nullable({
      type: 'object',
      properties: { title: str, text: str, basis: { type: 'string', enum: ['measured', 'frames', 'both'] } },
      required: ['title', 'text', 'basis'],
      additionalProperties: false,
    }),
    disagreement: nullable(str),
  },
  required: ['summary', 'strengths', 'priority', 'secondary', 'observations', 'uncertainties', 'after', 'disagreement'],
  additionalProperties: false,
};

// Lita inte på prompten ensam. Prioriteringen är räknad i rules.js och ska vara det: svarar
// modellen om en annan nyckel, i en annan ordning, eller om fler punkter än vi skickade, kastar
// vi svaret. Hellre rules.js egen text än en lista som ser deterministisk ut men inte är det.
export function checkShape(out, payload) {
  if (!out || typeof out !== 'object') return 'not an object';
  const issues = payload.issues || [];
  const keys = issues.map(i => i.key);

  if (issues.length === 0) {
    if (out.priority !== null) return 'priority must be null when there are no issues';
    if (out.secondary?.length) return 'secondary must be empty when there are no issues';
  } else {
    if (!out.priority) return 'priority missing';
    if (out.priority.key !== keys[0]) return `priority.key ${out.priority.key} != ${keys[0]}`;
    const sec = out.secondary || [];
    if (sec.length > keys.length - 1) return 'secondary longer than the issue list';
    for (let i = 0; i < sec.length; i++) {
      if (sec[i].key !== keys[i + 1]) return `secondary[${i}].key ${sec[i].key} != ${keys[i + 1]}`;
    }
  }
  // Inga bilder skickades: då finns inget att ha observerat.
  if (!payload.frames?.length && out.observations?.length) return 'observations without frames';
  if (out.after && !['measured', 'frames', 'both'].includes(out.after.basis)) return 'bad after.basis';
  return null;
}

// ---------------------------------------------------------------- vad vi tar emot
//
// Handskriven validering, inga beroenden. Den finns inte för att vara sträng mot vår egen app
// utan för att den här adressen är öppen: allt som inte ser ut som en analys ska bort innan
// något skickas vidare och kostar pengar.

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const numOrNull = v => v === null || isNum(v);
const text = (v, max) => typeof v === 'string' && v.length <= max;
const B64 = /^[A-Za-z0-9+/=\s]*$/;

export function validate(body) {
  if (!body || typeof body !== 'object') return 'body';
  if (!['sv', 'en'].includes(body.lang)) return 'lang';

  const age = body.player?.age;
  if (!(age === null || age === undefined || (isNum(age) && age >= 5 && age <= 99))) return 'age';
  if (!(isNum(body.speedFactor) && body.speedFactor >= 1 && body.speedFactor <= 16)) return 'speedFactor';
  if (body.fps != null && !isNum(body.fps)) return 'fps';

  if (!body.phases || typeof body.phases !== 'object') return 'phases';
  for (const k of ['lowest_ms', 'set_ms', 'release_ms', 'takeoff_ms']) {
    if (!numOrNull(body.phases[k] ?? null)) return `phases.${k}`;
  }

  if (!Array.isArray(body.metrics) || body.metrics.length > METRIC_KEYS.length) return 'metrics';
  for (const m of body.metrics) {
    if (!m || !METRIC_KEYS.includes(m.key)) return 'metrics.key';
    if (!numOrNull(m.value)) return 'metrics.value';
    if (!text(m.unit, 20)) return 'metrics.unit';
    if (!Array.isArray(m.ref) || m.ref.length !== 2 || !m.ref.every(isNum)) return 'metrics.ref';
    if (!STATUS.includes(m.status)) return 'metrics.status';
    if (m.confidence !== undefined && m.confidence !== 'low') return 'metrics.confidence';
  }

  if (!Array.isArray(body.issues) || body.issues.length > 5) return 'issues';
  for (const i of body.issues) {
    if (!i || !METRIC_KEYS.includes(i.key)) return 'issues.key';
    if (!STATUS.includes(i.status)) return 'issues.status';
    if (!['low', 'high', 'in'].includes(i.dir)) return 'issues.dir';
    if (!text(i.title, 200)) return 'issues.title';
  }

  const pr = body.postRelease || {};
  for (const k of ['landing_ms', 'driftLanding', 'trunkAfterRelease', 'landingSplit_ms']) {
    if (!numOrNull(pr[k] ?? null)) return `postRelease.${k}`;
  }

  const frames = body.frames || [];
  if (!Array.isArray(frames) || frames.length > MAX_FRAMES) return 'frames';
  for (const f of frames) {
    if (!f || !PHASES.includes(f.phase)) return 'frames.phase';
    if (!text(f.jpeg_base64, MAX_FRAME_BYTES) || !B64.test(f.jpeg_base64)) return 'frames.jpeg_base64';
  }
  return null;
}

// ---------------------------------------------------------------- anropet uppåt

async function askModel(env, payload) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('E_COACH_CONFIG');

  // Bilderna först, siffrorna sist: modellen ska läsa bilderna som kontext till mätvärdena.
  const content = (payload.frames || []).map(f => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: f.jpeg_base64 },
  }));
  // Bilddatan hör inte hemma i texten – där räcker det att veta vilka faser som följde med.
  const forModel = { ...payload, frames: (payload.frames || []).map(f => ({ phase: f.phase })) };
  content.push({ type: 'text', text: JSON.stringify(forModel) });

  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        // Systemprompten är samma vid varje anrop och den är lång – cachad kostar den nästan
        // ingenting från och med andra klippet.
        system: [{ type: 'text', text: systemPrompt(payload.lang), cache_control: { type: 'ephemeral' } }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content }],
      }),
    });
  } catch {
    throw new Error('E_COACH_UPSTREAM');   // nätverk eller timeout
  }

  if (!res.ok) {
    // Statuskoden, inget mer: svaret kan innehålla vår egen prompt och ska inte lämna spår.
    console.log(`coach upstream ${res.status}`);
    throw new Error(res.status === 429 ? 'E_COACH_RATE' : 'E_COACH_UPSTREAM');
  }

  const msg = await res.json().catch(() => null);
  if (!msg || msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') throw new Error('E_COACH_SCHEMA');
  const block = (msg.content || []).find(b => b.type === 'text');
  if (!block) throw new Error('E_COACH_SCHEMA');
  try {
    return JSON.parse(block.text);
  } catch {
    throw new Error('E_COACH_SCHEMA');
  }
}

// ---------------------------------------------------------------- routing

async function coach(request, env) {
  if (request.method !== 'POST') return fail('E_COACH_INPUT', 405);
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return fail('E_COACH_INPUT', 413);

  // Ett tak per IP. Räcker det inte finns Turnstile att sätta framför.
  // TODO: Turnstile när adressen börjar bli intressant att missbruka.
  if (env.COACH_RATE) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.COACH_RATE.limit({ key: ip });
    if (!success) return fail('E_COACH_RATE', 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('E_COACH_INPUT', 400);
  }
  if (validate(body)) return fail('E_COACH_INPUT', 400);

  let out;
  try {
    out = await askModel(env, body);
  } catch (e) {
    const code = /^E_COACH_/.test(e.message) ? e.message : 'E_COACH_UPSTREAM';
    return fail(code, code === 'E_COACH_RATE' ? 429 : code === 'E_COACH_CONFIG' ? 500 : 502);
  }

  const bad = checkShape(out, body);
  if (bad) {
    console.log(`coach shape rejected: ${bad}`);
    return fail('E_COACH_SCHEMA', 502);
  }
  return json(out);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/coach') return coach(request, env);
    if (pathname.startsWith('/api/')) return fail('E_NOT_FOUND', 404);
    return env.ASSETS.fetch(request);   // allt annat är sajten, som förut
  },
};
