// test-units.mjs – kontroller som inte behöver testklipp.
// Kör: node test-units.mjs
//
// Facittestet mot samples/*_lm.json (Leo och Jalen) är ett annat test och kräver
// klippen. Det här körs var som helst och täcker det som går att räkna på syntetiska
// data: hastighetsgissningen, prioriteringsordningen och att språken har samma nycklar.

import { readFileSync } from 'node:fs';
import { estimateSpeed } from './analysis.js';
import { prioritize, issueList } from './rules.js';

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
