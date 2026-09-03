// i18n.js – gränssnittets texter på svenska och engelska.
//
// Bara UI-strängar ligger här. Texterna om mätvärden och feedback bor i rules.js,
// eftersom de hör ihop med riktvärdena de beskriver – ändrar du en gräns ska texten
// bredvid ändras i samma fil.

const STRINGS = {
  sv: {
    tag: 'Skottanalys',
    h1: 'Ett skott. Det viktigaste först.',
    lead: 'Filma från sidan. Du får fyra faser med vinklar, tempot jämfört med hur bra skyttar gör – och en kort lista i den ordning det är värt att jobba på.',
    cta: 'Välj ett klipp',
    instr1: 'Från sidan, i höfthöjd',
    instr2: 'Hela kroppen i bild, även fötterna',
    instr3: '3–5 sekunder, ett skott',
    instr4: 'Håll kameran stilla',
    loadingModel: 'Laddar modellen. Första gången tar några sekunder.',
    loadingAnalyze: 'Letar efter skottet i klippet.',
    loadingFrames: 'Ritar faserna.',
    phasesTitle: 'Fyra faser',
    phaseHint: 'Svep mellan faserna. Tryck på en bild för att se vinklarna.',
    showAngles: 'Visa vinklar',
    hideAngles: 'Dölj vinklar',
    phaseLowest: 'Lägsta läget',
    phaseSet: 'Set point',
    phaseRelease: 'Släpp',
    phaseFollow: 'Följning',
    noMetricsHere: 'Inget riktvärde mäts i den här fasen. Den är med för att du ska se att rörelsen fortsätter efter släppet.',
    workTitle: 'Att jobba på',
    workIntro: 'I den ordningen. Det översta påverkar ofta det som står under.',
    reference: 'riktvärde',
    within: 'inom riktvärdet',
    tooLow: 'under riktvärdet',
    tooHigh: 'över riktvärdet',
    drill: 'Övning',
    newClip: 'Nytt klipp',
    detailsTitle: 'Alla mätvärden',
    caveat: (side, extra) => `Sidovy, 2D-poseskattning, ${side} sida. Vinklar ±5°. Fotställning i bredd syns inte från den här vinkeln. ${extra}`,
    sideRight: 'höger',
    sideLeft: 'vänster',
    extra: (hipVel, lag, fps) => `Höftvinkelhastighet ${hipVel} °/s. Släpp ${lag} frånskjutet. ${fps} analyserade rutor/s.`,
    lagBefore: s => `${s} s före`,
    lagAfter: s => `${s} s efter`,
    lagUnknown: 'okänt i förhållande till',
    errNoPerson: 'Hittade ingen person i klippet. Kontrollera att hela kroppen syns och att klippet är filmat från sidan.',
    errTooFewFrames: 'För få bildrutor – filma minst 2 sekunder.',
    errNoShot: 'Hittade ingen skottrörelse. Klippet ska innehålla ett helt skott sett från sidan.',
    speedLabel: 'Hastighet',
    speedAuto: 'Auto',
    speedNormal: 'Normal',
    speedNormalPhrase: 'normal fart',
    speedFromJump: x => `Analyserad i ${x}. Hastigheten är gissad ur hoppets fria fall.`,
    speedManualNote: x => `Analyserad i ${x}. Hastigheten är vald av dig.`,
    speedAssumed: 'Analyserad i normal fart. Spelaren lämnar inte golvet, så hastigheten gick inte att gissa – välj den själv om klippet är i slow motion.',
    speedRecalc: 'Räknar om i den nya hastigheten.',
    speedHint: 'Slow motion sträcker ut tiden. Lämna på Auto om du är osäker – hastigheten gissas ur hoppet.',
    footer: 'Analysen körs i din webbläsare. Klippet laddas aldrig upp någonstans.',
    langLabel: 'Språk',
  },
  en: {
    tag: 'Shot analysis',
    h1: 'One shot. First things first.',
    lead: 'Film from the side. You get four phases with angles, your timing next to what good shooters do – and a short list in the order worth working on.',
    cta: 'Choose a clip',
    instr1: 'From the side, at hip height',
    instr2: 'Whole body in frame, feet included',
    instr3: '3–5 seconds, one shot',
    instr4: 'Hold the camera still',
    loadingModel: 'Loading the model. The first time takes a few seconds.',
    loadingAnalyze: 'Looking for the shot in the clip.',
    loadingFrames: 'Drawing the phases.',
    phasesTitle: 'Four phases',
    phaseHint: 'Swipe between the phases. Tap an image to see the angles.',
    showAngles: 'Show angles',
    hideAngles: 'Hide angles',
    phaseLowest: 'Lowest point',
    phaseSet: 'Set point',
    phaseRelease: 'Release',
    phaseFollow: 'Follow-through',
    noMetricsHere: 'No reference value is measured in this phase. It is here so you can see that the movement continues after the release.',
    workTitle: 'What to work on',
    workIntro: 'In this order. The top one often causes what sits below it.',
    reference: 'reference',
    within: 'within range',
    tooLow: 'below range',
    tooHigh: 'above range',
    drill: 'Drill',
    newClip: 'New clip',
    detailsTitle: 'All measurements',
    caveat: (side, extra) => `Side view, 2D pose estimate, ${side} side. Angles ±5°. Stance width is not visible from this angle. ${extra}`,
    sideRight: 'right',
    sideLeft: 'left',
    extra: (hipVel, lag, fps) => `Hip angular velocity ${hipVel} °/s. Release ${lag} the take-off. ${fps} frames/s analysed.`,
    lagBefore: s => `${s} s before`,
    lagAfter: s => `${s} s after`,
    lagUnknown: 'unknown relative to',
    errNoPerson: 'No person found in the clip. Check that the whole body is visible and that the clip is filmed from the side.',
    errTooFewFrames: 'Too few frames – film at least 2 seconds.',
    errNoShot: 'No shooting motion found. The clip should contain one complete shot seen from the side.',
    speedLabel: 'Speed',
    speedAuto: 'Auto',
    speedNormal: 'Normal',
    speedNormalPhrase: 'normal speed',
    speedFromJump: x => `Analysed at ${x}. The speed was estimated from the free fall of the jump.`,
    speedManualNote: x => `Analysed at ${x}. You chose the speed.`,
    speedAssumed: 'Analysed at normal speed. The player does not leave the floor, so the speed could not be estimated – pick it yourself if the clip is in slow motion.',
    speedRecalc: 'Recalculating at the new speed.',
    speedHint: 'Slow motion stretches time. Leave it on Auto if unsure – the speed is estimated from the jump.',
    footer: 'The analysis runs in your browser. The clip is never uploaded anywhere.',
    langLabel: 'Language',
  },
};

export const LANGS = ['sv', 'en'];
const KEY = 'emitto.lang';

function detect() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && LANGS.includes(saved)) return saved;
  } catch { /* privat läge – strunt samma, vi gissar från webbläsaren */ }
  return (navigator.languages || [navigator.language || 'sv'])
    .some(l => String(l).toLowerCase().startsWith('sv')) ? 'sv' : 'en';
}

let lang = detect();

export const getLang = () => lang;

export function setLang(l) {
  if (!LANGS.includes(l)) return;
  lang = l;
  document.documentElement.lang = l;
  try { localStorage.setItem(KEY, l); } catch { /* går inte att spara, men språket gäller ändå */ }
}

// t('key') ger strängen. Är värdet en funktion returneras den, så anroparen
// kan fylla i sina egna siffror: t('extra')(a, b, c).
export const t = key => STRINGS[lang][key];

// Fyller alla element med data-i18n. Anropas om vid språkbyte.
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
}
