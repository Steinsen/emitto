# Emitto

Webbapp för basketspelare och tränare: filma ett skott från sidan, få fyra faser med skelett,
mätvärden mot forskningens riktvärden och **en** prioriterad sak att jobba på. Målgrupp är
ungdomsspelare (ca 10–18) med tränare i loopen.

## Arkitektur

- Statisk sida, inga ramverk, ingen build. ES-moduler direkt i webbläsaren.
- All analys körs klientsidan med MediaPipe Pose (Tasks Vision, WASM). **Videon lämnar aldrig
  enheten** – det är ett produktlöfte, bryt det inte utan att fråga.
- Deploy: Cloudflare Pages (`npx wrangler pages deploy .`). Framtida backend = Cloudflare Worker
  som bara tar emot siffror, aldrig video.

## Filer

| Fil | Roll | Rör den när… |
|---|---|---|
| `index.html` | UI, stil, designtokens | utseende, texter |
| `app.js` | laddar klipp, kör MediaPipe ruta för ruta, ritar resultat | prestanda, rendering |
| `analysis.js` | hittar faser och räknar mätvärden ur ledpunkter | fasdetektering är fel |
| `rules.js` | referensvärden per åldersband, prioritering, feedbacktexter | gränser, texter, ordning |
| `logo.svg`, `icon.svg`, `fonts/` | varumärke | aldrig utan anledning |

Håll isär de tre lagren: `analysis.js` vet inget om ålder eller texter, `rules.js` vet inget om
landmarks, `app.js` vet inget om riktvärden.

## Kommandon

```
npx serve .              # lokal server (file:// fungerar inte med ES-moduler)
node test.mjs            # kör analys + regler mot samples/*_lm.json, skriver faser och fokus
npx wrangler pages deploy .
```

## Testdata och facit

`samples/` (gitignorad) innehåller två klipp och deras landmarks som JSON. Facit från
manuell analys:

- **Leo** (`20260902_164906.mp4`): enstegsskott, ~0,6 s lägsta→släpp, knä ~100°, släpp i
  frånskjutet. Ska hamna inom ramarna på tid och knädjup. Fokus bör bli "inom ramarna" eller
  släpphöjd – **inte** armbåge.
- **Jalen** (`20260902_164439.mp4`): tvåstegsskott med paus, ~1,05 s lägsta→släpp, knä ~100°,
  släpp efter frånskjut med raka knän. Fokus ska bli **"Släpp bollen på vägen upp"**.

Om en ändring i `analysis.js` eller `rules.js` ändrar dessa två utfall: stanna och kontrollera
mot klippen innan du går vidare.

## Så fungerar fasdetekteringen (analysis.js)

Bollen detekteras inte. Allt utgår från `ext` = avstånd axel→handled delat med bålens längd.

1. Sträckningsfasen = 0,4 s-fönstret där `ext` ökar mest.
2. Set point = minsta `ext` under 1,5 s före sträckningen.
3. Släpp = när `ext` passerat 35 % av vägen från set point till fullt sträckt. Ligger ~0,1 s
   efter verkligt släpp – det är känt och kompenseras inte.
4. Lägsta läge = minsta knävinkel (medel av båda ben) från 1,2 s före set point till släppet.
5. Frånskjut = fotleden 1,5 % kroppslängd över golvnivån (median av första 0,3 s).

Skjutarm = den handled som når högst. Vinklar räknas med bildens aspect ratio, annars blir de fel
i stående video.

## Prioritering (rules.js)

`PRIORITY` är rörelsekedjan nedifrån och upp: knädjup → tid → knä vid släpp → bållutning →
armbåge → släpphöjd. Första avvikelsen vinner, om inte en senare avviker mer än dubbelt så
mycket. Under 10 år: mät, bedöm inte. Prioriteringen är deterministisk och ska förbli det – en
LLM får formulera, aldrig välja.

## Kända svagheter

- Armbågsvinkeln är brusig när bollen skymmer armen. Om den ger orimliga tips: ta bort
  `elbowSet` ur `PRIORITY` hellre än att vidga gränserna.
- Ungdomsreferenserna är vidgade vuxenvärden, inte forskning. Ska kalibreras mot egna klipp.
- Fotställning i bredd syns inte från sidan. Säg inget om den.
- Seek-loopen i `app.js` kan vara långsam på telefon. Sänk `SAMPLE_FPS` (15 → 10) före andra
  optimeringar. `delegate: 'GPU'` kan behöva bli `'CPU'` på vissa Android-enheter.

## Design

Bläck `#10262E`, boll `#FF6A2B`, yta `#EAF0F2`. Orange används bara där något händer
(primärknapp, logotypens spår, fokusrutan) – inte som dekoration. Barlow Condensed för rubriker
och siffror, Barlow för brödtext, båda självhostade i `fonts/`. Inga externa anrop utöver
MediaPipe. Svenska i UI, lågmäld ton, en sak i taget – aldrig en lista med fel utan att först
säga vad som är bra.

## Att inte göra

- Ingen backend, inget konto, ingen lagring i MVP:n. Historik och trender är steg två.
- Inga ramverk eller byggsteg. Om det kliar: fråga först.
- Ändra inte riktvärden för att få ett visst klipp att "passa". Ändra bara med stöd i klipp
  eller källor, och skriv varför i en kommentar i `rules.js`.
