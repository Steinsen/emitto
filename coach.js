// coach.js – lagret mellan rules.js och app.js. Det vet vad som skickas till /api/coach och hur
// svaret ser ut. Inget om ledpunkter (det är analysis.js sak) och inget om gränssnittet.
//
// Varför ett lager alls: prioriteringen är och förblir deterministisk. Modellen får formulera
// listan, aldrig välja den. Därför skickas issueList i sin ordning, och därför är fallbacken –
// rules.js egna texter – normalläget och inte ett undantag. Är telefonen offline, saknas nyckeln
// eller svarar modellen något som inte stämmer med listan, står texten kvar som den var.
//
// coach.js importerar med flit inte i18n.js: den läser navigator redan vid import, och då gick
// modulen inte att testa i node. Språket kommer in som argument.

import { issueList, metricSpec } from './rules.js';
import { personCrop } from './draw.js';

// Faser som får skickas som bild. 'landing' finns bara när postRelease hittade en landning.
export const COACH_PHASES = ['lowest', 'set', 'release', 'follow', 'landing'];

export const MAX_FRAMES = 5;
const FRAME_PX = 480;         // längsta sidan i en skickad ruta
const FRAME_QUALITY = 0.7;
const FRAME_ASPECT = 3 / 4;   // samma utsnitt som resultatvyn och delningsbilden

// Under så här många analyserade rutor per verklig sekund märks mätvärdena som osäkra. Vid
// 15 rutor/s ligger en tidpunkt på ±33 ms och en vinkel kan vara avläst en ruta bredvid sitt
// verkliga ytterläge. Ett klipp i slow motion ger fler rutor per verklig sekund, inte färre:
// rescaleTime delar tiden med faktorn, så 15 rutor/s i ett 4×-klipp är 60 i verklig tid.
export const FPS_CONFIDENT = 50;
const VIS_MIN = 0.5;          // MediaPipes visibility under detta = leden syntes dåligt

const round = (v, dec = 2) => (v == null || Number.isNaN(v) ? null : Number(v.toFixed(dec)));

// ---------------------------------------------------------------- vad som skickas
//
// Ren funktion, ingen DOM: allt kommer ur det resultat appen redan räknat fram. Bilderna görs
// separat (collectFrames) och skickas in, eftersom de kräver canvas och samtycke.

export function buildPayload({ lang, age = null, data, frames = [] }) {
  const { prio, ph, speed, times = {}, pr = {}, vis = {} } = data;
  const fps = ph.fps;
  const lowFps = !(fps >= FPS_CONFIDENT);

  // Låg konfidens är inte ett fel utan en upplysning: modellen ska säga hur säkert något är
  // mätt och vad som skulle ge en bättre mätning, inte tiga om det.
  const confidenceOf = key => (lowFps || (vis[key] != null && vis[key] < VIS_MIN) ? 'low' : null);

  const metrics = prio.graded.map(g => {
    const spec = metricSpec(g.key);
    const conf = confidenceOf(g.key);
    return {
      key: g.key,
      value: round(g.value, spec.unit === 'deg' ? 1 : 3),
      unit: spec.unit,
      ref: spec.ok,
      status: g.status,
      ...(conf ? { confidence: conf } : {}),
    };
  });

  // issueList i sin ordning. Rubriken följer med så att modellen ser vad appen redan säger –
  // den ska formulera om den, inte hitta på ett annat fel.
  const issues = issueList(prio, lang, 5).map(it => ({
    key: it.key,
    status: it.status,
    dir: it.dir,
    value: round(it.value, metricSpec(it.key).unit === 'deg' ? 1 : 3),
    severity: round(it.severity, 2),
    title: it.title,
  }));

  const ms = t => (t == null ? null : Math.round(t * 1000));

  return {
    lang,
    player: { age: age == null ? null : Number(age) },
    speedFactor: speed.factor,
    speedAssumed: speed.source === 'assumed',
    fps: round(fps, 1),
    phases: {
      lowest_ms: ms(times.lowest),
      set_ms: ms(times.set),
      release_ms: ms(times.release),
      takeoff_ms: ms(times.takeoff),
    },
    metrics,
    issues,
    // Utan ref och utan status: rules.js sätter inga gränser efter släppet, och det är poängen.
    postRelease: {
      landing_ms: pr.landing_ms ?? null,
      driftLanding: round(pr.driftLanding, 3),
      trunkAfterRelease: round(pr.trunkAfterRelease, 1),
      landingSplit_ms: pr.landingSplit_ms ?? null,
    },
    frames: frames.slice(0, MAX_FRAMES),
  };
}

// ---------------------------------------------------------------- bildrutorna
//
// Bilderna kommer ur de rutor som redan lästes av under analysen, beskurna runt spelaren med
// samma personCrop som resultatvyn och delningsbilden. Inga nya sökningar i videon, och aldrig
// klippet – bara stillbilder, och bara när användaren kryssat i rutan.

export function collectFrames(shots, frameAspect, { max = MAX_FRAMES, px = FRAME_PX, quality = FRAME_QUALITY } = {}) {
  const out = [];
  for (const shot of shots.slice(0, max)) {
    const src = shot.canvas;
    const crop = personCrop(shot.lm, frameAspect, FRAME_ASPECT);
    const sw = crop.w * src.width, sh = crop.h * src.height;
    const scale = Math.min(1, px / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    c.getContext('2d').drawImage(src,
      crop.x * src.width, crop.y * src.height, sw, sh, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', quality);
    out.push({ phase: shot.key, jpeg_base64: url.slice(url.indexOf(',') + 1) });
  }
  return out;
}

// ---------------------------------------------------------------- anropet

export const COACH_URL = '/api/coach';
const TIMEOUT_MS = 30000;

export async function requestCoach(payload, { timeoutMs = TIMEOUT_MS, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(COACH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || 'E_COACH');
    return body;
  } catch (e) {
    throw e instanceof Error && e.message.startsWith('E_') ? e : new Error('E_COACH');
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- svaret in i listan
//
// Ordningen kommer alltid från rules.js. Modellens text får bara läggas på den post som har
// samma nyckel; stämmer den inte behåller posten sin egen text. Workern kontrollerar samma sak,
// men listan får inte kunna ändras även om något slinker igenom där.

export function merge(issues, coach) {
  if (!coach) return issues.map(it => ({ ...it, ai: false }));
  return issues.map((it, i) => {
    if (i === 0) {
      const p = coach.priority;
      return p && p.key === it.key
        ? { ...it, title: p.title, what: p.what, why: p.why, drill: p.drill, pep: p.encouragement, ai: true }
        : { ...it, ai: false };
    }
    const sec = coach.secondary?.[i - 1];
    return sec && sec.key === it.key ? { ...it, why: sec.text, ai: true } : { ...it, ai: false };
  });
}
