// test.mjs – kör analys och regler mot riktiga klipp och skriver ut vad som blir av dem.
// Kör: node test.mjs [mapp]
//
// Klippens ledpunkter ligger i samples/*_lm.json och är gitignorade, så det här testet går
// bara att köra på en maskin som har dem. Det som inte behöver klipp ligger i test-units.mjs.
//
// Filen skriver ut, den påstår ingenting: facit står i CLAUDE.md (Leo ska hamna inom ramarna
// på tid och knädjup, Jalen ska få "Släpp bollen på vägen upp"). Kör före och efter en ändring
// i analysis.js eller rules.js och jämför utskrifterna – ändras de utan att du menade det, är
// det den ändringen som är fel, inte klippet.
//
// Formatet på en fil: { aspect, leder: [landmarkIndex...], rutor: [{ t, lm: [[x, y]...] }] }
// eller MediaPipes egna ramar: { aspect, frames: [{ t, lm: [{x, y, visibility}...] }] }.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signals, findPhases, metrics, postRelease, pickSide, estimateSpeed, rescaleTime } from './analysis.js';
import { prioritize, issueList, formatValue, labelOf, refOf } from './rules.js';

const dir = process.argv[2] || 'samples';
const LANG = 'sv';

let files = [];
try {
  files = readdirSync(dir).filter(f => f.endsWith('_lm.json')).sort();
} catch {
  console.error(`Hittar ingen mapp ${dir}/. Klippen och deras ledpunkter är gitignorade – ` +
    'lägg dem där, eller peka på en annan mapp: node test.mjs <mapp>');
  process.exit(1);
}
if (!files.length) {
  console.error(`Inga *_lm.json i ${dir}/.`);
  process.exit(1);
}

// Båda formaten in, samma ut: [{ t, lm }] där lm är 33 punkter.
function load(path) {
  const f = JSON.parse(readFileSync(path, 'utf8'));
  if (f.frames) return { aspect: f.aspect, frames: f.frames };
  const frames = f.rutor.map(r => {
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }));
    f.leder.forEach((idx, k) => { lm[idx] = { x: r.lm[k][0], y: r.lm[k][1] }; });
    return { t: r.t, lm };
  });
  return { aspect: f.aspect, frames };
}

for (const file of files) {
  const { aspect, frames } = load(join(dir, file));
  const side = pickSide(frames, 'auto');
  const sig0 = signals(frames, side, aspect);
  const est = estimateSpeed(sig0);
  const factor = est ? est.factor : 1;
  const sig = rescaleTime(sig0, factor);

  console.log(`\n=== ${file} ===`);
  console.log(`${frames.length} rutor, ${sig[sig.length - 1].t.toFixed(2)} s, skjutarm ${side}, ` +
    `hastighet ${factor}× (${est ? `gissad, r² ${est.r2.toFixed(2)}` : 'ingen hoppdata – antar normal fart'})`);

  let ph;
  try {
    ph = findPhases(sig);
  } catch (e) {
    console.log(`  ${e.message}`);
    continue;
  }
  const m = metrics(sig, ph);
  const pr = postRelease(sig, ph);
  const prio = prioritize(m);

  const at = k => (ph[k] >= 0 ? `${sig[ph[k]].t.toFixed(2)} s` : '–');
  console.log(`  faser: lägsta ${at('lowest')}, set ${at('set')}, släpp ${at('release')}, ` +
    `frånskjut ${at('takeoff')}, följning ${at('follow')}`);

  for (const g of prio.graded) {
    const r = refOf(g.key).ok;
    console.log(`  ${g.status.padEnd(5)} ${labelOf(g.key, LANG).padEnd(30)} ` +
      `${formatValue(g.key, g.value, LANG).padStart(12)}   riktvärde ` +
      `${formatValue(g.key, r[0], LANG)}–${formatValue(g.key, r[1], LANG)}`);
  }
  console.log(`  efter släppet: landning ${pr.landing_ms ?? '–'} ms, drift ` +
    `${pr.driftLanding == null ? '–' : pr.driftLanding.toFixed(2)} kroppslängder, bål ` +
    `${pr.trunkAfterRelease == null ? '–' : pr.trunkAfterRelease.toFixed(1)}°, ` +
    `fötterna isär ${pr.landingSplit_ms ?? '–'} ms`);

  const list = issueList(prio, LANG, 5);
  console.log(`  fokus: ${list.length ? list.map((i, n) => `${n + 1}. ${i.key} (${i.title})`).join('  ') : 'inget att anmärka'}`);
}
