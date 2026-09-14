// app.js – laddar klippet, kör MediaPipe Pose i webbläsaren, ritar resultatet.
// Videon lämnar aldrig telefonen. Till Workern går siffrorna och fem beskurna stillbilder ur
// rutor som redan lästs av – aldrig klippet. Se coach.js.
import { FilesetResolver, PoseLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
import { pickSide, signals, findPhases, metrics, estimateSpeed, rescaleTime, postRelease, visibilityByMetric } from './analysis.js';
import { prioritize, issueList, allClear, goodNote, labelOf, refOf, formatValue, formatPlain, METRIC_PHASE } from './rules.js';
import { t, getLang, setLang, applyStatic, LANGS } from './i18n.js';
import { drawFrame, personCrop, STATUS_COLOR, ARC } from './draw.js';
import { shareImage, reportText, deliver, deliverText, stamp } from './share.js';
import { buildPayload, collectFrames, requestCoach, merge } from './coach.js';

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

// Söker till en tid och lämnar tillbaka tiden på den ruta som faktiskt målades upp.
//
// Två saker går fel om man bara väntar på `seeked`: händelsen kan komma innan bilden är
// framme, och en sökning kan landa på en annan ruta än den vi bad om – båda vanliga med
// hårdvaruavkodning på telefon. Symtomet är lömskt: fasbilden visar en pose ett par
// tiondelar från sin egen tidsstämpel, med rätt skelett ritat ovanpå fel bild.
//
// requestVideoFrameCallback löser båda: den utlöses när rutan är uppmålad, och `mediaTime`
// säger vilken ruta det blev. Vi anmäler den före sökningen, och litar aldrig på tiden vi
// bad om – bara på den vi fick. Firefox saknar callbacken; där får vi två animationsrutor
// och får nöja oss med den begärda tiden.
const seekOnce = time => new Promise(res => {
  let done = false;
  const ready = got => { if (done) return; done = true; video.onseeked = null; res(got); };
  if (video.requestVideoFrameCallback) {
    video.requestVideoFrameCallback((now, meta) => ready(meta.mediaTime));
    video.onseeked = () => setTimeout(() => ready(null), 120);   // reserv: ingen ruta målades
  } else {
    video.onseeked = () => requestAnimationFrame(() => requestAnimationFrame(() => ready(null)));
  }
  video.currentTime = time;
});

// Landade vi fel går vi tillbaka en bit och söker fram igen: andra steget blir en kort
// sökning framåt, som webbläsaren avkodar ruta för ruta. Ger vi upp lämnar vi tillbaka
// tiden vi faktiskt fick, aldrig den vi bad om – då stämmer i alla fall bild och siffra.
const HALF_FRAME = 1 / 60;

async function seek(time) {
  let got = await seekOnce(time);
  for (let i = 0; got != null && Math.abs(got - time) > HALF_FRAME && i < 2; i++) {
    await seekOnce(Math.max(0, time - 0.4 - i * 0.4));
    got = await seekOnce(time);
  }
  return got == null ? time : got;
}

// Sparad ruta → något drawImage kan rita. createImageBitmap finns i alla webbläsare vi
// bryr oss om; <img> är reserv och släpper sin URL när bilden är läst.
const decode = blob => (window.createImageBitmap
  ? createImageBitmap(blob)
  : new Promise((res, rej) => {
      const url = URL.createObjectURL(blob), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('E_VIDEO')); };
      img.src = url;
    }));

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

  // Bilden till fasrutorna sparas här, i samma ögonblick som MediaPipe läser videon –
  // inte genom att söka tillbaka efteråt. Det är hela poängen: två sökningar till samma
  // tid behöver inte ge samma ruta på en telefon, och då hamnar rätt skelett på fel bild.
  // Nu kommer ledpunkter och bild ur samma avläsning och kan inte glida isär.
  // En ruta i kortstorlek blir ~35 kB som JPEG: ~4 MB för ett klipp på åtta sekunder.
  const grab = document.createElement('canvas');
  grab.height = PHASE_H;
  grab.width = Math.round(PHASE_H * aspect);
  const gctx = grab.getContext('2d');

  const frames = [];
  let ts = 0;
  for (let time = 0; time <= span; time += step) {
    const at = await seek(time);   // rutans egen tid, inte den vi bad om
    ts += Math.round(step * 1000) + 1; // måste vara strikt ökande
    const res = landmarker.detectForVideo(video, ts);
    if (res.landmarks && res.landmarks[0]) {
      gctx.drawImage(video, 0, 0, grab.width, grab.height);
      const shot = await new Promise(done => grab.toBlob(done, 'image/jpeg', 0.7));
      frames.push({ t: at, lm: res.landmarks[0], shot });
    }
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

// Räknar fram allt från redan avlästa ledpunkter och redan tagna bilder. Körs om vid
// hastighetsbyte – varken MediaPipe eller videon behöver gå igen.
async function compute(frames, side, aspect) {
  const sig0 = signals(frames, side, aspect);
  const speed = resolveSpeed(sig0);
  const sig = rescaleTime(sig0, speed.factor);
  $('loadmsg').textContent = t('loadingMeasure');
  const ph = findPhases(sig);
  const m = metrics(sig, ph);

  // Måtten efter släppet. De har inga riktvärden och går inte in i prioriteringen – de är
  // underlag för djupanalysen, som får bedöma dem inom en ram i worker/prompt.js.
  const pr = postRelease(sig, ph);
  bar.style.width = '80%';

  // Fasernas bilder är redan tagna, ur samma avläsning som ledpunkterna. Här ritas de
  // bara upp – videon rörs inte längre, så ett hastighetsbyte kostar ingen sökning alls.
  $('loadmsg').textContent = t('loadingFrames');
  const shotAt = async (idx, p) => {
    const c = document.createElement('canvas');
    c.height = PHASE_H;
    c.width = Math.round(PHASE_H * aspect);
    c.getContext('2d').drawImage(await decode(frames[idx].shot), 0, 0, c.width, c.height);
    return { ...p, canvas: c, lm: frames[idx].lm, time: sig[idx].t };
  };
  const shots = [];
  for (const p of PHASES) shots.push(await shotAt(ph[p.key], p));
  // Landningen visas inte i fasremsan – den hör inte till de fyra faserna – men den får följa
  // med som bild när användaren valt att skicka rutor.
  const landingShot = pr.landing >= 0 ? await shotAt(pr.landing, { key: 'landing' }) : null;
  bar.style.width = '90%';

  const times = {};
  for (const k of ['lowest', 'set', 'release', 'takeoff', 'apex', 'follow']) {
    times[k] = ph[k] >= 0 ? sig[ph[k]].t : null;
  }

  const data = { frames, side, aspect, shots, landingShot, m, ph, speed, prio: prioritize(m),
    times, pr, vis: visibilityByMetric(frames, ph, side), coach: null };

  // Djupanalysen hör till resultatet, inte till något man väntar på efteråt. Den som filmat
  // ska få se allt på en gång, och tills dess vet hen vad appen håller på med.
  $('loadmsg').textContent = t('loadingCoach');
  data.coach = await askCoach(data, getLang());
  bar.style.width = '100%';

  last = data;
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

// Ritar en fas i sin egen canvas i kortet. Själva ritandet ligger i draw.js, eftersom
// delningsbilden ritar samma fas med samma kod.
//
// Utsnittet följer spelaren, precis som i delningsbilden. Hela bildrutan såg riktig ut på
// ett närbildsklipp men inte på ett filmat från läktaren: är spelaren en sjättedel av
// bildhöjden blir överarmen ~14 px i den sparade rutan, och då är både skelettet och
// siffran ritade för kortet i stället för för kroppen – bågen hamnar utanför armen och
// etiketten svävar en halv spelarhöjd bort. Med utsnittet fyller kroppen kortet och allt
// som skalas mot dest.w blir proportionerligt av sig självt. Att appen och det tränaren
// får skickat visar samma utsnitt är dessutom hela poängen med att draw.js är gemensam.
const CARD_ASPECT = 3 / 4;   // bredd/höjd, samma ruta som delningsbildens fasrutor

function drawPhase(shot, side, arcs) {
  const src = shot.canvas, c = shot.view;
  c.height = src.height;
  c.width = Math.round(src.height * CARD_ASPECT);
  const crop = personCrop(shot.lm, src.width / src.height, CARD_ASPECT);
  drawFrame(c.getContext('2d'), src, { x: 0, y: 0, w: c.width, h: c.height }, shot.lm, side, arcs, crop);
}

// ---------------------------------------------------------------- resultat

const fmt = (value, key) => formatValue(key, value, getLang());

function renderResult(data) {
  const lang = getLang();
  // Listan är rules.js ordning med modellens ord ovanpå där nyckeln stämmer. Den räknas fram
  // en gång och används av både svarsrutan och listan, så de aldrig kan säga olika saker.
  const issues = merge(issueList(data.prio, lang, 5), coachOf(data));

  renderVerdict(data, issues, lang);
  renderPhases(data, lang);
  renderWork(data, issues, lang);
  renderAbout(data, lang);
  renderExtras(data);
  prepareShare(data);
  recoachOnLanguageChange(data);
}

// Svaret först: rubriken på det som ligger överst i listan, och sammanfattningen när
// djupanalysen skrivit en. Utan modellen står bara rubriken – posten själv säger vad man
// ska göra en rad längre ner, och att skriva samma mening två gånger gör den inte sannare.
//
// Prickarna är mätvärdenas status i listans ordning. Det är där "säg vad som är bra först"
// tar vägen: som färg och siffra i stället för som en mening ovanför listan.
function renderVerdict(data, issues, lang) {
  const res = coachOf(data);
  const clear = allClear(lang);
  const head = issues.length
    ? { kicker: t('verdictFocus'), title: issues[0].title, lead: res?.summary || '' }
    : { kicker: t('verdictClear'), title: clear.title, lead: res?.summary || clear.why };
  const pips = data.prio.graded.map(g => `<i style="background:${STATUS_COLOR[g.status]}"></i>`).join('');
  $('verdict').innerHTML = `<span class="kicker">${esc(head.kicker)}</span>
    <h3>${esc(head.title)}</h3>
    ${head.lead ? `<p>${esc(head.lead)}</p>` : ''}
    <div class="tally"><span class="pips">${pips}</span><span>${esc(goodNote(data.prio, lang))}</span></div>`;
}

// Faserna. Vinklarna ritas direkt och står under bilden – knappen som skulle tryckas först
// var ett steg mellan användaren och det hon kom för. Riktvärdena står i fotnoten i stället,
// en gång, med en skala som visar var värdet ligger.
function renderPhases(data, lang) {
  const { shots, side, prio } = data;
  const byPhase = {};
  for (const g of prio.graded) (byPhase[METRIC_PHASE[g.key]] ||= []).push(g);

  const wrap = $('phases');
  wrap.innerHTML = '';
  for (const shot of shots) {
    const fig = document.createElement('figure');
    fig.className = 'phase';
    const view = document.createElement('canvas');
    shot.view = view;
    const cap = document.createElement('figcaption');
    cap.innerHTML = `<span class="name">${esc(t(shot.label))}</span><span class="time">${shot.time.toFixed(2)} s</span>`;
    const graded = byPhase[shot.key] || [];
    const list = document.createElement('ul');
    list.className = 'angles';
    list.innerHTML = graded.length
      ? graded.map(g => `<li><span class="dot" style="background:${STATUS_COLOR[g.status]}"></span>
          <span>${esc(labelOf(g.key, lang))}</span><span class="v">${fmt(g.value, g.key)}</span></li>`).join('')
      : `<li>${esc(t('noMetricsHere'))}</li>`;

    fig.append(view, cap, list);
    wrap.appendChild(fig);
    drawPhase(shot, side, graded.filter(g => ARC[g.key]));
  }
  buildDots(wrap);
}

// Att jobba på. Ordningen kommer alltid från rules.js. Varje post visar vad man ska göra
// redan hopfälld – en rubrik ensam säger sällan det – och den första står öppen, så att
// listan svarar innan man har tryckt på något.
function renderWork(data, issues, lang) {
  const ol = $('work'), box = $('allclear');
  ol.innerHTML = '';
  box.innerHTML = '';
  if (!issues.length) {
    const a = allClear(lang), res = coachOf(data);
    // Rubriken står redan i svarsrutan, och `why` bara om den inte användes där.
    box.className = 'allclear';
    box.innerHTML = `${res?.summary ? `<p>${esc(a.why)}</p>` : ''}
      <p class="drill"><strong>${esc(t('drill'))}:</strong> ${esc(a.drill)}</p>`;
    return;
  }
  issues.forEach((it, i) => {
    const li = document.createElement('li');
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'head';
    head.setAttribute('aria-expanded', String(i === 0));
    head.innerHTML = `<span class="rank">${i + 1}</span>
      <span class="label">${esc(it.title)}${it.what ? `<span class="sub">${esc(it.what)}</span>` : ''}</span>
      <span class="plus" aria-hidden="true"></span>`;
    const body = document.createElement('div');
    body.className = 'body';
    body.hidden = i !== 0;
    // Peppningen följer med i den delade texten, men inte hit: på skärmen blev den en fjärde
    // rad som ingen läste, och listan ska gå att skumma.
    body.innerHTML = `<p>${esc(it.why)}</p>
      <p class="drill"><strong>${esc(t('drill'))}:</strong> ${esc(it.drill)}</p>`;
    head.addEventListener('click', () => {
      const on = head.getAttribute('aria-expanded') === 'false';
      head.setAttribute('aria-expanded', String(on));
      body.hidden = !on;
    });
    li.append(head, body);
    ol.appendChild(li);
  });
}

// Om mätningen: hastigheten, mätvärdena, hur säkert de är mätta och förbehållet. Allt som är
// om mätningen och inte om skottet, på ett ställe i stället för fyra.
function renderAbout(data, lang) {
  $('speednote').textContent = speedNote(data);
  buildSpeedPicker($('speed-result'), recalculate);
  $('metrics').innerHTML = data.prio.graded.map(g => `<li>
    <span class="dot ${g.status}"></span>
    <span>${esc(labelOf(g.key, lang))}${scaleBar(g)}</span>
    <span class="val">${fmt(g.value, g.key)}</span></li>`).join('');
  $('uncertainty').textContent = coachOf(data)?.uncertainties?.join(' ') || '';
  $('caveat').textContent = caveatNote(data);
}

// Riktvärdet som en sträcka och värdet som ett streck på den. Skalan går två toleranser
// utanför riktvärdet åt varje håll: då hamnar även ett värde långt utanför kvar på sträckan,
// vid kanten, i stället för utanför rutan.
function scaleBar(g) {
  const r = refOf(g.key);
  const lo = r.ok[0] - 2 * r.tol, hi = r.ok[1] + 2 * r.tol;
  const at = x => Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100)).toFixed(1);
  return `<div class="scale">
    <i class="band" style="left:${at(r.ok[0])}%;right:${(100 - at(r.ok[1])).toFixed(1)}%"></i>
    <i class="pin" style="left:${at(g.value)}%;background:${STATUS_COLOR[g.status]}"></i>
    <span class="cap" style="left:0">${formatPlain(g.key, r.ok[0])}</span>
    <span class="cap" style="left:${at(r.ok[1])}%">${formatPlain(g.key, r.ok[1])}</span></div>`;
}

// De två meningarna som sammanfattar hur resultatet ska läsas. Egna funktioner därför att
// de ska stå ordagrant likadant i appen, i delningsbilden och i den sparade sidan.
function speedNote({ speed }) {
  const label = speed.factor === 1 ? t('speedNormalPhrase') : `${speed.factor}×`;
  return speed.source === 'manual' ? t('speedManualNote')(label)
    : speed.source === 'jump' ? t('speedFromJump')(label)
    : t('speedAssumed');
}

function caveatNote(data) {
  const { m, ph, side } = data;
  const lag = m.takeoffLag == null ? t('lagUnknown')
    : m.takeoffLag < 0 ? t('lagBefore')(Math.abs(m.takeoffLag).toFixed(2))
    : t('lagAfter')(m.takeoffLag.toFixed(2));
  const extra = t('extra')(m.hipVel.toFixed(0), lag, ph.fps.toFixed(0));
  const base = t('caveat')(t(side === 'right' ? 'sideRight' : 'sideLeft'), extra);
  // Ingen märkning rad för rad, men det ska gå att veta hur texten kommit till.
  return coachOf(data) ? `${base} ${t('writtenBy')}` : base;
}

// ---------------------------------------------------------------- djupanalysen
//
// Den mätta delen och den skrivna delen hör ihop och visas tillsammans: anropet till workern
// görs medan laddningsvyn står kvar, och resultatet ritas först när allt är på plats. Det som
// står i listan är samma sak oavsett var orden kommer ifrån – riktvärdena bestämmer ordningen
// och bedömningen, texten formuleras av en språkmodell utifrån dem. Därför märks den inte ut
// rad för rad; att den är skriven så står i förbehållet under resultatet.
//
// Går anropet inte igenom står rules.js egna texter kvar. Det syns inte som ett fel, för det är
// inget fel: listan, siffrorna och prioriteringen är desamma.

const chosenAge = () => {
  const v = parseInt($('age').value, 10);
  return Number.isFinite(v) && v >= 5 && v <= 99 ? v : null;
};

// Landningen följer med som bild när den hittades, utöver de fyra faserna.
const framesFor = data => (data.landingShot ? [...data.shots, data.landingShot] : data.shots);

// Kastar aldrig: ett uteblivet svar är ett tomt svar, inget att visa upp.
async function askCoach(data, lang) {
  try {
    const jpegs = collectFrames(framesFor(data), data.aspect);
    const res = await requestCoach(buildPayload({ lang, age: chosenAge(), data, frames: jpegs }));
    return { ...res, lang };
  } catch {
    return null;
  }
}

// Texten hör till sitt språk. Byter användaren språk efter analysen hämtas den om i bakgrunden;
// under tiden står rules.js texter där, på rätt språk.
const coachOf = data => (data.coach && data.coach.lang === getLang() ? data.coach : null);

async function recoachOnLanguageChange(data) {
  const lang = getLang();
  if (!data.coach || data.coach.lang === lang || data.coaching === lang) return;
  data.coaching = lang;
  const res = await askCoach(data, lang);
  data.coaching = null;
  if (res && last === data && getLang() === lang) {
    data.coach = res;
    renderResult(data);
  }
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Det som inte är en rad i listan: rutan om det som händer efter släppet, och invändningen.
//
// Observationerna ur bilderna hör ihop med den rutan – båda handlar om det rules.js inte mäter –
// så de står där i stället för under en egen rubrik. Osäkerheten hör till mätningen och ligger i
// fotnoten (renderAbout). Modellens strengths visas inte: prickarna och sammanfattningen säger
// redan vad som är bra, och tre varianter av samma sak i rad var en av de saker som gjorde
// resultatet långt.
function renderExtras(data) {
  const res = coachOf(data);
  const box = $('after');
  const seen = res?.observations?.length ? res.observations.join(' ') : '';

  if (res?.after) {
    box.hidden = false;
    box.innerHTML = `<h3>${esc(t('afterTitle'))}</h3>
      <p><strong>${esc(res.after.title)}</strong></p>
      <p>${esc(seen ? `${res.after.text} ${seen}` : res.after.text)}</p>`;
  } else if (seen) {
    box.hidden = false;
    box.innerHTML = `<h3>${esc(t('observationsTitle'))}</h3><p>${esc(seen)}</p>`;
  } else {
    box.hidden = true;
    box.innerHTML = '';
  }

  $('disagreement').textContent = res?.disagreement ? `${t('disagreementTitle')}: ${res.disagreement}` : '';
}

// ---------------------------------------------------------------- dela
//
// Bilden görs i förväg, så snart resultatet ritats. Safari kräver att navigator.share
// anropas i samma klick som användaren gjorde, och en bild som ritas först efter klicket
// hinner bryta den kedjan – då skulle delningsrutan aldrig öppnas. Är bilden redan klar
// när knappen trycks blir delningen bara ett anrop.
let card = null;   // { lang, blob } – språkbytet ritar om resultatet och gör om bilden

function prepareShare(data) {
  card = null;
  const lang = getLang();
  const soon = window.requestIdleCallback || (fn => setTimeout(fn, 200));
  soon(() => {
    if (last !== data || getLang() !== lang) return;   // nytt klipp eller nytt språk hann före
    const job = shareImage(data, notesFor(data))
      .then(blob => { if (last === data && getLang() === lang) card = { lang, blob }; return blob; })
      .catch(() => null);
    card = { lang, job };
  });
}

async function withButton(btn, working, run) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = working;
  $('sharenote').textContent = '';   // raden hör till den här delningen, inte förra
  try {
    await run();
  } catch {
    $('sharenote').textContent = t('shareFailed');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

const notesFor = data => ({ speed: speedNote(data), caveat: caveatNote(data) });

// Raden under knapparna säger bara något när det behövs: blev det delningsrutan syns den
// redan, blev det en nedladdning eller urklipp måste användaren få veta var filen tog vägen.
$('share-image').addEventListener('click', e => withButton(e.currentTarget, t('shareWorking'), async () => {
  const ready = card && card.lang === getLang() ? (card.blob || await card.job) : null;
  const blob = ready || await shareImage(last, notesFor(last));
  const how = await deliver(blob, stamp('jpg'), `Emitto – ${t('tag')}`);
  $('sharenote').textContent = how === 'downloaded' ? t('shareImageSaved') : '';
}));

// Texten kan inte förberedas i förväg av samma skäl som bilden måste det: den är klar direkt.
$('share-text').addEventListener('click', e => withButton(e.currentTarget, t('shareWorking'), async () => {
  const how = await deliverText(reportText(last, notesFor(last)), stamp('txt'), `Emitto – ${t('tag')}`);
  // Blev det urklipp eller nedladdning i stället för delningsrutan ska användaren få veta var
  // texten tog vägen – annars ser det ut som att knappen inte gjorde något.
  $('sharenote').textContent = how === 'copied' ? t('shareCopied')
    : how === 'downloaded' ? t('shareDownloaded')
    : '';
}));

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
