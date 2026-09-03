// rules.js – referensvärden per åldersband, prioritering och feedbacktexter.
// Ändra här, inte i analysis.js. Ordningen i PRIORITY är rörelsekedjan nedifrån och upp:
// det som står först orsakar ofta det som står senare.

export function band(age) {
  if (age < 10) return 'child';
  if (age < 14) return 'youth';
  return 'adult';
}

// [lågt ok, högt ok] och tolerans = hur långt utanför som fortfarande är "gult".
// Vuxenvärdena bygger på studier av trepoängsskyttar (knä ~94°, hög höftvinkelhastighet,
// släpphöjd ~1,2× kroppslängd). Ungdomsvärdena är vidare och bör kalibreras mot egna data.
const REF = {
  adult: {
    kneeMin:       { ok: [85, 110],  tol: 12, unit: '°', label: 'Knädjup i lägsta läget' },
    tLowToRelease: { ok: [0.5, 0.9], tol: 0.2, unit: 's', label: 'Tid lägsta läge → släpp' },
    kneeRelease:   { ok: [130, 168], tol: 8,  unit: '°', label: 'Knävinkel vid släpp', dec: 0 },
    trunkLowest:   { ok: [15, 35],   tol: 10, unit: '°', label: 'Bållutning i lägsta läget' },
    elbowSet:      { ok: [80, 105],  tol: 12, unit: '°', label: 'Armbåge i set point' },
    releaseHeight: { ok: [1.15, 1.35], tol: 0.08, unit: '× längd', label: 'Släpphöjd', dec: 2 },
  },
  youth: {
    kneeMin:       { ok: [85, 115],  tol: 15, unit: '°', label: 'Knädjup i lägsta läget' },
    tLowToRelease: { ok: [0.5, 1.0], tol: 0.25, unit: 's', label: 'Tid lägsta läge → släpp' },
    kneeRelease:   { ok: [125, 170], tol: 10, unit: '°', label: 'Knävinkel vid släpp', dec: 0 },
    trunkLowest:   { ok: [15, 40],   tol: 12, unit: '°', label: 'Bållutning i lägsta läget' },
    elbowSet:      { ok: [75, 110],  tol: 15, unit: '°', label: 'Armbåge i set point' },
    releaseHeight: { ok: [1.05, 1.35], tol: 0.1, unit: '× längd', label: 'Släpphöjd', dec: 2 },
  },
};
REF.child = REF.youth; // mäts men bedöms inte – se feedback()

// Rörelsekedjan. Ett problem tidigt i listan skapar ofta symtomen längre ner.
const PRIORITY = ['kneeMin', 'tLowToRelease', 'kneeRelease', 'trunkLowest', 'elbowSet', 'releaseHeight'];

export function grade(key, value, b) {
  const r = REF[b][key];
  if (value == null || Number.isNaN(value)) return { status: 'na', severity: 0, ref: r };
  let dev = 0;
  if (value < r.ok[0]) dev = r.ok[0] - value;
  else if (value > r.ok[1]) dev = value - r.ok[1];
  const severity = dev / r.tol; // 0 = inom, 1 = toleransgränsen, 2+ = tydligt utanför
  const status = severity === 0 ? 'good' : severity <= 1 ? 'meh' : 'poor';
  return { status, severity, ref: r, dir: value < r.ok[0] ? 'low' : value > r.ok[1] ? 'high' : 'in' };
}

// Väljer EN sak att jobba på. Regel: första avvikelsen i rörelsekedjan vinner,
// om inte något längre ner avviker mer än dubbelt så mycket.
export function prioritize(m, b) {
  const graded = PRIORITY.map(k => ({ key: k, value: m[k], ...grade(k, m[k], b) }))
    .filter(g => g.status !== 'na');
  const issues = graded.filter(g => g.severity > 0);
  let focus = null;
  for (const g of issues) {
    if (!focus) { focus = g; continue; }
    if (g.severity >= 2 * Math.max(focus.severity, 0.5) && g.severity >= 1.5) focus = g;
  }
  // Hoppregeln kan bara flytta fokus nedåt i kedjan från den första avvikelsen, aldrig hoppa över en allvarlig.
  return { graded, issues, focus };
}

// Texter. Varje mätvärde har en cue och en övning per riktning.
const TEXT = {
  kneeMin: {
    low: { title: 'Gå inte ner så djupt', why: 'Ett riktigt djupt knäböj tar tid och gör skottet segt. Kraften kommer från ett snabbt, medeldjupt böj.', drill: 'Skjut 10 skott och tänk "fjädra", inte "sätt dig". Stanna aldrig i botten.' },
    high: { title: 'Ladda benen mer', why: 'Kraften i ett trepoängsskott kommer nerifrån. Utan djup i knäna måste armen kasta, och då blir bågen låg och skotten korta.', drill: 'Ta 10 skott där du går ner tills du känner låren jobba innan du går upp. Räkna hur många som når fram utan att armen behöver ta i.' },
  },
  tLowToRelease: {
    low: { title: 'Ta ett halvt andetag till', why: 'Skottet går väldigt snabbt från botten till släpp. Bra när du är utvilad, men det blir svårt att göra likadant när benen är trötta.', drill: 'Skjut 10 skott och känn efter att du kommer till samma djup varje gång. Konsekvens slår hastighet.' },
    high: { title: 'Släpp bollen på vägen upp', why: 'Bollen stannar vid huvudet innan benen sträcks. Då tappar du en del av benkraften och armen får jobba mer.', drill: 'Catch – dip – upp – släpp i ett andetag. Bollen ska lämna handen innan benen är helt raka.' },
  },
  kneeRelease: {
    low: { title: 'Sträck benen mer innan släppet', why: 'Bollen lämnar handen medan benen fortfarande är ganska böjda. Skottet blir känsligt för minsta variation i benkraften.', drill: 'Skjut 10 skott och känn att benen driver dig upp innan bollen lämnar handen.' },
    high: { title: 'Släpp bollen tidigare', why: 'Benen är helt raka när bollen släpps – benkraften har redan försvunnit. Släppet ska ske medan du fortfarande är på väg upp.', drill: 'Skjut 10 skott och släpp bollen "för tidigt". Det som känns för tidigt är oftast lagom.' },
  },
  trunkLowest: {
    low: { title: 'Luta överkroppen lite framåt i laddningen', why: 'Med helt rak bål i det lägsta läget blir det svårt att få med höften i skottet.', drill: 'Tänk "bröstet över knäna" när du går ner, sedan upp och rak i släppet.' },
    high: { title: 'Håll överkroppen mer upprätt', why: 'Du lutar mycket framåt i botten. Då måste du räta upp dig på vägen upp och skottet går lätt bakåt eller kort.', drill: 'Gå ner med bröstet upp, som om du satte dig på en hög stol.' },
  },
  elbowSet: {
    low: { title: 'Öppna armbågen lite i set point', why: 'Väldigt spetsig armbåge gör att bollen ligger nära huvudet och sträckningen blir kort och ryckig.', drill: 'Håll bollen så att du ser korgen under bollen, inte bakom den.' },
    high: { title: 'Armbågen under bollen', why: 'Armbågen är för öppen i set point – bollen är på väg framåt innan sträckningen börjar, vilket ger platt båge.', drill: 'Stanna i set point framför spegeln: armbågen under bollen, underarmen nästan lodrät.' },
  },
  releaseHeight: {
    low: { title: 'Släpp bollen högre', why: 'Ett högre släpp ger bättre båge och gör skottet svårare att blocka.', drill: 'Sträck armen helt och håll följningen tills bollen träffar nätet.' },
    high: { title: 'Bra höjd på släppet', why: 'Släpppunkten är hög. Se bara till att den inte kostar tempo.', drill: 'Behåll höjden, jobba på tempot.' },
  },
};

export function feedback(prio, b) {
  if (b === 'child') {
    return {
      kicker: 'Bra jobbat',
      title: 'Skjut mycket, ha kul',
      why: 'I den här åldern mäter vi men bedömer inte – kroppen växer och tekniken kommer att ändras av sig själv. Det enda som spelar roll: använd benen och skjut med båge.',
      drill: 'Skjut 10 skott och tänk "benen först". Räkna hur många som går i.',
    };
  }
  if (!prio.focus) {
    return {
      kicker: 'Allt inom ramarna',
      title: 'Tekniken sitter – gör den likadan varje gång',
      why: 'Inget mätvärde sticker ut. Nu handlar det om repeterbarhet: samma djup, samma tempo, oavsett om det är första eller femtionde skottet.',
      drill: '10 skott utvilad, spring två längder, 10 skott till. Målet är att andra omgången ser ut som den första.',
    };
  }
  const t = TEXT[prio.focus.key][prio.focus.dir];
  return { kicker: 'Fokus just nu', ...t };
}

export function secondary(prio) {
  return prio.issues.filter(i => i !== prio.focus).map(i => ({ ...i, text: TEXT[i.key][i.dir] }));
}
