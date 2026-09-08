// draw.js – ritar en fas: bilden, skelettet på skjutsidan och de vinklar som mätts.
//
// Ligger för sig eftersom två ställen ritar samma sak: resultatvyn på skärmen och
// delningsbilden. Ritade de var för sig skulle samma skott kunna se olika ut i appen
// och i det tränaren får skickat till sig.
//
// Vet inget om riktvärden eller texter: den får färdiga mätvärden med status och ritar
// dem. Vilken vinkel som hör till vilket mätvärde står i ARC – allt annat kommer utifrån.

import { L } from './analysis.js';

export const STATUS_COLOR = { good: '#1F9D6A', meh: '#E0A800', poor: '#D64545', na: '#8FA3AB' };

const BONES = side => (side === 'right'
  ? [[L.rSho, L.rElb], [L.rElb, L.rWri], [L.rSho, L.rHip], [L.rHip, L.rKnee], [L.rKnee, L.rAnk]]
  : [[L.lSho, L.lElb], [L.lElb, L.lWri], [L.lSho, L.lHip], [L.lHip, L.lKnee], [L.lKnee, L.lAnk]]);

const J = side => (side === 'right'
  ? { sho: L.rSho, elb: L.rElb, wri: L.rWri, hip: L.rHip, knee: L.rKnee, ank: L.rAnk }
  : { sho: L.lSho, elb: L.lElb, wri: L.lWri, hip: L.lHip, knee: L.lKnee, ank: L.lAnk });

// Vilka vinklar som går att rita ut som en båge i en led, per mätvärde.
export const ARC = {
  kneeMin:     j => [j.hip, j.knee, j.ank],
  kneeRelease: j => [j.hip, j.knee, j.ank],
  elbowSet:    j => [j.sho, j.elb, j.wri],
};

// Hela rutan. Utsnitt anges i samma normaliserade koordinater som ledpunkterna.
export const FULL = { x: 0, y: 0, w: 1, h: 1 };

// Bågens radie. En fast radie (dest.w/7) räckte så länge det bara var knät: låret och
// vaden är ungefär så långa i rutan. Armbågen i set point är det inte – överarmen är ~29 px
// i en fasruta som är 315 bred, alltså kortare än radien. Bågen hamnade då utanför både axel
// och handled och såg ut att höra till något annat än armen den mäter. Därför får det
// kortaste benet i leden sätta radien, med taket kvar och ett golv så att bågen syns även
// när armen är kraftigt förkortad i sidovyn.
export const arcRadius = (destW, limb) => Math.max(destW / 22, Math.min(destW / 7, limb * 0.6));

// Kortaste vägen mellan två vinklar, används för att välja bågens riktning.
function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// roundRect saknas i iOS Safari före 16.4 – hellre en fyrkant än ett kastat fel.
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

// Ritar bilden i dest (canvasens pixlar) med skelett och bågar ovanpå.
//
// crop är utsnittet ur bilden i normaliserade koordinater – samma koordinatsystem som
// ledpunkterna, så skelettet följer med utsnittet utan att räknas om någon annanstans.
// Allt som har en storlek skalas mot dest.w, så en fas ser likadan ut i en liten ruta
// som i en stor.
export function drawFrame(ctx, img, dest, lm, side, arcs = [], crop = FULL) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(dest.x, dest.y, dest.w, dest.h);
  ctx.clip();
  ctx.drawImage(img,
    crop.x * img.width, crop.y * img.height, crop.w * img.width, crop.h * img.height,
    dest.x, dest.y, dest.w, dest.h);

  const X = k => dest.x + ((lm[k].x - crop.x) / crop.w) * dest.w;
  const Y = k => dest.y + ((lm[k].y - crop.y) / crop.h) * dest.h;

  ctx.lineWidth = Math.max(3, dest.w / 110);
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#FFE600';
  for (const [a, b] of BONES(side)) {
    ctx.beginPath(); ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.stroke();
  }

  const j = J(side);
  for (const g of arcs) {
    const pts = ARC[g.key]?.(j);
    if (!pts) continue;
    const [a, b, c] = pts;
    const color = STATUS_COLOR[g.status];
    const bx = X(b), by = Y(b);
    const v1x = X(a) - bx, v1y = Y(a) - by;      // leden → det ena benet
    const v2x = X(c) - bx, v2y = Y(c) - by;      // leden → det andra
    const l1 = Math.hypot(v1x, v1y) || 1, l2 = Math.hypot(v2x, v2y) || 1;
    const r = arcRadius(dest.w, Math.min(l1, l2));
    const a0 = Math.atan2(v1y, v1x);
    const a1 = Math.atan2(v2y, v2x);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(4, dest.w / 90);
    ctx.beginPath();
    ctx.arc(bx, by, r, a0, a1, angleDiff(a0, a1) < 0); // korta vägen mellan strålarna
    ctx.stroke();

    // Etiketten läggs utåt längs vinkelns bisektris, där bågen buktar, i stället för rakt
    // åt höger. Då följer siffran med när radien krymper och pekar ut sin egen båge.
    let dx = v1x / l1 + v2x / l2, dy = v1y / l1 + v2y / l2;
    const dl = Math.hypot(dx, dy);
    if (dl < 1e-6) { dx = -v1y / l1; dy = v1x / l1; }  // rakt ben: ta vinkelrätt ut
    else { dx /= dl; dy /= dl; }

    const label = `${Math.round(g.value)}°`;
    ctx.font = `600 ${Math.round(dest.w / 13)}px "Barlow Condensed", Barlow, sans-serif`;
    const w = ctx.measureText(label).width + dest.w / 26;
    const h = Math.round(dest.w / 10);
    const cx = bx + dx * (r + h * 0.75), cy = by + dy * (r + h * 0.75);
    const lx = Math.min(dest.x + dest.w - w - 6, Math.max(dest.x + 6, cx - w / 2));
    const ly = Math.min(dest.y + dest.h - h - 6, Math.max(dest.y + 6, cy - h / 2));
    ctx.fillStyle = color;
    roundRect(ctx, lx, ly, w, h, 6);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + dest.w / 52, ly + h / 2);
  }
  ctx.restore();
}

// Utsnitt runt spelaren, med proportionerna boxAspect (bredd/höjd i pixlar).
//
// Klippen är filmade på avstånd för att hela kroppen ska synas. I appen fyller bilden
// skärmens bredd och det gör inget, men i en delningsbild med fyra rutor bredvid varandra
// blir spelaren annars en streckgubbe i frimärksformat. Ledpunkterna vet redan var kroppen
// är, så vi klipper ur runt den i stället för att zooma i mitten och hoppas.
//
// Räknas i "höjder": x multipliceras med bildens aspect ratio, precis som i signals(),
// så att förhållanden i den här funktionen är verkliga pixelförhållanden.
const CROP_JOINTS = [L.nose, L.lSho, L.rSho, L.lElb, L.rElb, L.lWri, L.rWri,
  L.lHip, L.rHip, L.lKnee, L.rKnee, L.lAnk, L.rAnk, L.lHeel, L.rHeel];

export function personCrop(lm, frameAspect, boxAspect, pad = 0.1) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const k of CROP_JOINTS) {
    const p = lm[k];
    if (!p) continue;
    x0 = Math.min(x0, p.x * frameAspect); x1 = Math.max(x1, p.x * frameAspect);
    y0 = Math.min(y0, p.y);              y1 = Math.max(y1, p.y);
  }
  if (!Number.isFinite(x0)) return FULL;

  const m = pad * Math.max(y1 - y0, 0.05);
  x0 -= m; x1 += m;
  y0 -= m * 1.6;   // extra luft över huvudet: där är bollen
  y1 += m;

  const bw = x1 - x0, bh = y1 - y0;
  let uh = Math.max(bh, bw / boxAspect), uw = uh * boxAspect;
  if (uh > 1) { uh = 1; uw = uh * boxAspect; }
  if (uw > frameAspect) { uw = frameAspect; uh = uw / boxAspect; }

  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const ux = Math.max(0, Math.min(frameAspect - uw, cx - uw / 2));
  const uy = Math.max(0, Math.min(1 - uh, cy - uh / 2));
  return { x: ux / frameAspect, y: uy, w: uw / frameAspect, h: uh };
}
