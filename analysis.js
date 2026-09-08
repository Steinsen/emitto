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

// Vinkel mellan bålen (höft→axel) och lodlinjen, tecknad: positivt = axeln ligger åt höger om
// höften i bilden. Vilket håll som är "framåt" vet den inte – det avgörs av skottriktningen,
// som postRelease() läser ur handleden vid släpp.
function trunkTilt(sho, hip) {
  return (Math.atan2(sho.x - hip.x, hip.y - sho.y) * 180) / Math.PI;
}

// Vinkel mellan bålen och lodlinjen. 0 = rak, positivt = lutad åt något håll.
function trunkLean(sho, hip) {
  return Math.abs(trunkTilt(sho, hip));
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

// Vilka ledpunkter som hör till skjutsidan (S) och den andra sidan (O). Bruten ur signals()
// eftersom både postRelease() och visibilityByMetric() behöver samma uppdelning.
export const sideJoints = side => (side === 'right'
  ? { S: { sho: L.rSho, elb: L.rElb, wri: L.rWri, hip: L.rHip, knee: L.rKnee, ank: L.rAnk },
      O: { sho: L.lSho, elb: L.lElb, wri: L.lWri, hip: L.lHip, knee: L.lKnee, ank: L.lAnk } }
  : { S: { sho: L.lSho, elb: L.lElb, wri: L.lWri, hip: L.lHip, knee: L.lKnee, ank: L.lAnk },
      O: { sho: L.rSho, elb: L.rElb, wri: L.rWri, hip: L.rHip, knee: L.rKnee, ank: L.rAnk } });

export function signals(frames, side, aspect) {
  // aspect = width/height, så att vinklar räknas i bildens verkliga proportioner
  const P = (lm, k) => ({ x: lm[k].x * aspect, y: lm[k].y });
  const { S, O } = sideJoints(side);

  const raw = frames.map(({ t, lm }) => {
    const sho = P(lm, S.sho), wri = P(lm, S.wri), hip = P(lm, S.hip);
    const torso = Math.hypot(sho.x - hip.x, sho.y - hip.y) || 1;
    return {
      t,
      knee: (angle(P(lm, S.hip), P(lm, S.knee), P(lm, S.ank)) + angle(P(lm, O.hip), P(lm, O.knee), P(lm, O.ank))) / 2,
      hip: angle(P(lm, S.sho), P(lm, S.hip), P(lm, S.knee)),
      elbow: angle(P(lm, S.sho), P(lm, S.elb), P(lm, S.wri)),
      trunk: trunkLean(sho, hip),
      wristY: lm[S.wri].y, noseY: lm[L.nose].y, shoY: lm[S.sho].y,
      // armsträckning: avstånd axel→handled i förhållande till bålens längd (0,5 = vikt arm, 1+ = sträckt)
      ext: Math.hypot(sho.x - wri.x, sho.y - wri.y) / torso,
      // ...och samma sträckning bara i höjdled: positiv när handleden är ovanför axeln.
      // Det är den som skiljer ett skott från att ta emot bollen, släppa ned den eller
      // dribbla – rörelser som sträcker armen lika mycket, men framåt eller nedåt.
      extUp: (sho.y - wri.y) / torso,
      ankleY: (lm[S.ank].y + lm[O.ank].y) / 2,
      // Fälten nedan används bara av postRelease(). x är skalat med aspect precis som ovan, så
      // vågräta och lodräta mått går att jämföra med varandra och med bållängden.
      trunkTilt: trunkTilt(sho, hip),
      hipX: hip.x, shoX: sho.x, wriX: wri.x,
      ankSY: lm[S.ank].y, ankOY: lm[O.ank].y,
    };
  });
  const keys = ['knee', 'hip', 'elbow', 'trunk', 'wristY', 'ankleY', 'ext', 'extUp',
    'trunkTilt', 'hipX', 'shoX', 'wriX', 'ankSY', 'ankOY'];
  const sm = {};
  for (const k of keys) sm[k] = smooth(raw.map(r => r[k]));
  return raw.map((r, i) => { const o = { ...r }; for (const k of keys) o[k] = sm[k][i]; return o; });
}

// Stående utgångsläge = medianvärden i första 0,3 s. Bruten ur findPhases för att
// hastighetsgissningen behöver samma golvnivå innan faserna är kända.
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

export function floorLevel(sig) {
  const n = sig.length;
  const fps = n / (sig[n - 1].t - sig[0].t || 1);
  const head = sig.slice(0, Math.max(3, Math.round(fps * 0.3)));
  const ankleBase = median(head.map(f => f.ankleY));
  const noseBase = median(head.map(f => f.noseY));
  return { fps, ankleBase, noseBase, bodyPx: (ankleBase - noseBase) / 0.87 }; // näsa→fotled ≈ 87 % av kroppslängden
}

// Krav på en skottkandidat. Måtten är i bållängder (axel→höft), så de gäller oavsett
// spelarens storlek och kamerans avstånd.
//
// RISE_MIN: armen måste sträckas så här mycket under fönstret. Som förr.
// ARM_UP_MIN: handleden måste nå så här långt ovanför axeln. Ett släpp går över huvudet
//   (armen är ungefär en bållängd), så 0,5 har god marginal – men att ta emot en boll,
//   sänka den eller dribbla stannar under axelhöjd och sållas bort.
// UP_RISE_MIN: och den ska ha stigit dit under fönstret, inte redan ha varit uppe.
const RISE_MIN = 0.15;
const ARM_UP_MIN = 0.5;
const UP_RISE_MIN = 0.3;
// Hur mycket ext får stiga på vägen bakåt innan vi anser oss ha klättrat ur dalen före
// sträckningen. Håller set point i rörelsen som blev skottet i stället för i en djupare
// armvikning tidigare i klippet (en boll som tas emot vid bröstet, till exempel).
const VALLEY_OUT = 0.15;

export function findPhases(sig) {
  const n = sig.length;
  if (n < 10) throw new Error('E_FEW_FRAMES');
  const { fps, ankleBase, noseBase, bodyPx } = floorLevel(sig);

  // 1. Sträckningsfasen: 0,4 s-fönstret där armen sträcks mest – men bara bland fönster
  //    som slutar med handleden över huvudet. Att bara ta det största utslaget i ext gör
  //    att klipp där spelaren först fångar bollen eller dribblar kan låsa fast analysen
  //    på fel rörelse; kravet på höjd avgör vilket av utslagen som faktiskt är ett skott.
  //    Finns flera skott i klippet vinner det med störst utslag.
  const win = Math.max(2, Math.round(fps * 0.4));
  const tail = i => Math.min(n - 1, i + win + 2);   // sträckningen kan toppa strax efter fönstret
  let burst = -1, full = -1, bestScore = -Infinity;
  for (let i = 0; i + win < n; i++) {
    if (sig[i + win].ext - sig[i].ext < RISE_MIN) continue;
    let top = i, up = -Infinity;
    for (let k = i; k <= tail(i); k++) {
      if (sig[k].ext > sig[top].ext) top = k;
      if (sig[k].extUp > up) up = sig[k].extUp;
    }
    if (up < ARM_UP_MIN) continue;                  // armen sträcks, men inte uppåt
    const upRise = up - sig[i].extUp;
    if (upRise < UP_RISE_MIN) continue;             // handleden var redan uppe: ingen sträckning
    const score = (sig[top].ext - sig[i].ext) + upRise;
    if (score > bestScore) { bestScore = score; burst = i; full = top; }
  }
  if (burst < 0) throw new Error('E_NO_SHOT');

  // 2. Set point: botten av dalen närmast sträckningen. Fönstret med störst utslag kan
  //    börja en ruta eller två före armens djupaste vikning, så vi går först framåt så
  //    länge armen fortsätter vikas, och sedan bakåt från botten. Bakåtvandringen stannar
  //    när armen tydligt öppnat sig igen – då är vi ur dalen och inne i en annan rörelse.
  let set = burst;
  for (let i = burst + 1; i <= Math.min(full, burst + Math.round(fps * 0.3)); i++) {
    if (sig[i].ext > sig[set].ext) break;
    set = i;
  }
  for (let i = set; i >= Math.max(0, set - Math.round(fps * 1.5)); i--) {
    if (sig[i].ext < sig[set].ext) set = i;
    else if (sig[i].ext > sig[set].ext + VALLEY_OUT) break;
  }

  // 3. Släpp: en bit in i sträckningen (mellan set point och fullt sträckt arm)
  const mid = sig[set].ext + 0.35 * (sig[full].ext - sig[set].ext); // bollen lämnar handen tidigt i sträckningen
  // Vi går bakåt från fullt sträckt arm och tar första rutan i den sammanhängande
  // sträckningen. Bakåt, så att en skakning tidigare i dalen inte räknas som släppet.
  let release = full;
  for (let i = full; i > set; i--) { if (sig[i].ext < mid) break; release = i; }

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

// ---------------------------------------------------------------- efter släppet
//
// Det som händer efter att bollen lämnat handen – bakåtlutning, framåtdrift, hur man landar –
// har inga riktvärden i rules.js och går inte in i prioriteringen. Måtten här är tillägg, inte
// krav: varje enskilt kan bli null (ingen tydlig landning, för kort klipp, ledpunkt som saknas)
// utan att något kastas. E_NO_SHOT är fortfarande fasdetekteringens ensak.

const AFTER_RELEASE = 0.15;   // sekunder efter släpp som bålens lutning läses av

// Första rutan från och med `from` där fotleden är tillbaka på golvet. Golvet tas som fotledens
// lägsta läge efter hoppets topp, inte som nivån den stod på i början av klippet: spelaren landar
// sällan exakt där hon hoppade, och redan ett par centimeters förflyttning i djupled flyttar
// fotleden i bild mer än landningströskeln är stor. -1 = landar aldrig inom klippet.
function backOnFloor(sig, from, until, pick, lift) {
  let floor = -Infinity;
  for (let i = from; i <= until; i++) floor = Math.max(floor, pick(sig[i]));
  if (!Number.isFinite(floor)) return -1;
  for (let i = from; i < sig.length; i++) if (pick(sig[i]) >= floor - lift) return i;
  return -1;
}

export function postRelease(sig, ph) {
  const out = { landing_ms: null, driftLanding: null, trunkAfterRelease: null, landingSplit_ms: null };
  const { ankleBase, noseBase, bodyPx, fps } = floorLevel(sig);
  const re = sig[ph.release];

  // Skottriktningen: dit den skjutande handleden pekar i förhållande till axeln vid släpp.
  // Allt tecknat nedan mäts i den riktningen, så vänster- och högerhänta får samma tecken.
  const dir = re.wriX >= re.shoX ? 1 : -1;

  // Bålens lutning en bit efter släppet. Negativt = bakåt, bort från korgen.
  const after = ph.release + Math.round(fps * AFTER_RELEASE);
  if (after < sig.length) out.trunkAfterRelease = dir * sig[after].trunkTilt;

  if (ph.takeoff < 0 || !(bodyPx > 0)) return out;   // aldrig i luften: ingen landning att mäta

  const lift = 0.015 * (ankleBase - noseBase);

  // Sökningen börjar i hoppets topp, inte vid frånskjutet: precis efter frånskjutet är foten
  // fortfarande nära golvet och skulle räknas som en landning direkt. Golvet läses av inom 1,5 s
  // efter toppen, så att spelaren hinner landa men inte gå iväg ur bilden först.
  const start = Math.max(ph.apex, ph.release);
  const until = Math.min(sig.length - 1, start + Math.round(fps * 1.5));
  if (until <= start) return out;                    // klippet tar slut i hoppet
  const land = backOnFloor(sig, start, until, f => f.ankleY, lift);
  if (land < 0) return out;                          // klippet tar slut medan spelaren är i luften

  out.landing_ms = Math.round((sig[land].t - sig[ph.takeoff].t) * 1000);
  out.driftLanding = (dir * (sig[land].hipX - sig[ph.takeoff].hipX)) / bodyPx;

  const lS = backOnFloor(sig, start, until, f => f.ankSY, lift);
  const lO = backOnFloor(sig, start, until, f => f.ankOY, lift);
  if (lS >= 0 && lO >= 0) out.landingSplit_ms = Math.round(Math.abs(sig[lS].t - sig[lO].t) * 1000);
  return out;
}

// Hur väl MediaPipe såg de leder varje mätvärde bygger på, i den ruta värdet läses av.
// Ligger här och inte i coach.js därför att det här är lagret som vet vilka leder ett mätvärde
// använder; coach.js tröskar bara på siffran.
export function visibilityByMetric(frames, ph, side) {
  const { S, O } = sideJoints(side);
  const at = (idx, joints) => {
    const lm = frames[idx]?.lm;
    if (!lm) return null;
    let v = 1;
    for (const k of joints) {
      const p = lm[k];
      if (!p) return null;
      if (p.visibility != null) v = Math.min(v, p.visibility);
    }
    return v;
  };
  const legs = [S.hip, S.knee, S.ank, O.hip, O.knee, O.ank];
  const low = (a, b) => (a == null || b == null ? null : Math.min(a, b));
  return {
    kneeMin: at(ph.lowest, legs),
    hipMin: at(ph.lowest, [S.sho, S.hip, S.knee]),
    trunkLowest: at(ph.lowest, [S.sho, S.hip]),
    elbowSet: at(ph.set, [S.sho, S.elb, S.wri]),
    kneeRelease: at(ph.release, legs),
    releaseHeight: at(ph.release, [S.wri, S.ank, O.ank]),
    tLowToRelease: low(at(ph.lowest, legs), at(ph.release, [S.wri])),
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
