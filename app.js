// app.js – laddar klippet, kör MediaPipe Pose i webbläsaren, ritar resultatet.
// Videon lämnar aldrig telefonen. Bara siffror skulle behöva skickas till en Worker senare.
import { FilesetResolver, PoseLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
import { L, pickSide, signals, findPhases, metrics, estimateSpeed, rescaleTime } from './analysis.js';
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

// Färdiga exempel som kan analyseras utan att man har ett eget klipp. Filerna ligger i
// examples/ och publiceras med sajten. Lägg till Jalen genom att lägga filen där och
// skriva en rad här – ingen annan kod behöver ändras.
//
// Klippen måste vara H.264. iPhone spelar in i HEVC, som Safari klarar men Chrome och
// Firefox ofta inte – ett HEVC-exempel fungerar alltså inte för alla besökare.
const EXAMPLES = [
  { file: 'examples/LeoNormal.mp4', who: 'Leo',
    what: { sv: 'Enstegsskott, normal fart', en: 'One-motion shot, normal speed' } },
];

// Uppspelningshastighet. 'auto' gissar ur hoppet; en siffra betyder att användaren vet.
const SPEEDS = ['auto', 1, 2, 4, 8];
let speedChoice = 'auto';

let landmarker = null;
let fileUrl = null;
let last = null;   // sparat resultat, så språkbyte och ny hastighet kan räkna om utan MediaPipe

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

const speedName = v => (v === 'auto' ? t('speedAuto') : v === 1 ? t('speedNormal') : `${v}×`);

function buildSpeedPicker(el, onPick) {
  el.innerHTML = '';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', t('speedLabel'));
  for (const v of SPEEDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = speedName(v);
    b.setAttribute('aria-pressed', String(v === speedChoice));
    b.addEventListener('click', () => onPick(v));
    el.appendChild(b);
  }
}

// Ritar om allt som har text. Anropas vid start, vid språkbyte och när hastigheten ändras.
function refresh() {
  applyStatic();
  buildLangPicker();
  buildSpeedPicker($('speed-start'), v => { speedChoice = v; refresh(); });
  buildExamples();
  document.title = `Emitto – ${t('tag')}`;
  if (last) renderResult(last);
}

// ---------------------------------------------------------------- analys

const ERRORS = {
  E_FEW_FRAMES: 'errTooFewFrames', E_NO_SHOT: 'errNoShot',
  E_NO_PERSON: 'errNoPerson', E_VIDEO: 'errVideo', E_EXAMPLE: 'errExample',
};

function showError(e) {
  $('error').innerHTML = `<div class="error">${t(ERRORS[e.message] || 'errNoShot')}</div>`;
  show('start');
}

// Gemensam väg in, oavsett om klippet kommer från filväljaren eller ett exempel.
async function startFrom(blob) {
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = URL.createObjectURL(blob);
  video.src = fileUrl;
  last = null;
  $('error').textContent = '';
  bar.style.width = '0%';
  show('loading');
  try {
    await analyze();
  } catch (e) {
    showError(e);
  }
}

file.addEventListener('change', async () => {
  const f = file.files[0];
  if (!f) return;
  file.value = '';   // så att samma fil kan väljas igen
  await startFrom(f);
});

function buildExamples() {
  const box = $('examples');
  box.innerHTML = '';
  for (const ex of EXAMPLES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span class="who">${ex.who}</span><span class="what">${ex.what[getLang()]}</span><span class="go">→</span>`;
    b.addEventListener('click', async () => {
      $('error').textContent = '';
      $('loadmsg').textContent = t('loadingExample');
      bar.style.width = '0%';
      show('loading');
      try {
        const res = await fetch(ex.file);
        if (!res.ok) throw new Error('E_EXAMPLE');
        await startFrom(await res.blob());
      } catch (e) {
        showError(e.message in ERRORS ? e : new Error('E_EXAMPLE'));
      }
    });
    box.appendChild(b);
  }
}

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

// Väntar på klippets metadata. Kan webbläsaren inte avkoda formatet kommer aldrig
// loadedmetadata – då kastar vi i stället för att låta laddningen snurra i evighet.
// iPhone spelar in i HEVC, som Chrome och Firefox ofta saknar stöd för.
function videoReady() {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((res, rej) => {
    const done = () => { clearTimeout(timer); video.onloadedmetadata = null; video.onerror = null; };
    const timer = setTimeout(() => { done(); rej(new Error('E_VIDEO')); }, 30000);
    video.onloadedmetadata = () => { done(); res(); };
    video.onerror = () => { done(); rej(new Error('E_VIDEO')); };
  });
}

async function analyze() {
  await videoReady();
  await loadModel();
  $('loadmsg').textContent = t('loadingAnalyze');

  const aspect = video.videoWidth / video.videoHeight;
  // Är hastigheten vald i förväg vet vi hur mycket klippet är utsträckt och kan läsa
  // lika många sekunder av rörelsen. På Auto vet vi inte, så vi tar de första åtta.
  const span = Math.min(video.duration, MAX_SECONDS * (speedChoice === 'auto' ? 1 : speedChoice));
  const step = 1 / SAMPLE_FPS;
  const frames = [];
  let ts = 0;
  for (let time = 0; time <= span; time += step) {
    await seek(time);
    ts += Math.round(step * 1000) + 1; // måste vara strikt ökande
    const res = landmarker.detectForVideo(video, ts);
    if (res.landmarks && res.landmarks[0]) frames.push({ t: time, lm: res.landmarks[0] });
    bar.style.width = `${(time / span) * 90}%`;
  }
  if (frames.length < 10) throw new Error('E_NO_PERSON');

  await compute(frames, pickSide(frames, 'auto'), aspect);
}

// Hastigheten avgörs innan faserna söks. findPhases letar i fönster mätta i sekunder,
// så en utsträckt tidsaxel skulle inte bara ge fel siffror utan fel faser.
function resolveSpeed(sig) {
  if (speedChoice !== 'auto') return { factor: speedChoice, source: 'manual' };
  const est = estimateSpeed(sig);
  return est ? { factor: est.factor, source: 'jump', est } : { factor: 1, source: 'assumed' };
}

// Räknar fram allt från redan avlästa ledpunkter. Körs om vid hastighetsbyte – MediaPipe
// behöver inte gå igen, bara de fyra bildrutorna hämtas på nytt.
async function compute(frames, side, aspect) {
  const sig0 = signals(frames, side, aspect);
  const speed = resolveSpeed(sig0);
  const sig = rescaleTime(sig0, speed.factor);
  const ph = findPhases(sig);
  const m = metrics(sig, ph);

  // Bara de fyra bildrutor som visas sparas. Att spara alla kostade över 100 MB på en telefon.
  $('loadmsg').textContent = t('loadingFrames');
  const shots = [];
  for (const p of PHASES) {
    const idx = ph[p.key];
    await seek(frames[idx].t);   // videons egen tid, inte den omskalade
    const c = document.createElement('canvas');
    c.height = PHASE_H;
    c.width = Math.round(PHASE_H * aspect);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    shots.push({ ...p, canvas: c, lm: frames[idx].lm, time: sig[idx].t });
  }
  bar.style.width = '100%';

  last = { frames, side, aspect, shots, m, ph, speed, prio: prioritize(m) };
  renderResult(last);
  show('result');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function recalculate(choice) {
  if (!last || choice === speedChoice) return;
  speedChoice = choice;
  const { frames, side, aspect } = last;
  $('loadmsg').textContent = t('speedRecalc');
  bar.style.width = '100%';
  show('loading');
  try {
    await compute(frames, side, aspect);
  } catch (e) {
    last = null;
    showError(e);
  }
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
  const { shots, side, m, ph, prio, speed } = data;
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

  // Hastigheten analysen räknar i, och möjligheten att ändra den
  const label = speed.factor === 1 ? t('speedNormalPhrase') : `${speed.factor}×`;
  $('speednote').textContent =
    speed.source === 'manual' ? t('speedManualNote')(label)
    : speed.source === 'jump' ? t('speedFromJump')(label)
    : t('speedAssumed');
  buildSpeedPicker($('speed-result'), recalculate);

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
