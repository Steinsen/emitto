// share.js – gör resultatet till något man kan skicka till sin tränare.
//
// Två format, för två olika saker:
//   bild (JPEG)  – hamnar direkt i chatten, syns utan att någon behöver öppna en fil.
//                  Faserna, listan och alla mätvärden, ingen text som fälls ut.
//   sida (HTML)  – hela rapporten med varför, övning och pepp, i en enda fil utan
//                  externa anrop. Att spara, maila eller lägga i spelarens mapp.
//
// Båda skapas på enheten av rutor som redan är avlästa. Ingenting laddas upp: det är
// användaren som väljer att skicka bilderna, och då är det bilder – aldrig klippet.
//
// Vet inget om riktvärden eller fasdetektering. Siffror och texter kommer från rules.js,
// gränssnittets ord från i18n.js, och faserna ritas av samma kod som skärmen använder.

import { t, getLang } from './i18n.js';
import { issueList as rulesIssues, goodNote, allClear, labelOf, refOf, formatValue, METRIC_PHASE } from './rules.js';
import { drawFrame, personCrop, roundRect, STATUS_COLOR, ARC } from './draw.js';
import { merge } from './coach.js';

// Listan är rules.js ordning, med modellens ord ovanpå där nyckeln stämmer – samma merge som
// resultatvyn använder, så att det som delas är ordagrant det som visades på skärmen.
const issueList = (prio, lang, max, coach) => merge(rulesIssues(prio, lang, max), coach || null);

const W = 1080, PAD = 56, GAP = 22;
const INK = '#10262E', SOFT = '#4F6169', LINE = '#D8E0E3', PAPER = '#FFFFFF';
const BALL = '#FF6A2B', COURT = '#EAF0F2', PEACH = '#FFB48E';
const COND = '"Barlow Condensed", "Arial Narrow", sans-serif';
const BODY = 'Barlow, system-ui, sans-serif';
const font = (weight, size, family = BODY) => `${weight} ${size}px ${family}`;

const byPhase = prio => {
  const out = {};
  for (const g of prio.graded) (out[METRIC_PHASE[g.key]] ||= []).push(g);
  return out;
};

const locale = lang => (lang === 'sv' ? 'sv-SE' : 'en-GB');
const dateText = lang => new Date().toLocaleDateString(locale(lang), { day: 'numeric', month: 'long', year: 'numeric' });

export function stamp(ext) {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `emitto-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

// ---------------------------------------------------------------- gemensamt

// Canvas ritar med de typsnitt som redan är laddade – inte med dem som är på väg. Utan
// det här kan delningsbilden få systemtypsnitt fastän sidan visar Barlow.
async function fontsReady() {
  if (!document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load(`600 40px ${COND}`),
      document.fonts.load(`600 28px ${BODY}`),
      document.fonts.load(`400 24px ${BODY}`),
    ]);
    await document.fonts.ready;
  } catch { /* systemtypsnitt får duga hellre än ingen bild alls */ }
}

// Ordmärket. Hämtas som text, dels för att ritas på canvas, dels för att läggas in rakt
// i den fristående sidan – då slipper den ett externt anrop för att visa logotypen.
let logoText = null;
async function logoSource() {
  if (logoText == null) {
    const res = await fetch('logo.svg');
    if (!res.ok) throw new Error('E_LOGO');
    // Firefox ritar bara SVG på canvas när bilden har både bredd och höjd.
    logoText = (await res.text()).replace('<svg ', '<svg width="245" ');
  }
  return logoText;
}

async function loadLogo() {
  try {
    const url = URL.createObjectURL(new Blob([await logoSource()], { type: 'image/svg+xml' }));
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return img;
  } catch {
    return null;   // ritas som text i stället, hellre än ingen bild alls
  }
}

function wrap(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = word; }
      else line = next;
    }
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------- bilden
//
// Höjden är inte känd i förväg: den beror på hur många rader listan får och hur texten
// bryts. Därför mäts allt först mot samma canvas som sedan ritas – varje del lämnar sin
// höjd och en ritfunktion – och först när summan är klar sätts canvasens höjd.

export async function shareImage(data, notes) {
  const { shots, side, aspect, prio } = data;
  const lang = getLang();
  await fontsReady();
  const logo = await loadLogo();

  const canvas = document.createElement('canvas');
  canvas.width = W;
  const m = canvas.getContext('2d');
  const ops = [];
  let y = PAD;
  const add = (h, draw) => { const at = y; ops.push(ctx => draw(ctx, at)); y += h; };
  const inner = W - 2 * PAD;

  const heading = text => add(58, (ctx, at) => {
    ctx.fillStyle = INK; ctx.font = font(600, 40, COND); ctx.textBaseline = 'top';
    ctx.fillText(text, PAD, at);
  });

  const quiet = (text, size = 24, color = SOFT) => {
    m.font = font(400, size);
    const lines = wrap(m, text, inner);
    add(lines.length * (size + 10) + 8, (ctx, at) => {
      ctx.fillStyle = color; ctx.font = font(400, size); ctx.textBaseline = 'top';
      lines.forEach((l, i) => ctx.fillText(l, PAD, at + i * (size + 10)));
    });
  };

  // Märket och dagens datum
  const logoH = 54;
  add(logoH + 30, (ctx, at) => {
    if (logo) ctx.drawImage(logo, PAD, at, logoH * (logo.width / logo.height), logoH);
    else {
      ctx.fillStyle = INK; ctx.font = font(600, 48, COND); ctx.textBaseline = 'top';
      ctx.fillText('Emitto', PAD, at);
    }
    ctx.fillStyle = SOFT; ctx.font = font(400, 24); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(dateText(lang), W - PAD, at + logoH / 2);
    ctx.textAlign = 'left';
  });

  // Faserna, två och två. Utsnittet följer spelaren, annars blir kroppen för liten här.
  const cellW = (inner - GAP) / 2;
  const imgH = Math.round(cellW * 4 / 3);
  const capH = 64;
  const groups = byPhase(prio);
  heading(t('phasesTitle'));
  for (let row = 0; row * 2 < shots.length; row++) {
    add(imgH + capH + GAP, (ctx, at) => {
      for (let col = 0; col < 2; col++) {
        const shot = shots[row * 2 + col];
        if (!shot) continue;
        const x = PAD + col * (cellW + GAP);
        ctx.save();
        roundRect(ctx, x, at, cellW, imgH + capH, 14);
        ctx.clip();
        ctx.fillStyle = INK;
        ctx.fillRect(x, at, cellW, imgH + capH);
        const arcs = (groups[shot.key] || []).filter(g => ARC[g.key]);
        drawFrame(ctx, shot.canvas, { x, y: at, w: cellW, h: imgH }, shot.lm, side, arcs,
          personCrop(shot.lm, aspect, cellW / imgH));
        ctx.fillStyle = '#fff'; ctx.font = font(600, 30, COND); ctx.textBaseline = 'middle';
        ctx.fillText(t(shot.label), x + 18, at + imgH + capH / 2);
        ctx.fillStyle = PEACH; ctx.font = font(400, 22); ctx.textAlign = 'right';
        ctx.fillText(`${shot.time.toFixed(2)} s`, x + cellW - 18, at + imgH + capH / 2 + 1);
        ctx.textAlign = 'left';
        ctx.restore();
      }
    });
  }

  // Att jobba på. Bilden är det som faktiskt hamnar i en chatt, och en bildtext överlever inte
  // vägen dit – därför bär bilden hela texten: varje punkt med sitt varför, ettan med sin övning.
  heading(t('workTitle'));
  quiet(goodNote(prio, lang));
  if (data.coach?.summary) quiet(data.coach.summary, 25, INK);
  const issues = issueList(prio, lang, 5, data.coach);
  if (!issues.length) {
    const a = allClear(lang);
    m.font = font(600, 34, COND);
    const title = wrap(m, a.title, inner - 44);
    m.font = font(400, 24);
    const why = wrap(m, a.why, inner - 44);
    const h = 30 + title.length * 40 + why.length * 34 + 26;
    add(h + 12, (ctx, at) => {
      ctx.fillStyle = INK;
      roundRect(ctx, PAD, at, inner, h, 14);
      ctx.fill();
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#fff'; ctx.font = font(600, 34, COND);
      title.forEach((l, i) => ctx.fillText(l, PAD + 22, at + 24 + i * 40));
      ctx.fillStyle = '#DCE5E9'; ctx.font = font(400, 24);
      why.forEach((l, i) => ctx.fillText(l, PAD + 22, at + 30 + title.length * 40 + i * 34));
    });
  } else {
    issues.forEach((it, i) => {
      const textW = inner - 60;
      m.font = font(600, 28);
      const title = wrap(m, it.title, textW);
      m.font = font(400, 24);
      const why = wrap(m, [i === 0 ? it.what : null, it.why].filter(Boolean).join(' '), textW);
      const drill = i === 0 ? wrap(m, `${t('drill')}: ${it.drill}`, textW) : [];
      const bodyH = why.length * 32 + (drill.length ? 6 + drill.length * 32 : 0);
      const h = 20 + title.length * 38 + (bodyH ? 6 + bodyH : 0) + 18;
      add(h, (ctx, at) => {
        ctx.fillStyle = i === 0 ? BALL : COURT;
        ctx.beginPath();
        ctx.arc(PAD + 17, at + 34, 17, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = i === 0 ? '#fff' : SOFT;
        ctx.font = font(600, 24, COND);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), PAD + 17, at + 35);
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillStyle = INK; ctx.font = font(600, 28);
        title.forEach((l, k) => ctx.fillText(l, PAD + 60, at + 20 + k * 38));
        ctx.fillStyle = SOFT; ctx.font = font(400, 24);
        const top = at + 26 + title.length * 38;
        why.forEach((l, k) => ctx.fillText(l, PAD + 60, top + k * 32));
        drill.forEach((l, k) => ctx.fillText(l, PAD + 60, top + (why.length + k) * 32 + 6));
        ctx.strokeStyle = LINE; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD, at + h - 0.5); ctx.lineTo(W - PAD, at + h - 0.5); ctx.stroke();
      });
    });
  }

  // Efter släppet: egen ruta, som i appen. Aldrig en rad i listan – listan är rules.js.
  if (data.coach?.after) {
    const a = data.coach.after;
    const textW = inner - 44;
    m.font = font(600, 28, COND);
    const head = wrap(m, `${t('afterTitle')} – ${a.title}`, textW);
    m.font = font(400, 24);
    const body = wrap(m, a.text, textW);
    const h = 22 + head.length * 34 + 6 + body.length * 32 + 20;
    add(h + 16, (ctx, at) => {
      ctx.strokeStyle = LINE; ctx.lineWidth = 1;
      roundRect(ctx, PAD + 0.5, at + 0.5, inner - 1, h - 1, 14);
      ctx.stroke();
      ctx.textBaseline = 'top';
      ctx.fillStyle = INK; ctx.font = font(600, 28, COND);
      head.forEach((l, i) => ctx.fillText(l, PAD + 22, at + 20 + i * 34));
      ctx.fillStyle = SOFT; ctx.font = font(400, 24);
      body.forEach((l, i) => ctx.fillText(l, PAD + 22, at + 28 + head.length * 34 + i * 32));
    });
  }

  // Alla mätvärden, med riktvärdet bredvid. Det är den här delen en tränare läser först.
  add(18, () => {});
  heading(t('detailsTitle'));
  for (const g of prio.graded) {
    add(86, (ctx, at) => {
      ctx.fillStyle = STATUS_COLOR[g.status];
      ctx.beginPath(); ctx.arc(PAD + 7, at + 26, 7, 0, Math.PI * 2); ctx.fill();
      ctx.textBaseline = 'top';
      ctx.fillStyle = INK; ctx.font = font(600, 26);
      ctx.fillText(labelOf(g.key, lang), PAD + 30, at + 12);
      ctx.fillStyle = SOFT; ctx.font = font(400, 21);
      const r = refOf(g.key);
      ctx.fillText(`${t('reference')} ${formatValue(g.key, r.ok[0], lang)}–${formatValue(g.key, r.ok[1], lang)}`, PAD + 30, at + 46);
      ctx.fillStyle = INK; ctx.font = font(600, 34, COND);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(formatValue(g.key, g.value, lang), W - PAD, at + 34);
      ctx.textAlign = 'left';
      ctx.strokeStyle = LINE; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD, at + 85.5); ctx.lineTo(W - PAD, at + 85.5); ctx.stroke();
    });
  }

  add(20, () => {});
  quiet(notes.speed, 21);
  if (notes.caveat) quiet(notes.caveat, 21);
  quiet(`${t('footer')} · ${location.host}`, 21);

  canvas.height = Math.round(y + PAD);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, canvas.height);
  for (const op of ops) op(ctx);
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
}

// ---------------------------------------------------------------- texten
//
// Samma innehåll som bilden, men som ren text: den går att klistra in i en chatt, svara på och
// citera. Bilden är förstahandsvalet eftersom den syns direkt; texten finns för den som hellre
// skriver tillbaka än tittar.
//
// Ingen markdown, inga tecken som ser trasiga ut i en chattbubbla. Raderna hålls korta.

const line = (label, value) => `${label}: ${value}`;

export function reportText(data, notes) {
  const { prio, coach } = data;
  const lang = getLang();
  const out = [`Emitto – ${t('tag')}`, dateText(lang), '', notes.speed, ''];

  out.push(t('workTitle').toUpperCase(), goodNote(prio, lang));
  if (coach?.summary) out.push(coach.summary);
  out.push('');

  const issues = issueList(prio, lang, 5, coach);
  if (!issues.length) {
    const a = allClear(lang);
    out.push(a.title, a.why, `${t('drill')}: ${a.drill}`, '');
  } else {
    issues.forEach((it, i) => {
      out.push(`${i + 1}. ${it.title}`);
      if (it.what) out.push(it.what);
      out.push(it.why, `${t('drill')}: ${it.drill}`, it.pep, '');
    });
  }

  if (coach?.after) out.push(t('afterTitle').toUpperCase(), coach.after.title, coach.after.text, '');
  for (const [key, items] of [['observationsTitle', coach?.observations], ['uncertaintiesTitle', coach?.uncertainties]]) {
    if (items?.length) out.push(t(key).toUpperCase(), ...items.map(x => `- ${x}`), '');
  }

  out.push(t('detailsTitle').toUpperCase());
  for (const g of prio.graded) {
    const r = refOf(g.key);
    out.push(line(labelOf(g.key, lang),
      `${formatValue(g.key, g.value, lang)} (${t('reference')} ${formatValue(g.key, r.ok[0], lang)}–${formatValue(g.key, r.ok[1], lang)})`));
  }
  out.push('', notes.caveat, `${t('footer')} · ${location.host}`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------- ut ur appen
//
// Web Share ger telefonens egen delningsruta: bilden hamnar i samma chatt som allt annat
// spelaren skickar. Saknas den – eller vill webbläsaren inte dela just den filtypen –
// laddas filen ner i stället. Ingen av vägarna passerar en server.
// Text är inte en fil förrän den måste vara det. Delningsrutan tar emot ren text i de flesta
// webbläsare, och då hamnar den som ett vanligt meddelande i chatten – med en bifogad fil hade
// mottagaren behövt öppna något. Går det inte: urklipp, och sist en nedladdad .txt.
export async function deliverText(text, filename, title) {
  if (navigator.share) {
    try {
      await navigator.share({ text, title });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch { /* inget urklipp – ladda ner i stället */ }
  return deliver(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename, title);
}

export async function deliver(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';   // användaren stängde rutan
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
