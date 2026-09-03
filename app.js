// app.js – laddar klippet, kör MediaPipe Pose i webbläsaren, ritar resultatet.
// Videon lämnar aldrig telefonen. Bara siffror skulle behöva skickas till en Worker senare.
import { FilesetResolver, PoseLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
import { L, pickSide, signals, findPhases, metrics } from './analysis.js';
import { band, prioritize, feedback, secondary } from './rules.js';

const $ = id => document.getElementById(id);
const video = $('video'), file = $('file'), run = $('run'), status = $('status');
const prog = $('progress'), bar = prog.querySelector('i');

let landmarker = null;
let fileUrl = null;

const SAMPLE_FPS = 15;   // rutor/sekund som analyseras. 15 räcker för faserna, 30 ger bättre tempo.
const MAX_SECONDS = 8;

file.addEventListener('change', () => {
  const f = file.files[0];
  if (!f) return;
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = URL.createObjectURL(f);
  video.src = fileUrl;
  video.style.display = 'block';
  $('result').hidden = true;
  run.disabled = false;
  status.textContent = '';
});

run.addEventListener('click', async () => {
  run.disabled = true;
  try {
    await analyze();
  } catch (e) {
    status.innerHTML = `<div class="error">${e.message}</div>`;
  } finally {
    run.disabled = false;
    prog.style.display = 'none';
  }
});

async function loadModel() {
  if (landmarker) return landmarker;
  status.textContent = 'Laddar modell (första gången tar några sekunder)…';
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

function seek(t) {
  return new Promise(res => { video.onseeked = () => res(); video.currentTime = t; });
}

async function analyze() {
  await loadModel();
  await new Promise(res => (video.readyState >= 1 ? res() : (video.onloadedmetadata = res)));
  const dur = Math.min(video.duration, MAX_SECONDS);
  const aspect = video.videoWidth / video.videoHeight;
  const step = 1 / SAMPLE_FPS;
  const frames = [];
  const thumbs = []; // sparar bildrutor för remsan
  const thumbCanvas = document.createElement('canvas');
  const scale = 360 / video.videoHeight;
  thumbCanvas.width = Math.round(video.videoWidth * scale);
  thumbCanvas.height = 360;
  const tctx = thumbCanvas.getContext('2d');

  prog.style.display = 'block';
  status.textContent = 'Analyserar rörelsen…';
  let ts = 0;
  for (let t = 0; t <= dur; t += step) {
    await seek(t);
    ts += Math.round(step * 1000) + 1; // måste vara strikt ökande
    const res = landmarker.detectForVideo(video, ts);
    if (res.landmarks && res.landmarks[0]) {
      frames.push({ t, lm: res.landmarks[0] });
      tctx.drawImage(video, 0, 0, thumbCanvas.width, thumbCanvas.height);
      thumbs.push({ t, img: tctx.getImageData(0, 0, thumbCanvas.width, thumbCanvas.height) });
    }
    bar.style.width = `${(t / dur) * 100}%`;
  }
  if (frames.length < 10) throw new Error('Hittade ingen person i klippet. Kontrollera att hela kroppen syns och att klippet är från sidan.');

  const side = pickSide(frames, $('hand').value);
  const sig = signals(frames, side, aspect);
  const ph = findPhases(sig);
  const m = metrics(sig, ph);
  const b = band(Number($('age').value) || 14);
  const prio = prioritize(m, b);

  drawStrip(thumbs, frames, ph, side, thumbCanvas.width, thumbCanvas.height);
  renderFocus(feedback(prio, b));
  renderMetrics(prio, b);
  renderMore(secondary(prio), m, ph);
  $('caveat').textContent = `Sidovy, 2D-poseskattning, ${side === 'right' ? 'höger' : 'vänster'} sida. Vinklar ±5°. Fotställning i bredd syns inte från den här vinkeln.`;
  $('result').hidden = false;
  status.textContent = '';
  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function drawStrip(thumbs, frames, ph, side, w, h) {
  const phases = [
    ['Lägst', ph.lowest], ['Set point', ph.set], ['Släpp', ph.release], ['Följning', ph.follow],
  ];
  const c = $('strip');
  c.width = w * 4; c.height = h + 44;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#10262E'; ctx.fillRect(0, 0, c.width, c.height);
  const S = side === 'right'
    ? [[L.rSho, L.rElb], [L.rElb, L.rWri], [L.rSho, L.rHip], [L.rHip, L.rKnee], [L.rKnee, L.rAnk]]
    : [[L.lSho, L.lElb], [L.lElb, L.lWri], [L.lSho, L.lHip], [L.lHip, L.lKnee], [L.lKnee, L.lAnk]];
  phases.forEach(([name, idx], i) => {
    const x0 = i * w;
    ctx.putImageData(thumbs[idx].img, x0, 44);
    const lm = frames[idx].lm;
    ctx.lineWidth = 4; ctx.strokeStyle = '#FFE600'; ctx.lineCap = 'round';
    for (const [a, b] of S) {
      ctx.beginPath();
      ctx.moveTo(x0 + lm[a].x * w, 44 + lm[a].y * h);
      ctx.lineTo(x0 + lm[b].x * w, 44 + lm[b].y * h);
      ctx.stroke();
    }
    ctx.fillStyle = '#fff'; ctx.font = '600 22px "Barlow Condensed", Barlow, sans-serif';
    ctx.fillText(name, x0 + 10, 28);
    ctx.fillStyle = '#FFB48E'; ctx.font = '400 14px Barlow, sans-serif';
    ctx.fillText(`${frames[idx].t.toFixed(2)} s`, x0 + w - 60, 28);
  });
  c.style.display = 'block';
}

function renderFocus(f) {
  $('focus').innerHTML = `
    <div class="focus">
      <div class="kicker">${f.kicker}</div>
      <h3>${f.title}</h3>
      <p>${f.why}</p>
      <div class="drill"><strong>Övning:</strong> ${f.drill}</div>
    </div>`;
}

function fmt(v, r) {
  if (v == null) return '–';
  const dec = r.dec ?? (r.unit === 's' ? 2 : 0);
  return `${v.toFixed(dec)}${r.unit === '°' || r.unit === 's' ? ' ' + r.unit : ' ' + r.unit}`;
}

function renderMetrics(prio, b) {
  const ul = $('metrics');
  ul.innerHTML = '';
  for (const g of prio.graded) {
    const r = g.ref;
    const li = document.createElement('li');
    const status = b === 'child' ? 'good' : g.status;
    li.innerHTML = `<span class="dot ${status}"></span>
      <span>${r.label}<br><span class="ref">riktvärde ${fmt(r.ok[0], r)}–${fmt(r.ok[1], r)}</span></span>
      <span class="val">${fmt(g.value, r)}</span>`;
    ul.appendChild(li);
  }
}

function renderMore(sec, m, ph) {
  const parts = [];
  if (sec.length) {
    parts.push('<p class="quiet">Tas när fokuspunkten sitter:</p>');
    for (const s of sec) parts.push(`<p><strong>${s.text.title}.</strong> ${s.text.why}</p>`);
  } else {
    parts.push('<p class="quiet">Inga fler avvikelser.</p>');
  }
  parts.push(`<p class="quiet">Höftvinkelhastighet ${m.hipVel.toFixed(0)} °/s (skickliga skyttar ligger högt här).
    Släpp ${m.takeoffLag == null ? 'okänt' : m.takeoffLag < 0 ? `${Math.abs(m.takeoffLag).toFixed(2)} s före` : `${m.takeoffLag.toFixed(2)} s efter`} frånskjutet.
    ${ph.fps.toFixed(0)} analyserade rutor/s.</p>`);
  $('more').innerHTML = parts.join('');
}
