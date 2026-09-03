# Emitto

Webbapp för basketspelare och tränare: filma ett skott från sidan, få fyra faser med skelett,
mätvärden mot forskningens riktvärden och en kort prioriterad lista (max 5) över vad som är
värt att jobba på, i den ordning rörelsekedjan går. Målgrupp är ungdomsspelare (ca 10–18) med
tränare i loopen. Gränssnittet finns på svenska och engelska.

## Arkitektur

- Statisk sida, inga ramverk, ingen build. ES-moduler direkt i webbläsaren.
- All analys körs klientsidan med MediaPipe Pose (Tasks Vision, WASM). **Videon lämnar aldrig
  enheten** – det är ett produktlöfte, bryt det inte utan att fråga.
- Deploy: Cloudflare Workers med static assets (`npx wrangler deploy`), repo-roten som
  assets-katalog. Framtida backend = `main` i samma Worker – bara siffror, aldrig video.

## Filer

| Fil | Roll | Rör den när… |
|---|---|---|
| `index.html` | UI, stil, designtokens, de tre vyerna | utseende, struktur |
| `app.js` | laddar klipp, kör MediaPipe ruta för ruta, ritar faser och listor | prestanda, rendering |
| `analysis.js` | hittar faser och räknar mätvärden ur ledpunkter | fasdetektering är fel |
| `rules.js` | riktvärden, prioritering, feedbacktexter på båda språken | gränser, texter, ordning |
| `i18n.js` | gränssnittets strängar, språkval och språkdetektering | UI-texter, nytt språk |
| `logo.svg`, `icon.svg`, `fonts/` | varumärke | aldrig utan anledning |
| `wrangler.toml`, `_headers`, `.assetsignore` | deploy: projekt, headers/CSP, vad som inte publiceras | deployen ändras |

Håll isär lagren: `analysis.js` vet inget om texter eller riktvärden och kastar fel som koder
(`E_NO_SHOT`), aldrig som färdig mening. `rules.js` vet inget om landmarks. `i18n.js` vet inget
om basket. `app.js` vet inget om riktvärden – det frågar `rules.js`.

Feedbacktexterna ligger i `rules.js`, inte i `i18n.js`, eftersom de hör ihop med gränsen de
beskriver: ändrar du ett riktvärde ska texten bredvid ändras i samma fil.

## Kommandon

```
npx serve .              # lokal server (file:// fungerar inte med ES-moduler)
node test.mjs            # kör analys + regler mot samples/*_lm.json, skriver faser och fokus
npx wrangler deploy      # publicera
npx wrangler dev --persist-to /tmp/emitto-dev   # enda sättet att testa _headers lokalt.
                                                # utan --persist-to startar servern om i loop.
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

## Flödet (app.js)

Tre vyer i samma sida, ingen router: `#view-start` → `#view-loading` → `#view-result`. Analysen
startar av sig själv när en fil valts – ingen knapp. Under laddningen studsar en boll och
progressbaren fylls av seek-loopen.

Resultatvyn har faserna som en svepbar rad. Tryck på ett kort ritar ut vinklarna i leden med
färg efter status och listar fasens mätvärden mot riktvärdet. Bara de fyra bildrutor som visas
sparas – att spara alla kostade över 100 MB på en telefon.

Resultatet ligger kvar i `last`, så språkbyte ritar om utan att analysera igen.

## Prioritering (rules.js)

`PRIORITY` är rörelsekedjan nedifrån och upp: knädjup → tid → knä vid släpp → bållutning →
armbåge → släpphöjd. Första avvikelsen vinner, om inte en senare avviker mer än dubbelt så
mycket – då lyfts den först. `issueList` ger max 5 och fyller aldrig ut listan med påhittade
fel: finns två avvikelser blir listan två lång. Prioriteringen är deterministisk och ska förbli
det – en LLM får formulera, aldrig välja.

Åldersband och val av skjuthand är borttagna ur gränssnittet. Skjutarmen gissas av `pickSide`
(handleden som når högst). Riktvärdena är de tidigare vuxenvärdena, eftersom 14 år var förvalt
och landade där – bedömningen av ett givet klipp är alltså oförändrad.

## Kända svagheter

- Armbågsvinkeln är brusig när bollen skymmer armen. Om den ger orimliga tips: ta bort
  `elbowSet` ur `PRIORITY` hellre än att vidga gränserna.
- Riktvärdena gäller nu alla åldrar. För en tioåring är de för hårda. Kalibrera mot egna klipp
  innan du delar upp dem i band igen.
- Fotställning i bredd syns inte från sidan. Säg inget om den.
- Seek-loopen i `app.js` kan vara långsam på telefon. Sänk `SAMPLE_FPS` (15 → 10) före andra
  optimeringar. `delegate: 'GPU'` kan behöva bli `'CPU'` på vissa Android-enheter.

## Design

Bläck `#10262E`, boll `#FF6A2B`, yta `#EAF0F2`. Orange används bara där något händer
(primärknapp, logotypens spår, etta i listan, plustecknen) – inte som dekoration. Barlow Condensed för rubriker
och siffror, Barlow för brödtext, båda självhostade i `fonts/`. Inga externa anrop utöver
MediaPipe. Lågmäld ton på båda språken. Listan inleds alltid med vad som ligger inom
riktvärdena – aldrig en rad fel utan att först säga vad som är bra.

## Att inte göra

- Ingen backend, inget konto, ingen lagring i MVP:n. Historik och trender är steg två.
- Inga ramverk eller byggsteg. Om det kliar: fråga först.
- Ändra inte riktvärden för att få ett visst klipp att "passa". Ändra bara med stöd i klipp
  eller källor, och skriv varför i en kommentar i `rules.js`.
