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
import { issueList, goodNote, allClear, labelOf, refOf, formatValue, METRIC_PHASE } from './rules.js';
import { drawFrame, personCrop, roundRect, STATUS_COLOR, ARC } from './draw.js';

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

  // Att jobba på. Ettan får med sin övning – resten är rubriker, hela texten står i sidan.
  heading(t('workTitle'));
  quiet(goodNote(prio, lang));
  const issues = issueList(prio, lang, 5);
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
      const drill = i === 0 ? wrap(m, `${t('drill')}: ${it.drill}`, textW) : [];
      const h = 20 + title.length * 38 + (drill.length ? 6 + drill.length * 32 : 0) + 18;
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
        drill.forEach((l, k) => ctx.fillText(l, PAD + 60, at + 26 + title.length * 38 + k * 32));
        ctx.strokeStyle = LINE; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD, at + h - 0.5); ctx.lineTo(W - PAD, at + h - 0.5); ctx.stroke();
      });
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
  quiet(`${t('footer')} · ${location.host}`, 21);

  canvas.height = Math.round(y + PAD);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, canvas.height);
  for (const op of ops) op(ctx);
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
}

// ---------------------------------------------------------------- sidan

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Fasbilden som den ser ut i appen med vinklarna framme, som data-URI. JPEG i kortstorlek:
// fyra rutor blir en bråkdel av vad full upplösning hade kostat, och sidan ska kunna
// skickas som bilaga.
function phaseImage(shot, side, arcs, aspect) {
  const src = shot.canvas;
  const crop = personCrop(shot.lm, aspect, 3 / 4);   // samma utsnitt som i bilden
  const c = document.createElement('canvas');
  c.width = Math.round(crop.w * src.width);
  c.height = Math.round(crop.h * src.height);
  drawFrame(c.getContext('2d'), src, { x: 0, y: 0, w: c.width, h: c.height }, shot.lm, side, arcs, crop);
  return c.toDataURL('image/jpeg', 0.85);
}

// En fristående sida: allt innehåll, inga externa anrop, inga skript. Typsnitten kan inte
// följa med utan att filen växer med en halv megabyte, så den faller tillbaka på
// systemets – färgerna och strukturen bär ändå.
export async function shareReport(data, notes) {
  const { shots, side, aspect, prio } = data;
  const lang = getLang();
  const groups = byPhase(prio);
  const issues = issueList(prio, lang, 5);
  let logo = '';
  try { logo = await logoSource(); } catch { logo = '<strong>Emitto</strong>'; }

  const phases = shots.map(shot => {
    const graded = groups[shot.key] || [];
    const rows = graded.length
      ? graded.map(g => `<li><i style="background:${STATUS_COLOR[g.status]}"></i><span>${esc(labelOf(g.key, lang))}
          <em>${esc(t('reference'))} ${esc(formatValue(g.key, refOf(g.key).ok[0], lang))}–${esc(formatValue(g.key, refOf(g.key).ok[1], lang))}</em></span>
          <b>${esc(formatValue(g.key, g.value, lang))}</b></li>`).join('')
      : `<li class="none">${esc(t('noMetricsHere'))}</li>`;
    return `<figure>
      <img alt="${esc(t(shot.label))}" src="${phaseImage(shot, side, graded.filter(g => ARC[g.key]), aspect)}">
      <figcaption><span>${esc(t(shot.label))}</span><em>${shot.time.toFixed(2)} s</em></figcaption>
      <ul class="angles">${rows}</ul>
    </figure>`;
  }).join('');

  const work = issues.length
    ? `<ol class="work">${issues.map(it => `<li>
        <h3>${esc(it.title)}</h3>
        <p>${esc(it.why)}</p>
        <p class="drill"><strong>${esc(t('drill'))}:</strong> ${esc(it.drill)}</p>
        <p class="pep">${esc(it.pep)}</p></li>`).join('')}</ol>`
    : (a => `<div class="allclear"><h3>${esc(a.title)}</h3><p>${esc(a.why)}</p>
        <p><strong>${esc(t('drill'))}:</strong> ${esc(a.drill)}</p><p>${esc(a.pep)}</p></div>`)(allClear(lang));

  const metrics = prio.graded.map(g => `<li><i class="${g.status}"></i><span>${esc(labelOf(g.key, lang))}
      <em>${esc(t('reference'))} ${esc(formatValue(g.key, refOf(g.key).ok[0], lang))}–${esc(formatValue(g.key, refOf(g.key).ok[1], lang))}</em></span>
      <b>${esc(formatValue(g.key, g.value, lang))}</b></li>`).join('');

  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Emitto – ${esc(t('tag'))} ${esc(dateText(lang))}</title>
<style>
  :root{--ink:#10262E;--soft:#4F6169;--line:#D8E0E3;--court:#EAF0F2;--ball:#FF6A2B;
    --ok:#1F9D6A;--warn:#E0A800;--bad:#D64545;--r:12px}
  *{box-sizing:border-box}
  body{margin:0;background:#fff;color:var(--ink);font:17px/1.45 Barlow,system-ui,sans-serif}
  main{max-width:760px;margin:0 auto;padding:20px 18px 60px}
  header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0 24px}
  header svg{height:34px;width:auto;display:block}
  header .date{color:var(--soft);font-size:15px}
  h1,h2,h3{font-family:"Barlow Condensed","Arial Narrow",Barlow,sans-serif;font-weight:600;margin:0}
  h1{font-size:40px;line-height:1.05;margin-bottom:8px}
  h2{font-size:27px;margin:32px 0 10px}
  p{margin:0 0 10px;max-width:58ch}
  .quiet{color:var(--soft);font-size:15px}
  .phases{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin:0}
  @media (max-width:520px){.phases{grid-template-columns:1fr}}
  figure{margin:0;background:var(--ink);border-radius:var(--r);overflow:hidden}
  figure img{display:block;width:100%;height:auto}
  figcaption{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:11px 14px 4px;color:#fff}
  figcaption span{font-family:"Barlow Condensed","Arial Narrow",Barlow,sans-serif;font-weight:600;font-size:21px}
  figcaption em{color:#FFB48E;font-style:normal;font-size:14px}
  .angles{list-style:none;margin:0;padding:6px 14px 14px;color:#DCE5E9;font-size:14px}
  .angles li{display:flex;gap:9px;align-items:baseline;padding:3px 0}
  .angles li.none{color:#B8C6CC}
  .angles i{flex:none;width:9px;height:9px;border-radius:50%;transform:translateY(-1px)}
  .angles em{display:block;color:#B8C6CC;font-style:normal;font-size:13px}
  .angles b{margin-left:auto;white-space:nowrap;font-family:"Barlow Condensed","Arial Narrow",Barlow,sans-serif;font-size:19px;color:#fff}
  .work{list-style:none;counter-reset:n;padding:0;margin:12px 0 0;border-top:1px solid var(--line)}
  .work li{counter-increment:n;border-bottom:1px solid var(--line);padding:16px 0 16px 44px;position:relative}
  .work li::before{content:counter(n);position:absolute;left:0;top:16px;width:26px;height:26px;border-radius:50%;
    background:var(--court);color:var(--soft);font-family:"Barlow Condensed","Arial Narrow",Barlow,sans-serif;
    font-size:17px;display:grid;place-items:center}
  .work li:first-child::before{background:var(--ball);color:#fff}
  .work h3{font-size:24px;margin-bottom:6px}
  .drill{background:var(--court);border-radius:8px;padding:11px 13px}
  .pep{color:var(--soft);border-left:3px solid var(--ball);padding-left:11px;margin-bottom:0}
  .allclear{background:var(--ink);color:#fff;border-radius:var(--r);padding:20px 22px}
  .allclear h3{font-size:27px;margin-bottom:8px}
  .allclear p{color:#DCE5E9}
  .metrics{list-style:none;padding:0;margin:0;border-top:1px solid var(--line)}
  .metrics li{display:grid;grid-template-columns:12px 1fr auto;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)}
  .metrics i{width:11px;height:11px;border-radius:50%}
  .metrics em{display:block;color:var(--soft);font-style:normal;font-size:14px}
  .metrics b{white-space:nowrap;font-family:"Barlow Condensed","Arial Narrow",Barlow,sans-serif;font-size:24px}
  .good{background:var(--ok)}.meh{background:var(--warn)}.poor{background:var(--bad)}.na{background:#8FA3AB}
  footer{margin-top:36px;color:var(--soft);font-size:14px}
  @media print{body{font-size:12pt}figure{break-inside:avoid}.work li{break-inside:avoid}}
</style>
</head>
<body>
<main>
  <header>${logo}<span class="date">${esc(dateText(lang))}</span></header>
  <h1>${esc(t('tag'))}</h1>
  <p class="quiet">${esc(notes.speed)}</p>

  <h2>${esc(t('phasesTitle'))}</h2>
  <div class="phases">${phases}</div>

  <h2>${esc(t('workTitle'))}</h2>
  <p class="quiet">${esc(goodNote(prio, lang))}</p>
  ${work}

  <h2>${esc(t('detailsTitle'))}</h2>
  <ul class="metrics">${metrics}</ul>

  <footer>
    <p class="quiet">${esc(notes.caveat)}</p>
    <p class="quiet">${esc(t('footer'))} · ${esc(location.host)}</p>
  </footer>
</main>
</body>
</html>`;
  return new Blob([html], { type: 'text/html;charset=utf-8' });
}

// ---------------------------------------------------------------- ut ur appen
//
// Web Share ger telefonens egen delningsruta: bilden hamnar i samma chatt som allt annat
// spelaren skickar. Saknas den – eller vill webbläsaren inte dela just den filtypen –
// laddas filen ner i stället. Ingen av vägarna passerar en server.
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
