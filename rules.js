// rules.js – riktvärden, prioritering och feedbacktexter.
// Ändra här, inte i analysis.js. Ordningen i PRIORITY är rörelsekedjan nedifrån och upp:
// det som står först orsakar ofta det som står senare.
//
// Åldersbanden är borttagna. Tidigare valde användaren ålder i gränssnittet och 14 år
// var förvalt, vilket landade i vuxenvärdena – det är alltså de som ligger kvar här, så
// att bedömningen av ett givet klipp är oförändrad. Ungdomsvärdena var ändå bara vidgade
// vuxenvärden utan stöd i data. Kalibrera mot egna klipp innan du delar upp dem igen.

// [lågt ok, högt ok] och tolerans = hur långt utanför som fortfarande är "gult".
// Bygger på studier av trepoängsskyttar (knä ~94°, hög höftvinkelhastighet,
// släpphöjd ~1,2× kroppslängd).
const REF = {
  kneeMin:       { ok: [85, 110],    tol: 12,   unit: '°',        label: { sv: 'Knädjup i lägsta läget', en: 'Knee bend at the lowest point' } },
  tLowToRelease: { ok: [0.5, 0.9],   tol: 0.2,  unit: 's',        label: { sv: 'Tid lägsta läge → släpp', en: 'Time from lowest point to release' } },
  kneeRelease:   { ok: [130, 168],   tol: 8,    unit: '°',        label: { sv: 'Knävinkel vid släpp', en: 'Knee angle at release' }, dec: 0 },
  trunkLowest:   { ok: [15, 35],     tol: 10,   unit: '°',        label: { sv: 'Bållutning i lägsta läget', en: 'Trunk lean at the lowest point' } },
  elbowSet:      { ok: [80, 105],    tol: 12,   unit: '°',        label: { sv: 'Armbåge i set point', en: 'Elbow at the set point' } },
  releaseHeight: { ok: [1.15, 1.35], tol: 0.08, unit: { sv: '× längd', en: '× height' }, label: { sv: 'Släpphöjd', en: 'Release height' }, dec: 2 },
};

// Rörelsekedjan. Ett problem tidigt i listan skapar ofta symtomen längre ner.
const PRIORITY = ['kneeMin', 'tLowToRelease', 'kneeRelease', 'trunkLowest', 'elbowSet', 'releaseHeight'];

// Vilken fas mätvärdet läses av i. Används för att visa rätt vinklar på rätt bild.
export const METRIC_PHASE = {
  kneeMin: 'lowest', trunkLowest: 'lowest',
  elbowSet: 'set',
  tLowToRelease: 'release', kneeRelease: 'release', releaseHeight: 'release',
};

export const refOf = key => REF[key];
export const labelOf = (key, lang) => REF[key].label[lang];
export const unitIn = (key, lang) => (typeof REF[key].unit === 'string' ? REF[key].unit : REF[key].unit[lang]);

export function grade(key, value) {
  const r = REF[key];
  if (value == null || Number.isNaN(value)) return { status: 'na', severity: 0, ref: r };
  let dev = 0;
  if (value < r.ok[0]) dev = r.ok[0] - value;
  else if (value > r.ok[1]) dev = value - r.ok[1];
  const severity = dev / r.tol; // 0 = inom, 1 = toleransgränsen, 2+ = tydligt utanför
  const status = severity === 0 ? 'good' : severity <= 1 ? 'meh' : 'poor';
  return { status, severity, ref: r, dir: value < r.ok[0] ? 'low' : value > r.ok[1] ? 'high' : 'in' };
}

// Ordningen är rörelsekedjan, inte hur illa det ser ut. Ett avvikande knädjup står
// före en avvikande armbåge även om armbågen avviker mer, eftersom benen ofta är
// orsaken. Undantag: avviker något längre ner mer än dubbelt så mycket lyfts det
// först. Ordningen är deterministisk och ska förbli det.
export function prioritize(m) {
  const graded = PRIORITY.map(k => ({ key: k, value: m[k], ...grade(k, m[k]) }))
    .filter(g => g.status !== 'na');
  const issues = graded.filter(g => g.severity > 0);
  const ordered = [...issues];
  for (let i = 1; i < ordered.length; i++) {
    const g = ordered[i];
    if (g.severity >= 2 * Math.max(ordered[0].severity, 0.5) && g.severity >= 1.5) {
      ordered.splice(i, 1);
      ordered.unshift(g);
    }
  }
  return { graded, issues: ordered, focus: ordered[0] || null };
}

// Texter. Varje mätvärde har en rubrik, ett varför, en övning och en peppning
// per riktning och språk.
const TEXT = {
  kneeMin: {
    low: {
      sv: { title: 'Gå inte ner så djupt', why: 'Ett riktigt djupt knäböj tar tid och gör skottet segt. Kraften kommer från ett snabbt, medeldjupt böj – inte från att sätta sig ner.', drill: 'Skjut 10 skott och tänk "fjädra", inte "sätt dig". Stanna aldrig i botten.', pep: 'Du har uppenbarligen benstyrkan. Nu handlar det bara om att använda mindre av den, snabbare.' },
      en: { title: 'Do not go down so deep', why: 'A really deep bend takes time and makes the shot sluggish. The power comes from a fast, medium-deep bend – not from sitting down.', drill: 'Shoot 10 shots thinking "spring", not "sit". Never pause at the bottom.', pep: 'You clearly have the leg strength. Now it is just about using less of it, faster.' },
    },
    high: {
      sv: { title: 'Ladda benen mer', why: 'Kraften i ett långt skott kommer nerifrån. Utan djup i knäna måste armen kasta, och då blir bågen låg och skotten korta när du blir trött.', drill: 'Ta 10 skott där du går ner tills du känner låren jobba innan du går upp. Räkna hur många som når fram utan att armen behöver ta i.', pep: 'Det här är den ändring som brukar ge mest på kortast tid. Räckvidden sitter i benen.' },
      en: { title: 'Load your legs more', why: 'The power in a long shot comes from below. Without knee bend the arm has to throw, which flattens the arc and leaves shots short once you tire.', drill: 'Take 10 shots going down until you feel your thighs work before you rise. Count how many reach without the arm straining.', pep: 'This is the change that usually pays off fastest. Range lives in the legs.' },
    },
  },
  tLowToRelease: {
    low: {
      sv: { title: 'Ta ett halvt andetag till', why: 'Skottet går väldigt snabbt från botten till släpp. Det fungerar när du är utvilad, men blir svårt att upprepa när benen är trötta.', drill: 'Skjut 10 skott och känn efter att du kommer till samma djup varje gång. Konsekvens slår hastighet.', pep: 'Ett snabbt släpp är en tillgång. Vi vill bara att det ska se likadant ut i fjärde perioden.' },
      en: { title: 'Take half a breath more', why: 'The shot goes very fast from the bottom to the release. That works when you are fresh, but it is hard to repeat when your legs are tired.', drill: 'Shoot 10 shots and check that you reach the same depth every time. Consistency beats speed.', pep: 'A quick release is an asset. We just want it to look the same in the fourth quarter.' },
    },
    high: {
      sv: { title: 'Släpp bollen på vägen upp', why: 'Bollen stannar vid huvudet innan benen sträcks. Då tappar du en del av benkraften och armen får jobba mer än den behöver.', drill: 'Fånga – dippa – upp – släpp i ett andetag. Bollen ska lämna handen innan benen är helt raka.', pep: 'Rörelsen finns redan, den är bara delad i två. Sätter du ihop den kommer räckvidden gratis.' },
      en: { title: 'Release on the way up', why: 'The ball pauses at your head before the legs extend. You lose part of the leg drive and the arm has to work harder than it needs to.', drill: 'Catch – dip – up – release in one breath. The ball should leave your hand before your legs are straight.', pep: 'The motion is already there, it is just split in two. Join it up and the range comes for free.' },
    },
  },
  kneeRelease: {
    low: {
      sv: { title: 'Sträck benen mer innan släppet', why: 'Bollen lämnar handen medan benen fortfarande är ganska böjda. Skottet blir känsligt för minsta variation i benkraften.', drill: 'Skjut 10 skott och känn att benen driver dig upp innan bollen lämnar handen.', pep: 'Små justeringar här ger stor skillnad i träffsäkerhet på distans.' },
      en: { title: 'Extend your legs more before releasing', why: 'The ball leaves your hand while your legs are still quite bent. That makes the shot sensitive to the smallest change in leg drive.', drill: 'Shoot 10 shots and feel your legs drive you up before the ball leaves your hand.', pep: 'Small adjustments here make a big difference to accuracy from distance.' },
    },
    high: {
      sv: { title: 'Släpp bollen tidigare', why: 'Benen är helt raka när bollen släpps – benkraften har redan tagit slut. Släppet ska ske medan du fortfarande är på väg upp.', drill: 'Skjut 10 skott och släpp bollen "för tidigt". Det som känns för tidigt är oftast lagom.', pep: 'Du använder redan benen ordentligt. Det handlar bara om att bollen ska lämna handen lite tidigare.' },
      en: { title: 'Release the ball earlier', why: 'Your legs are fully straight at release – the leg drive is already spent. The release should happen while you are still rising.', drill: 'Shoot 10 shots and release "too early". What feels too early is usually about right.', pep: 'You are already using your legs well. It is only about letting the ball go a little sooner.' },
    },
  },
  trunkLowest: {
    low: {
      sv: { title: 'Luta överkroppen lite framåt i laddningen', why: 'Med helt rak bål i det lägsta läget blir det svårt att få med höften i skottet, och kraften stannar i benen.', drill: 'Tänk "bröstet över knäna" när du går ner, sedan upp och rak i släppet.', pep: 'Balansen ser stabil ut. Lite mer framåt i botten så följer höften med.' },
      en: { title: 'Lean your upper body forward a little as you load', why: 'With a completely upright trunk at the lowest point it is hard to get the hips into the shot, and the power stays in your legs.', drill: 'Think "chest over knees" as you go down, then up and tall at the release.', pep: 'Your balance looks solid. A little more forward at the bottom and the hips join in.' },
    },
    high: {
      sv: { title: 'Håll överkroppen mer upprätt', why: 'Du lutar mycket framåt i botten. Då måste du räta upp dig på vägen upp, och skottet går lätt bakåt eller kort.', drill: 'Gå ner med bröstet upp, som om du satte dig på en hög stol.', pep: 'Du laddar med hela kroppen, det är rätt tänkt. Rikta bara kraften rakt uppåt.' },
      en: { title: 'Keep your upper body more upright', why: 'You lean well forward at the bottom, so you have to straighten up on the way. The shot easily drifts long or falls short.', drill: 'Go down with your chest up, as if sitting on a tall stool.', pep: 'You load with the whole body, which is the right idea. Just aim that power straight up.' },
    },
  },
  elbowSet: {
    low: {
      sv: { title: 'Öppna armbågen lite i set point', why: 'En väldigt spetsig armbåge gör att bollen ligger nära huvudet och sträckningen blir kort och ryckig.', drill: 'Håll bollen så att du ser korgen under bollen, inte bakom den.', pep: 'Armbågsvinkeln är det brusigaste måttet i appen – kolla den mot en spegel innan du ändrar mycket.' },
      en: { title: 'Open your elbow a little at the set point', why: 'A very tight elbow keeps the ball close to your head and makes the extension short and jerky.', drill: 'Hold the ball so you see the rim under it, not behind it.', pep: 'Elbow angle is the noisiest measurement in this app – check it in a mirror before changing much.' },
    },
    high: {
      sv: { title: 'Armbågen under bollen', why: 'Armbågen är för öppen i set point – bollen är på väg framåt innan sträckningen börjar, vilket ger platt båge.', drill: 'Stanna i set point framför spegeln: armbågen under bollen, underarmen nästan lodrät.', pep: 'Armbågsvinkeln är det brusigaste måttet i appen – kolla den mot en spegel innan du ändrar mycket.' },
      en: { title: 'Elbow under the ball', why: 'The elbow is too open at the set point – the ball travels forward before the extension starts, which flattens the arc.', drill: 'Freeze at the set point in front of a mirror: elbow under the ball, forearm near vertical.', pep: 'Elbow angle is the noisiest measurement in this app – check it in a mirror before changing much.' },
    },
  },
  releaseHeight: {
    low: {
      sv: { title: 'Släpp bollen högre', why: 'Ett högre släpp ger bättre båge och gör skottet svårare att blocka.', drill: 'Sträck armen helt och håll följningen tills bollen träffar nätet.', pep: 'Det här kommer nästan av sig självt när tempot och benen sitter.' },
      en: { title: 'Release the ball higher', why: 'A higher release gives a better arc and makes the shot harder to block.', drill: 'Extend the arm fully and hold the follow-through until the ball hits the net.', pep: 'This tends to come on its own once the timing and the legs are in place.' },
    },
    high: {
      sv: { title: 'Bra höjd på släppet', why: 'Släppunkten är hög. Se bara till att den inte kostar tempo.', drill: 'Behåll höjden, jobba på tempot.', pep: 'Höjden är en fördel. Släpp inte den för att jaga något annat.' },
      en: { title: 'Good release height', why: 'Your release point is high. Just make sure it does not cost you tempo.', drill: 'Keep the height, work on the tempo.', pep: 'The height is an advantage. Do not give it up chasing something else.' },
    },
  },
};

const ALL_CLEAR = {
  sv: { title: 'Tekniken sitter – gör den likadan varje gång', why: 'Inget mätvärde sticker ut. Nu handlar det om repeterbarhet: samma djup, samma tempo, oavsett om det är första eller femtionde skottet.', drill: '10 skott utvilad, spring två längder, 10 skott till. Målet är att andra omgången ser ut som den första.', pep: 'Det här är ett bra läge att vara i. Håll i det.' },
  en: { title: 'The technique holds – now make it repeatable', why: 'No measurement stands out. From here it is about repeatability: same depth, same tempo, whether it is the first shot or the fiftieth.', drill: '10 shots fresh, run two lengths, 10 more. The goal is for the second set to look like the first.', pep: 'This is a good place to be. Hold on to it.' },
};

export const allClear = lang => ALL_CLEAR[lang];

export function goodNote(prio, lang) {
  const ok = prio.graded.filter(g => g.severity === 0).length;
  return lang === 'sv'
    ? (ok ? `${ok} av ${prio.graded.length} mätvärden ligger inom riktvärdena.` : 'Vi mätte hela rörelsen och har hittat vad som är värt att börja med.')
    : (ok ? `${ok} of ${prio.graded.length} measurements sit inside the reference range.` : 'We measured the whole motion and found where to start.');
}

// Upp till max saker att jobba på, i prioriterad ordning.
// Listan fylls aldrig ut med påhittade fel: finns bara två avvikelser blir den två lång.
export function issueList(prio, lang, max = 5) {
  return prio.issues.slice(0, max).map(i => ({ ...i, ...TEXT[i.key][i.dir][lang] }));
}
