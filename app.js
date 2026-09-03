// app.js – laddar klippet, kör MediaPipe Pose i webbläsaren, ritar resultatet.
// Videon lämnar aldrig telefonen. Bara siffror skulle behöva skickas till en Worker senare.
import { FilesetResolver, PoseLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
import { L, angle, pickSide, signals, findPhases, metrics } from './analysis.js';
import { prioritize, issueList, allClear, goodNote, labelOf, unitIn, refOf, METRIC_PHASE } from './rules.js';
import { t, getLang, setLang, applyStatic, LANGS } from './i18n.js';

const $ = id => document.getElementById(id);
const video = $('video'), file = $('file');
const views = { start: $('view-start'), loading: $('view-loading'), result: $('view-result') };
const bar = $('progress').querySelector('i');

const SAMPLE_FPS = 15;   // rutor/sekund som analyseras. 15 räcker för faserna, 30 ger bättre tempo.
const MAX_SECONDS = 8;
const PHASE_H = 560;     // höjd på fasbilderna. Större än remsan förr, men bara fyra rutor sparas.

const PHASES = [
  { key: 'lowest',  label: 'phaseLowest' },
  { key: 'set',     label: 'phaseSet' },
  { key: 'release', label: 'phaseRelease' },
  { key: 'follow',  label: 'phaseFollow' },
];

let landmarker = null;
let fileUrl = null;
let last = null;   // sparat resultat, så språkbyte kan rita om utan att analysera igen

// ---------------------------------------------------------------- vyer och språk

function show(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
}

function buildLangPicker() {
  const box = $('lang');
  box.innerHTML = '';
  box.setAttribute('aria-label', t('langLabel'));
  for (const l of LANGS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = l.toUpperCase();
    b.setAttribute('aria-pressed', String(l === getLang()));
    b.addEventListener('click', () => { setLang(l); refresh(); });
    box.appendChild(b);
  }
}

// Ritar om allt som har text. Anropas vid start och vid språkbyte.
function refresh() {
  applyStatic();
  buildLangPicker();
  document.title = `Emitto – ${t('tag')}`;
  if (last) renderResult(last);
}

// ---------------------------------------------------------------- analys

file.addEventListener('change', async () => {
  const f = file.files[0];
  if (!f) return;
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = URL.createObjectURL(f);
  video.src = fileUrl;
  last = null;
  $('error').textContent = '';
  bar.style.width = '0%';
  show('loading');
  try {
    await analyze();
  } catch (e) {
    const codes = { E_FEW_FRAMES: 'errTooFewFrames', E_NO_SHOT: 'errNoShot', E_NO_PERSON: 'errNoPerson' };
    $('error').innerHTML = `<div class="error">${t(codes[e.message] || 'errNoShot')}</div>`;
    show('start');
  } finally {
    file.value = '';   // så att samma fil kan väljas igen
  }
});

$('again').addEventListener('click', () => { last = null; $('error').textContent = ''; show('start'); });

async function loadModel() {
  if (landmarker) return landmarker;
  $('loadmsg').textContent = t('loadingModel');
  const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  return landmarker;
}

const seek = time => new Promise(res => { video.onseeked = () => res(); video.currentTime = time; });

async function analyze() {
  await loadModel();
  await new Promise(res => (video.readyState >= 1 ? res() : (video.onloadedmetadata = res)));
  $('loadmsg').textContent = t('loadingAnalyze');

  const dur = Math.min(video.duration, MAX_SECONDS);
  const aspect = video.videoWidth / video.videoHeight;
  const step = 1 / SAMPLE_FPS;
  const frames = [];
  let ts = 0;
  for (let time = 0; time <= dur; time += step) {
    await seek(time);
    ts += Math.round(step * 1000) + 1; // måste vara strikt ökande
    const res = landmarker.detectForVideo(video, ts);
    if (res.landmarks && res.landmarks[0]) frames.push({ t: time, lm: res.landmarks[0] });
    bar.style.width = `${(time / dur) * 90}%`;
  }
  if (frames.length < 10) throw new Error('E_NO_PERSON');

  const side = pickSide(frames, 'auto');
  const sig = signals(frames, side, aspect);
  const ph = findPhases(sig);
  const m = metrics(sig, ph);

  // Bara de fyra bildrutor som visas sparas. Att spara alla kostade över 100 MB på en telefon.
  $('loadmsg').textContent = t('loadingFrames');
  const shots = [];
  for (const p of PHASES) {
    const idx = ph[p.key];
    await seek(frames[idx].t);
    const c = document.createElement('canvas');
    c.height = PHASE_H;
    c.width = Math.round(PHASE_H * aspect);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    shots.push({ ...p, canvas: c, lm: frames[idx].lm, time: frames[idx].t });
  }
  bar.style.width = '100%';

  last = { shots, side, m, ph, prio: prioritize(m) };
  renderResult(last);
  show('result');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------- ritning

const BONES = side => (side === 'right'
  ? [[L.rSho, L.rElb], [L.rElb, L.rWri], [L.rSho, L.rHip], [L.rHip, L.rKnee], [L.rKnee, L.rAnk]]
  : [[L.lSho, L.lElb], [L.lElb, L.lWri], [L.lSho, L.lHip], [L.lHip, L.lKnee], [L.lKnee, L.lAnk]]);

const J = side => (side === 'right'
  ? { sho: L.rSho, elb: L.rElb, wri: L.rWri, hip: L.rHip, knee: L.rKnee, ank: L.rAnk }
  : { sho: L.lSho, elb: L.lElb, wri: L.lWri, hip: L.lHip, knee: L.lKnee, ank: L.lAnk });

const STATUS_COLOR = { good: '#1F9D6A', meh: '#E0A800', poor: '#D64545', na: '#8FA3AB' };

// Vilka vinklar som går att rita ut som en båge i en led, per mätvärde.
const ARC = {
  kneeMin:     j => [j.hip, j.knee, j.ank],
  kneeRelease: j => [j.hip, j.knee, j.ank],
  elbowSet:    j => [j.sho, j.elb, j.wri],
};

function drawPhase(shot, side, arcs) {
  const { canvas: src, lm } = shot;
  const c = shot.view;
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const X = k => lm[k].x * c.width, Y = k => lm[k].y * c.height;

  ctx.lineWidth = Math.max(3, c.width / 110);
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#FFE600';
  for (const [a, b] of BONES(side)) {
    ctx.beginPath(); ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.stroke();
  }

  if (!arcs.length) return;
  const j = J(side);
  const r = c.width / 7;
  for (const g of arcs) {
    const pts = ARC[g.key]?.(j);
    if (!pts) continue;
    const [a, b, cc] = pts;
    const color = STATUS_COLOR[g.status];
    const a0 = Math.atan2(Y(a) - Y(b), X(a) - X(b));
    const a1 = Math.atan2(Y(cc) - Y(b), X(cc) - X(b));
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(4, c.width / 90);
    ctx.beginPath();
    ctx.arc(X(b), Y(b), r, a0, a1, angleDiff(a0, a1) < 0); // korta vägen mellan strålarna
    ctx.stroke();

    const label = `${Math.round(g.value)}°`;
    ctx.font = `600 ${Math.round(c.width / 13)}px "Barlow Condensed", Barlow, sans-serif`;
    const w = ctx.measureText(label).width + 16;
    const h = Math.round(c.width / 10);
    const lx = Math.min(c.width - w - 6, Math.max(6, X(b) + r * 0.5));
    const ly = Math.min(c.height - h - 6, Math.max(6, Y(b) - h / 2));
    ctx.fillStyle = color;
    ctx.beginPath();
    // roundRect saknas i iOS Safari före 16.4 – hellre en fyrkant än ett kastat fel
    if (ctx.roundRect) ctx.roundRect(lx, ly, w, h, 6); else ctx.rect(lx, ly, w, h);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + 8, ly + h / 2);
  }
}

// Kortaste vägen mellan två vinklar, används för att välja bågens riktning.
function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// ---------------------------------------------------------------- resultat

function fmt(value, key) {
  if (value == null) return '–';
  const r = refOf(key);
  const dec = r.dec ?? (r.unit === 's' ? 2 : 0);
  const unit = unitIn(key, getLang());
  return unit === '°' ? `${value.toFixed(dec)}${unit}` : `${value.toFixed(dec)} ${unit}`;
}

function renderResult(data) {
  const { shots, side, m, ph, prio } = data;
  const lang = getLang();
  const byPhase = {};
  for (const g of prio.graded) (byPhase[METRIC_PHASE[g.key]] ||= []).push(g);

  // Faserna
  const wrap = $('phases');
  wrap.innerHTML = '';
  for (const shot of shots) {
    const fig = document.createElement('figure');
    fig.className = 'phase';
    fig.dataset.open = 'false';
    const view = document.createElement('canvas');
    shot.view = view;
    const cap = document.createElement('figcaption');
    cap.innerHTML = `<span class="name">${t(shot.label)}</span><span class="time">${shot.time.toFixed(2)} s</span>`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'toggle';
    toggle.textContent = t('showAngles');
    const list = document.createElement('ul');
    list.className = 'angles';
    list.hidden = true;

    const graded = byPhase[shot.key] || [];
    list.innerHTML = graded.length
      ? graded.map(g => `<li><span class="dot" style="background:${STATUS_COLOR[g.status]}"></span>
          <span>${labelOf(g.key, lang)}<br><span class="time">${t('reference')} ${fmt(refOf(g.key).ok[0], g.key)}–${fmt(refOf(g.key).ok[1], g.key)}</span></span>
          <span class="v">${fmt(g.value, g.key)}</span></li>`).join('')
      : `<li>${t('noMetricsHere')}</li>`;

    const open = () => {
      const on = fig.dataset.open === 'false';
      fig.dataset.open = String(on);
      list.hidden = !on;
      toggle.textContent = on ? t('hideAngles') : t('showAngles');
      drawPhase(shot, side, on ? graded.filter(g => ARC[g.key]) : []);
    };
    toggle.addEventListener('click', e => { e.stopPropagation(); open(); });
    fig.addEventListener('click', open);

    fig.append(view, cap, toggle, list);
    wrap.appendChild(fig);
    drawPhase(shot, side, []);
  }
  buildDots(wrap);

  // Att jobba på
  const issues = issueList(prio, lang, 5);
  $('goodnote').textContent = goodNote(prio, lang);
  const ol = $('work');
  ol.innerHTML = '';
  if (!issues.length) {
    const a = allClear(lang);
    ol.innerHTML = `<div class="allclear"><h3>${a.title}</h3><p>${a.why}</p><p>${a.drill}</p></div>`;
  } else {
    issues.forEach((it, i) => {
      const li = document.createElement('li');
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'head';
      head.setAttribute('aria-expanded', 'false');
      head.innerHTML = `<span class="rank">${i + 1}</span><span class="label">${it.title}</span><span class="plus" aria-hidden="true"></span>`;
      const body = document.createElement('div');
      body.className = 'body';
      body.hidden = true;
      body.innerHTML = `<p>${it.why}</p>
        <p class="drill"><strong>${t('drill')}:</strong> ${it.drill}</p>
        <p class="pep">${it.pep}</p>`;
      head.addEventListener('click', () => {
        const on = head.getAttribute('aria-expanded') === 'false';
        head.setAttribute('aria-expanded', String(on));
        body.hidden = !on;
      });
      li.append(head, body);
      ol.appendChild(li);
    });
  }

  // Alla mätvärden
  $('metrics').innerHTML = prio.graded.map(g => `<li>
    <span class="dot ${g.status}"></span>
    <span>${labelOf(g.key, lang)}<br><span class="ref">${t('reference')} ${fmt(refOf(g.key).ok[0], g.key)}–${fmt(refOf(g.key).ok[1], g.key)}</span></span>
    <span class="val">${fmt(g.value, g.key)}</span></li>`).join('');

  // Förbehåll
  const lag = m.takeoffLag == null ? t('lagUnknown')
    : m.takeoffLag < 0 ? t('lagBefore')(Math.abs(m.takeoffLag).toFixed(2))
    : t('lagAfter')(m.takeoffLag.toFixed(2));
  const extra = t('extra')(m.hipVel.toFixed(0), lag, ph.fps.toFixed(0));
  $('caveat').textContent = t('caveat')(t(side === 'right' ? 'sideRight' : 'sideLeft'), extra);
}

function buildDots(wrap) {
  const dots = $('dots');
  dots.innerHTML = '';
  const figs = [...wrap.children];
  figs.forEach((fig, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `${i + 1}`);
    b.setAttribute('aria-current', String(i === 0));
    b.addEventListener('click', () => fig.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }));
    dots.appendChild(b);
  });
  wrap.addEventListener('scroll', () => {
    const mid = wrap.scrollLeft + wrap.clientWidth / 2;
    let near = 0, best = Infinity;
    figs.forEach((f, i) => {
      const d = Math.abs(f.offsetLeft + f.offsetWidth / 2 - mid);
      if (d < best) { best = d; near = i; }
    });
    [...dots.children].forEach((d, i) => d.setAttribute('aria-current', String(i === near)));
  }, { passive: true });
}

setLang(getLang());
refresh();
