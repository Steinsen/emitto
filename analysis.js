// analysis.js – hittar skottets faser och räknar ut mätvärden från ledpunkter.
// Indata: frames = [{t, lm}] där lm är MediaPipe-landmarks (normaliserade 0–1, y nedåt).
// Fel kastas som koder (E_*), aldrig som färdig text – översättningen görs i app.js.
// Allt är 2D från sidovy. Räkna med ±5° i vinklarna.

export const L = { nose:0, lSho:11, rSho:12, lElb:13, rElb:14, lWri:15, rWri:16,
  lHip:23, rHip:24, lKnee:25, rKnee:26, lAnk:27, rAnk:28, lHeel:29, rHeel:30 };

export function angle(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

// Vinkel mellan bålen (höft→axel) och lodlinjen. 0 = rak, positivt = framåtlutad.
function trunkLean(sho, hip) {
  return Math.abs((Math.atan2(sho.x - hip.x, hip.y - sho.y) * 180) / Math.PI);
}

function smooth(arr, w = 3) {
  const h = Math.floor(w / 2);
  return arr.map((_, i) => {
    let s = 0, n = 0;
    for (let j = i - h; j <= i + h; j++) if (j >= 0 && j < arr.length) { s += arr[j]; n++; }
    return s / n;
  });
}

// Väljer sidan som syns bäst. "right"/"left" tvingar.
export function pickSide(frames, hand = 'auto') {
  if (hand !== 'auto') return hand;
  // Skjutarmen = den handled som når högst (minst y) under klippet.
  let rMin = 1, lMin = 1;
  for (const f of frames) { rMin = Math.min(rMin, f.lm[L.rWri].y); lMin = Math.min(lMin, f.lm[L.lWri].y); }
  return rMin <= lMin ? 'right' : 'left';
}

export function signals(frames, side, aspect) {
  // aspect = width/height, så att vinklar räknas i bildens verkliga proportioner
  const P = (lm, k) => ({ x: lm[k].x * aspect, y: lm[k].y });
  const S = side === 'right'
    ? { sho: L.rSho, elb: L.rElb, wri: L.rWri, hip: L.rHip, knee: L.rKnee, ank: L.rAnk }
    : { sho: L.lSho, elb: L.lElb, wri: L.lWri, hip: L.lHip, knee: L.lKnee, ank: L.lAnk };
  const O = side === 'right'
    ? { hip: L.lHip, knee: L.lKnee, ank: L.lAnk }
    : { hip: L.rHip, knee: L.rKnee, ank: L.rAnk };

  const raw = frames.map(({ t, lm }) => ({
    t,
    knee: (angle(P(lm, S.hip), P(lm, S.knee), P(lm, S.ank)) + angle(P(lm, O.hip), P(lm, O.knee), P(lm, O.ank))) / 2,
    hip: angle(P(lm, S.sho), P(lm, S.hip), P(lm, S.knee)),
    elbow: angle(P(lm, S.sho), P(lm, S.elb), P(lm, S.wri)),
    trunk: trunkLean(P(lm, S.sho), P(lm, S.hip)),
    wristY: lm[S.wri].y, noseY: lm[L.nose].y, shoY: lm[S.sho].y,
    // armsträckning: avstånd axel→handled i förhållande till bålens längd (0,5 = vikt arm, 1+ = sträckt)
    ext: Math.hypot((lm[S.sho].x - lm[S.wri].x) * aspect, lm[S.sho].y - lm[S.wri].y)
       / (Math.hypot((lm[S.sho].x - lm[S.hip].x) * aspect, lm[S.sho].y - lm[S.hip].y) || 1),
    ankleY: (lm[S.ank].y + lm[O.ank].y) / 2,
  }));
  const keys = ['knee', 'hip', 'elbow', 'trunk', 'wristY', 'ankleY', 'ext'];
  const sm = {};
  for (const k of keys) sm[k] = smooth(raw.map(r => r[k]));
  return raw.map((r, i) => { const o = { ...r }; for (const k of keys) o[k] = sm[k][i]; return o; });
}

// Stående utgångsläge = medianvärden i första 0,3 s. Bruten ur findPhases för att
// hastighetsgissningen behöver samma golvnivå innan faserna är kända.
export function floorLevel(sig) {
  const n = sig.length;
  const fps = n / (sig[n - 1].t - sig[0].t || 1);
  const head = sig.slice(0, Math.max(3, Math.round(fps * 0.3)));
  const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const ankleBase = median(head.map(f => f.ankleY));
  const noseBase = median(head.map(f => f.noseY));
  return { fps, ankleBase, noseBase, bodyPx: (ankleBase - noseBase) / 0.87 }; // näsa→fotled ≈ 87 % av kroppslängden
}

export function findPhases(sig) {
  const n = sig.length;
  if (n < 10) throw new Error('E_FEW_FRAMES');
  const { fps, ankleBase, noseBase, bodyPx } = floorLevel(sig);

  // 1. Sträckningsfasen: 0,4 s-fönstret där armen sträcks mest
  const win = Math.max(2, Math.round(fps * 0.4));
  let burst = 0, bestRise = -Infinity;
  for (let i = 0; i + win < n; i++) {
    const rise = sig[i + win].ext - sig[i].ext;
    if (rise > bestRise) { bestRise = rise; burst = i; }
  }
  if (bestRise < 0.15) throw new Error('E_NO_SHOT');

  // 2. Set point: armen som mest vikt under 1,5 s före sträckningen
  let set = burst;
  for (let i = Math.max(0, burst - Math.round(fps * 1.5)); i <= burst; i++) if (sig[i].ext < sig[set].ext) set = i;

  // 3. Släpp: halvvägs i sträckningen (mellan set point och fullt sträckt arm)
  let full = burst;
  for (let i = burst; i <= Math.min(n - 1, burst + win + 2); i++) if (sig[i].ext > sig[full].ext) full = i;
  const mid = sig[set].ext + 0.35 * (sig[full].ext - sig[set].ext); // bollen lämnar handen tidigt i sträckningen
  let release = full;
  for (let i = set; i <= full; i++) if (sig[i].ext >= mid) { release = i; break; }

  // 4. Lägsta läge: minsta knävinkel från 1,2 s före set point fram till släppet
  let lowest = Math.max(0, set - Math.round(fps * 1.2));
  for (let i = lowest; i < release; i++) if (sig[i].knee < sig[lowest].knee) lowest = i;

  // 5. Frånskjut: fotleden lyfter tydligt från golvnivå
  const lift = 0.015 * (ankleBase - noseBase);
  let takeoff = -1;
  for (let i = lowest; i < n; i++) if (sig[i].ankleY < ankleBase - lift) { takeoff = i; break; }

  // 6. Följning: 0,3 s efter släppet. Apex = fotledens högsta punkt inom 0,7 s efter frånskjutet.
  const follow = Math.min(n - 1, release + Math.round(fps * 0.3));
  let apex = follow;
  if (takeoff >= 0) {
    apex = takeoff;
    for (let i = takeoff; i <= Math.min(n - 1, takeoff + Math.round(fps * 0.7)); i++) if (sig[i].ankleY < sig[apex].ankleY) apex = i;
  }

  return { lowest, set, release, takeoff, apex, follow, fps, ankleBase, bodyPx };
}

export function metrics(sig, ph) {
  const lo = sig[ph.lowest], se = sig[ph.set], re = sig[ph.release];
  const t = re.t - lo.t;
  const takeoffLag = ph.takeoff >= 0 ? re.t - sig[ph.takeoff].t : null; // <0: släpp innan fötterna lämnar golvet
  return {
    kneeMin: lo.knee,
    hipMin: lo.hip,
    trunkLowest: lo.trunk,
    elbowSet: se.elbow,
    tLowToRelease: t,
    kneeRelease: re.knee,
    takeoffLag,
    hipVel: t > 0 ? (re.hip - lo.hip) / t : 0,
    releaseHeight: ph.bodyPx > 0 ? (ph.ankleBase - re.wristY) / ph.bodyPx : null, // släpphöjd / kroppslängd
  };
}

// ---------------------------------------------------------------- uppspelningshastighet
//
// Slow motion sträcker ut tidsaxeln. Det skulle inte bara ge fel sekunder: findPhases
// letar i fönster mätta i sekunder (0,4 s sträckning, 1,5 s set point, 1,2 s lägsta läge),
// så ett fyrgångers klipp får fönster som täcker en fjärdedel av rörelsen. Därför skalas
// tiden om INNAN faserna söks, och allt nedströms räknar i verklig tid.

// Kandidater. Telefoner spelar in i 120 eller 240 fps och lägger ut i 30: 4× och 8×.
const FACTORS = [1, 2, 4, 8];

// Tyngdaccelerationen uttryckt i kroppslängder per sekund i kvadrat. 9,81 m/s² delat med
// kroppslängden: 1,4 m ger 7,0 och 1,9 m ger 5,2. Vi antar 1,65 m. Felet i antagandet slår
// bara till hälften igenom på faktorn (den är en kvadratrot), och kandidaterna ligger en
// faktor två isär – därför spelar spelarens verkliga längd nästan ingen roll här.
const G_BODYLENGTHS = 9.81 / 1.65;

// Två olika trösklar, i kroppslängder.
// PEAK_MIN: så högt måste toppen nå för att det ska räknas som ett hopp alls. En tåhävning
// lyfter fotleden 5–8 cm (~0,04) och är dessutom mjuk och ungefär parabolisk – utan den här
// gränsen skulle den läsas som ett långsamt fall, alltså som slow motion. 0,08 kroppslängder
// är ~14 cm och ligger över vad en tåhävning når men under ett blygsamt skotthopp.
// AIRBORNE_MIN: var intervallet börjar och slutar. Lägre, för att få med fler punkter i
// anpassningen – samma nivå som frånskjutet använder.
const PEAK_MIN = 0.08;
const AIRBORNE_MIN = 0.015;

function fitFall(ts, hs) {
  // Minsta kvadrat-anpassning av h = c0 + c1·t + c2·t². Fritt fall ger c2 = −a/2.
  const n = ts.length;
  let S = [0, 0, 0, 0, 0], b = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const t = ts[i], h = hs[i];
    const p = [1, t, t * t, t * t * t, t * t * t * t];
    for (let k = 0; k < 5; k++) S[k] += p[k];
    for (let k = 0; k < 3; k++) b[k] += h * p[k];
  }
  const M = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]];
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    if (Math.abs(M[piv][i]) < 1e-12) return null;
    [M[i], M[piv]] = [M[piv], M[i]]; [b[i], b[piv]] = [b[piv], b[i]];
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = M[r][i] / M[i][i];
      for (let c = i; c < 3; c++) M[r][c] -= f * M[i][c];
      b[r] -= f * b[i];
    }
  }
  const c = [b[0] / M[0][0], b[1] / M[1][1], b[2] / M[2][2]];
  const mean = hs.reduce((x, y) => x + y, 0) / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const t = ts[i], p = c[0] + c[1] * t + c[2] * t * t;
    ssRes += (hs[i] - p) ** 2; ssTot += (hs[i] - mean) ** 2;
  }
  return { c2: c[2], r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

// Gissar uppspelningshastigheten ur hoppets fria fall. Returnerar null när spelaren inte
// lämnar golvet – ett straffkast går inte att bedöma så här, och då ska vi inte gissa.
export function estimateSpeed(sig) {
  const { ankleBase, bodyPx } = floorLevel(sig);
  if (!(bodyPx > 0)) return null;
  const h = sig.map(f => (ankleBase - f.ankleY) / bodyPx); // höjd över golvet i kroppslängder

  let bestFrom = -1, bestLen = 0, from = -1;
  for (let i = 0; i <= h.length; i++) {
    if (i < h.length && h[i] > AIRBORNE_MIN) { if (from < 0) from = i; continue; }
    if (from >= 0) { if (i - from > bestLen) { bestLen = i - from; bestFrom = from; } from = -1; }
  }
  if (bestLen < 5) return null; // för få punkter i luften för en parabel

  const seg = sig.slice(bestFrom, bestFrom + bestLen);
  const peak = Math.max(...h.slice(bestFrom, bestFrom + bestLen));
  if (peak < PEAK_MIN) return null; // tåhävning eller brus, inte ett hopp

  const t0 = seg[0].t;
  const fit = fitFall(seg.map(f => f.t - t0), h.slice(bestFrom, bestFrom + bestLen));
  if (!fit || fit.r2 < 0.9) return null;   // ingen ren parabel – troligen tåhävning eller brus

  const a = -2 * fit.c2;                   // uppmätt acceleration, kroppslängder/s²
  if (!(a > 0)) return null;
  const raw = Math.sqrt(G_BODYLENGTHS / a);

  let best = null, bestErr = Infinity;
  for (const f of FACTORS) {
    const err = Math.abs(Math.log2(raw / f));
    if (err < bestErr) { bestErr = err; best = f; }
  }
  // Mer än ~27 % från närmaste kandidat: säg hellre inget än fel.
  return bestErr < 0.35 ? { factor: best, raw, accel: a, r2: fit.r2, frames: bestLen } : null;
}

// Ny signalserie där tiden går i verklig takt i stället för uppspelningens.
export const rescaleTime = (sig, factor) =>
  (factor === 1 ? sig : sig.map(f => ({ ...f, t: f.t / factor })));
