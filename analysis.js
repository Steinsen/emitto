// analysis.js – hittar skottets faser och räknar ut mätvärden från ledpunkter.
// Indata: frames = [{t, lm}] där lm är MediaPipe-landmarks (normaliserade 0–1, y nedåt).
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

export function findPhases(sig) {
  const n = sig.length;
  if (n < 10) throw new Error('För få bildrutor – filma minst 2 sekunder.');
  const fps = n / (sig[n - 1].t - sig[0].t || 1);

  // Stående utgångsläge = medianvärden i första 0,3 s
  const head = sig.slice(0, Math.max(3, Math.round(fps * 0.3)));
  const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const ankleBase = median(head.map(f => f.ankleY));
  const noseBase = median(head.map(f => f.noseY));
  const bodyPx = (ankleBase - noseBase) / 0.87; // näsa→fotled ≈ 87 % av kroppslängden

  // 1. Sträckningsfasen: 0,4 s-fönstret där armen sträcks mest
  const win = Math.max(2, Math.round(fps * 0.4));
  let burst = 0, bestRise = -Infinity;
  for (let i = 0; i + win < n; i++) {
    const rise = sig[i + win].ext - sig[i].ext;
    if (rise > bestRise) { bestRise = rise; burst = i; }
  }
  if (bestRise < 0.15) throw new Error('Hittade ingen skottrörelse. Klippet ska innehålla ett helt skott sett från sidan.');

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
