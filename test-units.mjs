// test-units.mjs – kontroller som inte behöver testklipp.
// Kör: node test-units.mjs
//
// Facittestet mot samples/*_lm.json (Leo och Jalen) är ett annat test och kräver
// klippen. Det här körs var som helst och täcker det som går att räkna på syntetiska
// data: hastighetsgissningen, prioriteringsordningen och att språken har samma nycklar.

import { readFileSync } from 'node:fs';
import { L, signals, findPhases, metrics, pickSide, estimateSpeed, postRelease, visibilityByMetric } from './analysis.js';
import { prioritize, issueList, formatValue, metricSpec, METRIC_KEYS } from './rules.js';
import { personCrop, drawFrame, ARC, FULL } from './draw.js';
import { buildPayload, merge, requestCoach } from './coach.js';
import { checkShape, validate } from './worker/index.js';

let fail = 0;
const ok = (name, cond, note = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'OK  ' : 'FEL '} ${name}${note ? ' – ' + note : ''}`);
};

// ---------------------------------------------------------------- hastighet
const ANKLE_BASE = 0.90, NOSE_BASE = 0.25;
const bodyPx = (ANKLE_BASE - NOSE_BASE) / 0.87;
const G = 9.81, BODY_M = 1.70;   // testpersonen är 1,70; analysis.js antar 1,65

// Stående, hopp, landning. t är uppspelningstid, höjden följer verklig tid.
// factor = hur mycket klippet är utsträckt. toeOnlyM ger en tåhävning i stället för hopp.
function clip({ factor, jumpM = 0.35, sampleFps = 15, noise = 0, toeOnlyM = 0 }) {
  const v0 = Math.sqrt(2 * G * jumpM) / BODY_M;
  const a = G / BODY_M;
  const flight = 2 * v0 / a;
  const sig = [];
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5);
  for (let vt = 0; vt <= (1.2 + flight) * factor; vt += 1 / sampleFps) {
    const rt = vt / factor;
    let h = 0;
    if (toeOnlyM) h = rt > 0.9 && rt < 0.9 + flight ? toeOnlyM / BODY_M : 0;
    else if (rt > 0.9 && rt < 0.9 + flight) { const s = rt - 0.9; h = v0 * s - 0.5 * a * s * s; }
    sig.push({ t: vt, ankleY: ANKLE_BASE - h * bodyPx + noise * rnd(), noseY: NOSE_BASE + noise * rnd() });
  }
  return sig;
}
const factorOf = o => (estimateSpeed(clip(o)) || {}).factor ?? null;

for (const factor of [1, 2, 4, 8]) {
  ok(`hopp 35 cm i ${factor}× känns igen`, factorOf({ factor }) === factor);
}
ok('litet hopp 18 cm i 4×', factorOf({ factor: 4, jumpM: 0.18 }) === 4);
ok('hopp med brus i 4×', factorOf({ factor: 4, noise: 0.004 }) === 4);
// Utan hopp finns ingen parabel. Då ska vi säga null, inte gissa – ett straffkast
// ska inte bedömas som slow motion för att spelaren står kvar på golvet.
ok('straffkast ger inget svar', factorOf({ factor: 1, jumpM: 0 }) === null);
ok('tåhävning ger inget svar', factorOf({ factor: 1, toeOnlyM: 0.07 }) === null);
// Den farliga falska positiven: en mjuk tåhävning är också ungefär parabolisk men
// långsammare än fritt fall, och skulle utan höjdkravet läsas som slow motion.
ok('mjuk tåhävning ger inget svar', factorOf({ factor: 1, jumpM: 0.008 }) === null);

// ---------------------------------------------------------------- fasdetektering
//
// Syntetisk streckgubbe i stället för klipp. Rörelsen byggs av nyckelposer som
// interpoleras till 15 rutor per sekund, precis som app.js läser av klippet. Måtten är
// i bildhöjder: bål (axel→höft) 0,23, arm ungefär lika lång, golvet vid 0,90.
//
// Det viktiga fallet är klippet som börjar med att spelaren tar emot bollen. Att ta emot
// och sänka bollen sträcker armen lika mycket som skottet gör – men framåt och nedåt.
// Väljer man bara det största utslaget i armsträckningen låser analysen fast på fångsten
// och visar fyra faser ur en sekund som inte är skottet.

const ASPECT = 9 / 16;                 // stående telefonvideo
const AX = dx => 0.5 + dx / ASPECT;    // vågrätt mått i samma enhet som y

// sink = hela kroppen sjunker (dipp), air = fötterna lämnar golvet,
// knee = knät framåt, w/e = handled och armbåge räknat från axeln.
const POSE = (t, sink, air, knee, wx, wy, ex, ey) => ({ t, sink, air, knee, wx, wy, ex, ey });

function landmarks(s) {
  const shoY = 0.32 + s.sink - s.air;
  const pt = (dx, y) => ({ x: AX(dx), y, z: 0, visibility: 1 });
  const lm = Array.from({ length: 33 }, () => pt(0, 0.5));
  lm[L.nose] = pt(0, shoY - 0.07);
  lm[L.rSho] = pt(0, shoY);
  lm[L.lSho] = pt(0, shoY);
  lm[L.rElb] = pt(s.ex, shoY + s.ey);
  lm[L.rWri] = pt(s.wx, shoY + s.wy);
  lm[L.lElb] = pt(s.ex - 0.02, shoY + s.ey + 0.015);   // andra armen når aldrig lika högt
  lm[L.lWri] = pt(s.wx - 0.02, shoY + s.wy + 0.015);
  for (const [hip, knee, ank] of [[L.rHip, L.rKnee, L.rAnk], [L.lHip, L.lKnee, L.lAnk]]) {
    lm[hip] = pt(0, 0.55 + s.sink - s.air);
    lm[knee] = pt(s.knee, 0.72 + 0.35 * s.sink - s.air);
    lm[ank] = pt(0, 0.90 - s.air);
  }
  return lm;
}

// Nyckelposer → rutor. Linjär interpolation, 15 rutor/s.
function clipFrames(keys, fps = 15) {
  const frames = [];
  const end = keys[keys.length - 1].t;
  for (let t = 0; t <= end + 1e-9; t += 1 / fps) {
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
    const a = keys[i], b = keys[i + 1];
    const u = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    const at = k => a[k] + (b[k] - a[k]) * u;
    frames.push({ t, lm: landmarks({ sink: at('sink'), air: at('air'), knee: at('knee'),
      wx: at('wx'), wy: at('wy'), ex: at('ex'), ey: at('ey') }) });
  }
  return frames;
}

// Skottet: stå med bollen vid midjan, dippa, set point vid ansiktet, sträck upp, landa.
const shot = t0 => [
  POSE(t0 + 0.00, 0.00, 0.000, 0.00, 0.10, 0.20, 0.06, 0.11),
  POSE(t0 + 0.45, 0.13, 0.000, 0.07, 0.10, 0.06, 0.05, 0.11),   // lägsta läge
  POSE(t0 + 0.75, 0.05, 0.000, 0.03, 0.08, -0.05, 0.05, 0.07),  // set point
  POSE(t0 + 1.05, 0.00, 0.015, 0.00, 0.10, -0.19, 0.06, -0.08), // släpp
  POSE(t0 + 1.25, 0.00, 0.100, 0.00, 0.12, -0.23, 0.07, -0.11), // apex
  POSE(t0 + 1.60, 0.05, 0.000, 0.03, 0.13, -0.18, 0.07, -0.09), // landning
  POSE(t0 + 2.00, 0.00, 0.000, 0.00, 0.10, 0.10, 0.06, 0.09),
];

// Samma skott, men klippet börjar med att spelaren tar emot bollen och sänker den.
const catchThenShot = [
  POSE(0.00, 0.00, 0.00, 0.00, 0.02, 0.22, 0.02, 0.11),   // armarna längs sidorna
  POSE(0.50, 0.00, 0.00, 0.00, 0.06, 0.02, 0.10, 0.10),   // händerna ihop vid bröstet
  POSE(0.90, 0.00, 0.00, 0.00, 0.14, 0.20, 0.09, 0.10),   // bollen ned till midjan
  ...shot(1.00),
];

const phasesOf = keys => {
  const frames = clipFrames(keys);
  const side = pickSide(frames, 'auto');
  const sig = signals(frames, side, ASPECT);
  const ph = findPhases(sig);
  return { frames, side, sig, ph, m: metrics(sig, ph), at: k => sig[ph[k]].t };
};

const near = (a, b, tol) => Math.abs(a - b) <= tol;

const plain = phasesOf(shot(0));
ok('rakt skott: lägsta läge vid dippen', near(plain.at('lowest'), 0.45, 0.12), `${plain.at('lowest').toFixed(2)} s`);
ok('rakt skott: set point före släppet', near(plain.at('set'), 0.75, 0.15), `${plain.at('set').toFixed(2)} s`);
ok('rakt skott: släpp i sträckningen', near(plain.at('release'), 1.05, 0.15), `${plain.at('release').toFixed(2)} s`);
ok('rakt skott: tiden lägsta→släpp', near(plain.m.tLowToRelease, 0.6, 0.15), `${plain.m.tLowToRelease.toFixed(2)} s`);
ok('rakt skott: faserna kommer i ordning', plain.ph.set <= plain.ph.release && plain.ph.lowest < plain.ph.release);

// Buggen från klippet där spelaren först tar emot bollen: fångsten sträcker armen mer
// än skottet gör, så den gamla regeln (största utslaget i ext) valde fel sekund.
const caught = phasesOf(catchThenShot);
ok('fångst först: släppet ligger i skottet, inte i fångsten', near(caught.at('release'), 2.05, 0.15), `${caught.at('release').toFixed(2)} s`);
ok('fångst först: lägsta läge vid dippen', near(caught.at('lowest'), 1.45, 0.15), `${caught.at('lowest').toFixed(2)} s`);
ok('fångst först: set point efter fångsten', caught.at('set') > 1.2 && caught.at('set') < 2.0, `${caught.at('set').toFixed(2)} s`);
ok('fångst först: tiden lägsta→släpp', near(caught.m.tLowToRelease, 0.6, 0.2), `${caught.m.tLowToRelease.toFixed(2)} s`);

// Den gamla regeln, för att visa vad testet skyddar mot: den lägger sträckningen i fångsten.
{
  const frames = clipFrames(catchThenShot);
  const sig = signals(frames, pickSide(frames, 'auto'), ASPECT);
  const win = Math.round(15 * 0.4);
  let burst = 0, best = -Infinity;
  for (let i = 0; i + win < sig.length; i++) {
    const rise = sig[i + win].ext - sig[i].ext;
    if (rise > best) { best = rise; burst = i; }
  }
  ok('gamla regeln föll för fångsten (annars testar vi fel sak)', sig[burst].t < 0.9, `${sig[burst].t.toFixed(2)} s`);
}

// Ingen skottrörelse alls: stå och dribbla. Då ska vi säga att vi inte hittar skottet
// i stället för att peka ut fyra rutor ur en dribbling.
const dribble = [];
for (let i = 0; i <= 8; i++) {
  dribble.push(POSE(i * 0.3, 0, 0, 0, 0.10, 0.10, 0.07, 0.08));
  dribble.push(POSE(i * 0.3 + 0.15, 0, 0, 0, 0.12, 0.26, 0.08, 0.14));
}
let noShot = null;
try { phasesOf(dribble); } catch (e) { noShot = e.message; }
ok('dribbling ger E_NO_SHOT', noShot === 'E_NO_SHOT', noShot || 'inget fel kastades');

// ---------------------------------------------------------------- riktigt klipp
//
// Ledpunkterna i fixtures/ är avlästa ur examples/20260906_130903.mp4 med samma modell
// och samma 15 rutor/s som appen använder, så det här är hela kedjan på riktiga data –
// utan att testet behöver klippet eller MediaPipe. Klippet är just det som visade buggen:
// spelaren tar emot bollen och sänker den innan skottet, och den rörelsen sträcker armen
// mer (ext 0,60 → 0,99) än skottet gör.

function fixture(name) {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
  const frames = f.rutor.map(r => {
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }));
    f.leder.forEach((idx, k) => { lm[idx] = { x: r.lm[k][0], y: r.lm[k][1] }; });
    return { t: r.t, lm };
  });
  const side = pickSide(frames, 'auto');
  const sig = signals(frames, side, f.aspect);
  const ph = findPhases(sig);
  return { frames, side, aspect: f.aspect, sig, ph, m: metrics(sig, ph), at: k => sig[ph[k]].t };
}

// Samma resultatobjekt som app.js lägger i `last`, byggt av fixturen. Det är det coach.js får.
function resultOf(fx, speed = { factor: 1, source: 'jump' }) {
  const times = {};
  for (const k of ['lowest', 'set', 'release', 'takeoff', 'apex', 'follow']) {
    times[k] = fx.ph[k] >= 0 ? fx.sig[fx.ph[k]].t : null;
  }
  return { frames: fx.frames, side: fx.side, aspect: fx.aspect, shots: [], m: fx.m, ph: fx.ph, speed,
    prio: prioritize(fx.m), times, pr: postRelease(fx.sig, fx.ph),
    vis: visibilityByMetric(fx.frames, fx.ph, fx.side) };
}

const real = fixture('catch-then-shot_lm');
// Skottet ligger på 1,3–1,6 s. Allt före 1,2 s är boll som tas emot och sänks.
ok('klipp: släppet ligger i skottet', real.at('release') > 1.2 && real.at('release') < 1.7, `${real.at('release').toFixed(2)} s`);
ok('klipp: handleden är över huvudet vid släppet',
  real.sig[real.ph.release].wristY < real.sig[real.ph.release].noseY);
ok('klipp: lägsta läge i dippen', near(real.at('lowest'), 1.27, 0.15), `${real.at('lowest').toFixed(2)} s`);
ok('klipp: knät är böjt i lägsta läget', real.m.kneeMin < 150, `${real.m.kneeMin.toFixed(0)}°`);
ok('klipp: set point mellan dipp och släpp',
  real.at('set') >= real.at('lowest') && real.at('set') < real.at('release'), `${real.at('set').toFixed(2)} s`);
ok('klipp: armbågen i set point är rimlig', real.m.elbowSet > 70 && real.m.elbowSet < 130, `${real.m.elbowSet.toFixed(0)}°`);
ok('klipp: släpphöjden är över en kroppslängd', real.m.releaseHeight > 1, real.m.releaseHeight.toFixed(2));

// Och samma vakt som för den syntetiska streckgubben: den gamla regeln lade sträckningen
// i fångsten. Går den här raden sönder testar resten inte längre rätt sak.
{
  const win = Math.round(15 * 0.4);
  const sig = real.sig;
  let burst = 0, best = -Infinity;
  for (let i = 0; i + win < sig.length; i++) {
    const rise = sig[i + win].ext - sig[i].ext;
    if (rise > best) { best = rise; burst = i; }
  }
  ok('klipp: gamla regeln föll för fångsten', sig[burst].t < 1.0, `${sig[burst].t.toFixed(2)} s`);
}

// ---------------------------------------------------------------- efter släppet (analysis.js)
//
// Måtten efter släppet har inga riktvärden och går inte in i prioriteringen – de är underlag för
// modellens egen bedömning. Därför testas två saker: att de ger rimliga värden när landningen
// syns, och att de tiger med null när den inte gör det. Ett halvt mätvärde vore värre än inget,
// eftersom modellen skulle skriva en punkt om något den inte kan se.
{
  const pr = postRelease(plain.sig, plain.ph);
  ok('efter släppet: landningen hittas i det syntetiska skottet',
    pr.landing_ms > 200 && pr.landing_ms < 900, `${pr.landing_ms} ms`);
  ok('efter släppet: streckgubben hoppar rakt upp', Math.abs(pr.driftLanding) < 0.05,
    pr.driftLanding?.toFixed(3));
  ok('efter släppet: båda fötterna landar samtidigt', pr.landingSplit_ms === 0, `${pr.landingSplit_ms} ms`);
  ok('efter släppet: rak bål ger lutning nära noll', Math.abs(pr.trunkAfterRelease) < 5,
    pr.trunkAfterRelease?.toFixed(1));

  // Klipp som tar slut medan spelaren är i luften: ingen landning att mäta.
  const cut = phasesOf(shot(0).slice(0, 5));
  const prCut = postRelease(cut.sig, cut.ph);
  ok('efter släppet: klipp utan landning ger null',
    prCut.landing_ms === null && prCut.driftLanding === null && prCut.landingSplit_ms === null,
    JSON.stringify(prCut));

  const prReal = postRelease(real.sig, real.ph);
  ok('klipp: landningen ligger inom en dryg sekund efter frånskjutet',
    prReal.landing_ms > 200 && prReal.landing_ms < 1200, `${prReal.landing_ms} ms`);
  ok('klipp: driften är i storleksordningen en halv kroppslängd',
    Math.abs(prReal.driftLanding) < 0.6, prReal.driftLanding?.toFixed(2));
  ok('klipp: bålens lutning efter släpp är rimlig',
    Math.abs(prReal.trunkAfterRelease) < 30, `${prReal.trunkAfterRelease?.toFixed(1)}°`);
  ok('klipp: fötterna når golvet inom en halv sekund från varandra',
    prReal.landingSplit_ms !== null && prReal.landingSplit_ms < 500, `${prReal.landingSplit_ms} ms`);
}

// Konfidensen bygger på att en tappad ledpunkt slår igenom på rätt mätvärde, inte på alla.
{
  const frames = clipFrames(shot(0));
  const side = pickSide(frames, 'auto');
  const sig = signals(frames, side, ASPECT);
  const ph = findPhases(sig);
  const elbow = side === 'right' ? L.rElb : L.lElb;
  frames[ph.set].lm[elbow] = { ...frames[ph.set].lm[elbow], visibility: 0.2 };
  const vis = visibilityByMetric(frames, ph, side);
  ok('visibility: en tappad armbåge sänker bara armbågsmåttet',
    near(vis.elbowSet, 0.2, 1e-9) && vis.kneeMin === 1, `elbowSet ${vis.elbowSet}, kneeMin ${vis.kneeMin}`);
}

// ---------------------------------------------------------------- utsnitt (draw.js)
//
// Delningsbilden visar fyra faser bredvid varandra, så rutorna klipps runt spelaren.
// Går det snett är det inte bara fult: fötterna eller bollhanden kan hamna utanför just
// den bild som skickas till tränaren, och då mäter appen på något man inte kan se.
{
  const box = 3 / 4;
  const joints = [L.nose, L.lSho, L.rSho, L.lWri, L.rWri, L.lHip, L.rHip, L.lAnk, L.rAnk];
  let inside = true, framed = true, shape = true;
  for (const key of ['lowest', 'set', 'release', 'follow']) {
    const lm = real.frames[real.ph[key]].lm;
    const c = personCrop(lm, real.aspect, box);
    for (const j of joints) {
      if (lm[j].x < c.x || lm[j].x > c.x + c.w || lm[j].y < c.y || lm[j].y > c.y + c.h) inside = false;
    }
    if (c.x < 0 || c.y < 0 || c.x + c.w > 1.001 || c.y + c.h > 1.001) framed = false;
    if (!near((c.w * real.aspect) / c.h, box, 0.01)) shape = false;
  }
  ok('utsnitt: hela spelaren är med i varje fas', inside);
  ok('utsnitt: håller sig innanför bilden', framed);
  ok('utsnitt: rutans proportioner stämmer', shape);
}

// ---------------------------------------------------------------- vinkelbågar (draw.js)
//
// Bågen ska ligga i leden den mäter, alltså innanför de två benen som möts där. Med en fast
// radie gjorde den inte det: överarmen är ~29 px i en fasruta som är 315 bred, och radien var
// 45. Bågen sträckte sig då förbi både axel och handled och såg ut att höra till någon annan
// del av kroppen än armbågen den mätte. Vi ritar därför med en attrapp-canvas och kontrollerar
// geometrin i stället för att lita på att den ser rätt ut.
{
  const stub = () => {
    const calls = { arc: [], rect: [] };
    const ctx = {
      save() {}, restore() {}, beginPath() {}, clip() {}, stroke() {}, fill() {},
      drawImage() {}, moveTo() {}, lineTo() {}, fillText() {},
      rect(x, y, w, h) { calls.rect.push({ x, y, w, h }); },
      arc(x, y, r) { calls.arc.push({ x, y, r }); },
      measureText(s) { return { width: s.length * 10 }; },
    };
    return { ctx, calls };
  };
  const img = { width: 315, height: 560 };
  const dest = { x: 0, y: 0, w: 315, h: 560 };
  const side = pickSide(real.frames, 'auto');
  const j = side === 'right'
    ? { sho: L.rSho, elb: L.rElb, wri: L.rWri, hip: L.rHip, knee: L.rKnee, ank: L.rAnk }
    : { sho: L.lSho, elb: L.lElb, wri: L.lWri, hip: L.lHip, knee: L.lKnee, ank: L.lAnk };

  let insideLimbs = true, visible = true, worst = Infinity;
  for (const [phase, key] of [['set', 'elbowSet'], ['lowest', 'kneeMin'], ['release', 'kneeRelease']]) {
    const lm = real.frames[real.ph[phase]].lm;
    const { ctx, calls } = stub();
    drawFrame(ctx, img, dest, lm, side, [{ key, status: 'good', value: 90 }]);
    const [a, b, c] = ARC[key](j);
    const px = k => ({ x: lm[k].x * dest.w, y: lm[k].y * dest.h });
    const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    const limb = Math.min(d(px(a), px(b)), d(px(b), px(c)));
    const drawn = calls.arc[0];
    if (!drawn || drawn.r > limb) insideLimbs = false;
    if (!drawn || drawn.r < 8) visible = false;
    worst = Math.min(worst, limb - (drawn?.r ?? Infinity));
  }
  ok('bågar: radien håller sig innanför ledens ben', insideLimbs, `minsta marginal ${worst.toFixed(0)} px`);
  ok('bågar: bågen är stor nog att se', visible);

  // Etiketten ska ligga ut längs bågen, alltså i den kil som vinkeln öppnar – inte på ett
  // fast avstånd åt höger, där den lika gärna kan hamna på andra sidan armen än bågen.
  const lm = real.frames[real.ph.set].lm;
  const { ctx, calls } = stub();
  drawFrame(ctx, img, dest, lm, side, [{ key: 'elbowSet', status: 'good', value: 90 }]);
  const arc = calls.arc[0];
  const box = calls.rect[calls.rect.length - 1];   // sista rect är etikettens platta
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const [ea, eb, ec] = ARC.elbowSet(j);
  const ray = k => Math.atan2(lm[k].y * dest.h - arc.y, lm[k].x * dest.w - arc.x);
  const wrap = d => Math.atan2(Math.sin(d), Math.cos(d));
  const span = wrap(ray(ec) - ray(ea));            // kilen mellan överarm och underarm
  const toLabel = wrap(Math.atan2(cy - arc.y, cx - arc.x) - ray(ea));
  const inWedge = span > 0 ? toLabel > 0 && toLabel < span : toLabel < 0 && toLabel > span;
  ok('bågar: etiketten ligger i vinkelns kil', inWedge,
    `${((toLabel / span) * 100).toFixed(0)} % in i kilen`);

  // Vidvinkelklipp: filmat från läktaren är spelaren en sjättedel av bildhöjden, och då är
  // överarmen ~14 px i den sparade rutan – kortare än radiens golv (dest.w/22). Ritas hela
  // bildrutan hamnar bågen utanför armen igen, hur väl den än följer benen. Resultatvyn
  // klipper därför runt spelaren precis som delningsbilden, och det är utsnittet som gör
  // måtten rimliga. Testet visar båda: utan utsnitt faller det, med utsnitt håller det.
  const wide = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }));
  const put = (k, x, y) => { wide[k] = { x, y }; };
  put(L.nose, .500, .420);
  put(L.lSho, .500, .440); put(L.rSho, .500, .440);
  put(L.lElb, .488, .462); put(L.rElb, .488, .462);   // armbåge ut från kroppen
  put(L.lWri, .502, .448); put(L.rWri, .502, .448);   // handled tillbaka in: vikt arm
  put(L.lHip, .508, .500); put(L.rHip, .508, .500);
  put(L.lKnee, .498, .540); put(L.rKnee, .498, .540);
  put(L.lAnk, .508, .580); put(L.rAnk, .508, .580);
  put(L.lHeel, .508, .585); put(L.rHeel, .508, .585);

  const frameAspect = 0.66, cardBox = 3 / 4;
  const wideDest = { x: 0, y: 0, w: Math.round(560 * cardBox), h: 560 };
  const fitsWith = crop => {
    const { ctx, calls } = stub();
    drawFrame(ctx, { width: 400, height: 606 }, wideDest, wide, 'left',
      [{ key: 'elbowSet', status: 'good', value: 70 }], crop);
    const [a, b, c] = ARC.elbowSet({ sho: L.lSho, elb: L.lElb, wri: L.lWri });
    const at = k => ({
      x: ((wide[k].x - crop.x) / crop.w) * wideDest.w,
      y: ((wide[k].y - crop.y) / crop.h) * wideDest.h,
    });
    const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    const limb = Math.min(d(at(a), at(b)), d(at(b), at(c)));
    return { limb, r: calls.arc[0].r };
  };
  const whole = fitsWith(FULL);
  const cropped = fitsWith(personCrop(wide, frameAspect, cardBox));
  ok('bågar: hela bildrutan räcker inte på ett vidvinkelklipp', whole.r > whole.limb,
    `arm ${whole.limb.toFixed(0)} px, radie ${whole.r.toFixed(0)} px`);
  ok('bågar: med utsnitt runt spelaren ligger bågen i armen', cropped.r <= cropped.limb,
    `arm ${cropped.limb.toFixed(0)} px, radie ${cropped.r.toFixed(0)} px`);
}

// Formateringen följer riktvärdet: sekunder får två decimaler, grader inga.
ok('format: sekunder med två decimaler', formatValue('tLowToRelease', 0.6, 'sv') === '0.60 s',
  formatValue('tLowToRelease', 0.6, 'sv'));
ok('format: grader utan mellanslag', formatValue('kneeMin', 100.4, 'sv') === '100°', formatValue('kneeMin', 100.4, 'sv'));
ok('format: saknat värde blir tankstreck', formatValue('kneeMin', null, 'sv') === '–');

// ---------------------------------------------------------------- prioritering
// Jalen-fallet: tvåstegsskott med paus, ~1,05 s lägsta→släpp, knä ~100°.
// Fokus ska bli tiden, inte något annat.
const jalen = { kneeMin: 100, tLowToRelease: 1.05, kneeRelease: 150, trunkLowest: 25, elbowSet: 95, releaseHeight: 1.25 };
const pj = prioritize(jalen);
ok('Jalen: fokus är tempot', pj.focus?.key === 'tLowToRelease', pj.focus?.key);
ok('Jalen: rätt riktning', pj.focus?.dir === 'high');

// Leo-fallet: enstegsskott, ~0,6 s, knä ~100°. Tid och knädjup ska vara inom ramarna.
const leo = { kneeMin: 100, tLowToRelease: 0.6, kneeRelease: 150, trunkLowest: 25, elbowSet: 95, releaseHeight: 1.25 };
const pl = prioritize(leo);
ok('Leo: inget att anmärka', pl.issues.length === 0, pl.issues.map(i => i.key).join(','));

// Facit ur CLAUDE.md, som en spärr: den AI-formulerade texten får byta ord, aldrig lista.
// Går de här raderna sönder har prioriteringen ändrats, och då stämmer inte längre det som
// står om Leo och Jalen i CLAUDE.md heller.
ok('Jalen: listan är tempot, i den ordningen',
  issueList(pj, 'sv').map(i => i.key).join(',') === 'tLowToRelease',
  issueList(pj, 'sv').map(i => i.key).join(','));
ok('Jalen: rubriken är rules.js egen', issueList(pj, 'sv')[0].title === 'Släpp bollen på vägen upp',
  issueList(pj, 'sv')[0].title);
ok('Leo: listan är tom', issueList(pl, 'sv').map(i => i.key).join(',') === '',
  issueList(pl, 'sv').map(i => i.key).join(','));

// Listan fylls aldrig ut med påhittade fel.
ok('tom lista när allt är inom ramarna', issueList(pl, 'sv').length === 0);
ok('listan är aldrig längre än fem', issueList(prioritize({
  kneeMin: 130, tLowToRelease: 1.6, kneeRelease: 190, trunkLowest: 60, elbowSet: 140, releaseHeight: 0.7,
}), 'sv').length === 5);

// ---------------------------------------------------------------- coach.js och workern
//
// Inget nätverk: fetch mockas. Det som testas är att rätt saker skickas, att fallbacken är
// intakt, och att workern vägrar ett svar som inte följer prioriteringen. Det sista är hela
// poängen med kontrollen – prioriteringen ska vara deterministisk även om modellen inte är det.
{
  const data = resultOf(real);
  const payload = buildPayload({ lang: 'sv', age: 15, data });

  ok('payload: inga bilder skickas som standard', payload.frames.length === 0);
  ok('payload: mätvärdena har rules.js egna nycklar',
    payload.metrics.every(m => METRIC_KEYS.includes(m.key)), payload.metrics.map(m => m.key).join(','));
  ok('payload: riktvärden och enheter kommer från rules.js', payload.metrics.every(m => {
    const s = metricSpec(m.key);
    return m.ref[0] === s.ok[0] && m.ref[1] === s.ok[1] && m.unit === s.unit;
  }));
  ok('payload: listan skickas i prioriteringens ordning',
    payload.issues.map(i => i.key).join(',') === issueList(data.prio, 'sv', 5).map(i => i.key).join(','),
    payload.issues.map(i => i.key).join(','));
  ok('payload: efter släppet skickas utan riktvärde och utan bedömning',
    Object.keys(payload.postRelease).join(',') === 'landing_ms,driftLanding,trunkAfterRelease,landingSplit_ms',
    Object.keys(payload.postRelease).join(','));
  ok('payload: 15 rutor/s märks som osäkert mätt',
    payload.metrics.every(m => m.confidence === 'low'), `fps ${payload.fps}`);

  // Slow motion ger fler rutor per verklig sekund, inte färre – då är mätningen inte osäker.
  const fast = { ...data, ph: { ...data.ph, fps: 60 } };
  ok('payload: 60 rutor/s märks inte som osäkert',
    buildPayload({ lang: 'sv', data: fast }).metrics.every(m => !m.confidence));

  // ...men en led som MediaPipe knappt såg gör sitt eget mätvärde osäkert ändå.
  const dim = { ...fast, vis: { ...fast.vis, elbowSet: 0.2 } };
  const dimmed = buildPayload({ lang: 'sv', data: dim }).metrics;
  ok('payload: en dåligt spårad led märker bara sitt eget mätvärde',
    dimmed.find(m => m.key === 'elbowSet').confidence === 'low'
    && dimmed.filter(m => m.key !== 'elbowSet').every(m => !m.confidence));

  // Workerns kontroll av svaret.
  const keys = payload.issues.map(i => i.key);
  const answer = over => ({
    summary: 's', strengths: [],
    priority: { key: keys[0], title: 't', what: 'w', why: 'y', drill: 'd', encouragement: 'e' },
    secondary: keys.slice(1).map(k => ({ key: k, text: 'x' })),
    observations: [], uncertainties: [], after: null, disagreement: null, ...over,
  });
  ok('workern: ett svar i prioriteringens ordning släpps igenom', checkShape(answer(), payload) === null,
    checkShape(answer(), payload) || '');
  ok('workern: fel nyckel i priority kastas',
    checkShape(answer({ priority: { ...answer().priority, key: 'elbowSet' } }), payload) !== null);
  ok('workern: omkastad secondary kastas',
    checkShape(answer({ secondary: [...answer().secondary].reverse() }), payload) !== null);
  ok('workern: en extra punkt i secondary kastas',
    checkShape(answer({ secondary: [...answer().secondary, { key: 'elbowSet', text: 'x' }] }), payload) !== null);
  ok('workern: observationer utan bilder kastas',
    checkShape(answer({ observations: ['ser bra ut'] }), payload) !== null);
  ok('workern: observationer med bilder släpps igenom',
    checkShape(answer({ observations: ['ser bra ut'] }), { ...payload, frames: [{ phase: 'release' }] }) === null);
  ok('workern: priority måste vara null när listan är tom',
    checkShape(answer(), { ...payload, issues: [] }) !== null
    && checkShape(answer({ priority: null, secondary: [] }), { ...payload, issues: [] }) === null);

  // Valideringen av det som kommer in. Adressen är öppen; allt som inte ser ut som en analys
  // ska bort innan något skickas vidare och kostar pengar.
  ok('workern: en riktig payload valideras', validate(payload) === null, validate(payload) || '');
  ok('workern: okänt språk avvisas', validate({ ...payload, lang: 'de' }) === 'lang');
  ok('workern: påhittad mätvärdesnyckel avvisas',
    validate({ ...payload, metrics: [{ ...payload.metrics[0], key: 'vingbredd' }] }) === 'metrics.key');
  ok('workern: för många bilder avvisas',
    validate({ ...payload, frames: Array.from({ length: 6 }, () => ({ phase: 'set', jpeg_base64: 'AA==' })) }) === 'frames');
  ok('workern: en för stor bild avvisas',
    validate({ ...payload, frames: [{ phase: 'set', jpeg_base64: 'A'.repeat(200 * 1024 + 1) }] }) === 'frames.jpeg_base64');
  ok('workern: en bild som inte är base64 avvisas',
    validate({ ...payload, frames: [{ phase: 'set', jpeg_base64: '<script>' }] }) === 'frames.jpeg_base64');

  // Fallbacken: utan svar står rules.js texter kvar, ord för ord.
  const issues = issueList(data.prio, 'sv', 5);
  const fallback = merge(issues, null);
  ok('fallback: rules.js texter står kvar när svaret uteblir',
    fallback.every((it, i) => it.title === issues[i].title && it.why === issues[i].why && it.ai === false));
  const merged = merge(issues, answer());
  ok('svar: modellens ord läggs på rätt post',
    merged[0].title === 't' && merged[0].ai === true && merged[0].key === issues[0].key);
  const wrong = merge(issues, answer({ priority: { ...answer().priority, key: 'elbowSet' } }));
  ok('svar: fel nyckel ger rules.js text, aldrig modellens',
    wrong[0].title === issues[0].title && wrong[0].ai === false);

  // Anropet. fetch mockas – testerna rör aldrig nätet.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ summary: 'ok' }) });
  ok('anrop: ett svar kommer tillbaka som det är', (await requestCoach(payload)).summary === 'ok');
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({ error: 'E_COACH_UPSTREAM' }) });
  let code = null;
  try { await requestCoach(payload); } catch (e) { code = e.message; }
  ok('anrop: workerns felkod når klienten', code === 'E_COACH_UPSTREAM', code || 'inget fel');
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  code = null;
  try { await requestCoach(payload); } catch (e) { code = e.message; }
  ok('anrop: offline ger en kod, inte ett kraschat löfte', code === 'E_COACH', code || 'inget fel');
  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------- språk
const src = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');
const keysOf = lang => {
  const block = src.match(new RegExp(`  ${lang}: \\{([\\s\\S]*?)\\n  \\},`))[1];
  return block.match(/^ {4}(\w+):/gm).map(x => x.trim().slice(0, -1));
};
const sv = keysOf('sv'), en = keysOf('en');
ok('svenska och engelska har samma nycklar',
  sv.length === en.length && sv.every(k => en.includes(k)),
  `sv ${sv.length}, en ${en.length}, saknas i en: ${sv.filter(k => !en.includes(k)).join(',') || 'inga'}`);

// ---------------------------------------------------------------- gränssnittets kopplingar
//
// app.js hämtar element med $('id') och index.html märker texter med data-i18n. Går de isär
// syns det inte i någon annan kontroll: appen kastar först när användaren kommit till
// resultatvyn, och en saknad språknyckel blir bara ordet "undefined" i gränssnittet.
{
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]));
  const wanted = [...new Set([...app.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]))];
  const missing = wanted.filter(id => !ids.has(id));
  ok('alla element app.js hämtar finns i index.html', missing.length === 0, missing.join(',') || 'inga saknas');

  const used = [...new Set([...html.matchAll(/data-i18n="(\w+)"/g)].map(m => m[1]))];
  const unknown = used.filter(k => !sv.includes(k));
  ok('alla data-i18n-nycklar finns i i18n.js', unknown.length === 0, unknown.join(',') || 'inga saknas');

  // Ett element som göms med hidden-attributet syns ändå om CSS:en sätter display på det:
  // en egen regel vinner över webbläsarens [hidden]{display:none}. Bollen som hämtar den
  // avancerade analysen låg kvar och studsade av just det skälet, och det syntes inte i någon
  // annan kontroll – felet är osynligt tills någon tittar på skärmen.
  {
    const hiddenSel = new Set();
    for (const [, tag] of html.matchAll(/<(\w+[^>]*\bhidden\b[^>]*)>/g)) {
      for (const [, cls] of tag.matchAll(/class="([^"]+)"/g)) for (const c of cls.split(/\s+/)) hiddenSel.add(`.${c}`);
      for (const [, id] of tag.matchAll(/\bid="([\w-]+)"/g)) hiddenSel.add(`#${id}`);
    }
    const risky = [];
    for (const [, sel, body] of html.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/display\s*:/.test(body) || /\[hidden\]/.test(sel)) continue;
      // Selektorn kommer med allt sedan förra klammern – kommentarer och radbrytningar med.
      // Bara sista raden är själva selektorn.
      for (const part of sel.split(',')) {
        const s = part.split('\n').pop().trim();
        if (hiddenSel.has(s) && !html.includes(`${s}[hidden]`)) risky.push(s);
      }
    }
    ok('element som göms med hidden har display:none som vinner', risky.length === 0,
      risky.join(',') || 'inga');
  }

  const share = readFileSync(new URL('./share.js', import.meta.url), 'utf8');
  const called = [...new Set([...(app + share).matchAll(/\bt\('(\w+)'\)/g)].map(m => m[1]))];
  const gone = called.filter(k => !sv.includes(k));
  ok('alla t()-nycklar i koden finns i i18n.js', gone.length === 0, gone.join(',') || 'inga saknas');
}

console.log(fail ? `\n${fail} fel` : '\nAllt grönt');
process.exit(fail ? 1 : 0);
