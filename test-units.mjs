// test-units.mjs – kontroller som inte behöver testklipp.
// Kör: node test-units.mjs
//
// Facittestet mot samples/*_lm.json (Leo och Jalen) är ett annat test och kräver
// klippen. Det här körs var som helst och täcker det som går att räkna på syntetiska
// data: hastighetsgissningen, prioriteringsordningen och att språken har samma nycklar.

import { readFileSync } from 'node:fs';
import { L, signals, findPhases, metrics, pickSide, estimateSpeed } from './analysis.js';
import { prioritize, issueList, formatValue } from './rules.js';
import { personCrop } from './draw.js';

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
  const sig = signals(frames, pickSide(frames, 'auto'), ASPECT);
  const ph = findPhases(sig);
  return { sig, ph, m: metrics(sig, ph), at: k => sig[ph[k]].t };
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
  const sig = signals(frames, pickSide(frames, 'auto'), f.aspect);
  const ph = findPhases(sig);
  return { frames, aspect: f.aspect, sig, ph, m: metrics(sig, ph), at: k => sig[ph[k]].t };
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

// Listan fylls aldrig ut med påhittade fel.
ok('tom lista när allt är inom ramarna', issueList(pl, 'sv').length === 0);
ok('listan är aldrig längre än fem', issueList(prioritize({
  kneeMin: 130, tLowToRelease: 1.6, kneeRelease: 190, trunkLowest: 60, elbowSet: 140, releaseHeight: 0.7,
}), 'sv').length === 5);

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

console.log(fail ? `\n${fail} fel` : '\nAllt grönt');
process.exit(fail ? 1 : 0);
