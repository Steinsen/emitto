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
  assets-katalog. Workern (`main = worker/index.js`) svarar bara på `/api/*`; allt annat
  serveras som statiska filer och fungerar även om API:t ligger nere.
- **Mätningen och prioriteringen är deterministisk och körs på enheten.** Det enda som lämnar
  enheten är siffrorna, och – bara om användaren kryssar i det – några beskurna stillbilder ur
  rutor som redan lästs av. Aldrig klippet. En språkmodell **formulerar** analysen; den väljer
  aldrig vad som ska stå överst. Blir anropet av med det står `rules.js` egna texter kvar, och
  det är inte ett fel utan normalläget.

## Filer

| Fil | Roll | Rör den när… |
|---|---|---|
| `index.html` | UI, stil, designtokens, de tre vyerna | utseende, struktur |
| `app.js` | laddar klipp, kör MediaPipe ruta för ruta, ritar faser och listor | prestanda, rendering |
| `draw.js` | ritar en fas: bilden, skelettet och vinkelbågarna på en canvas | skelettet eller bågarna ska se annorlunda ut |
| `share.js` | gör resultatet till en delningsbild (JPEG) eller en fristående sida (HTML) | det som delas ska innehålla något annat |
| `analysis.js` | hittar faser och räknar mätvärden ur ledpunkter | fasdetektering är fel |
| `rules.js` | riktvärden, prioritering, feedbacktexter på båda språken | gränser, texter, ordning |
| `coach.js` | bygger anropet till `/api/coach` och lägger svaret ovanpå listan | vad som skickas, hur svaret används |
| `worker/index.js` | `/api/coach`: validering, anropet uppåt, kontroll av svaret | API:t ändras |
| `worker/prompt.js` | systemprompten på båda språken, med mätdefinitioner och källor | modellen skriver fel sorts text |
| `i18n.js` | gränssnittets strängar, språkval och språkdetektering | UI-texter, nytt språk |
| `test-units.mjs` | kontroller som inte behöver klipp | hastighet, prioritering, språk, utsnitt, vinkelbågar, payload |
| `test.mjs` | kör analys + regler mot `samples/*_lm.json` och skriver ut resultatet | facit ska kontrolleras |
| `fixtures/` | ledpunkter ur ett riktigt klipp som JSON, för testerna. Publiceras inte | fasdetekteringen ändras |
| `examples/` | färdiga klipp som kan analyseras utan eget klipp | nytt exempel läggs till i `EXAMPLES` i `app.js` |
| `logo.svg`, `icon.svg`, `fonts/` | varumärke | aldrig utan anledning |
| `wrangler.toml`, `_headers`, `.assetsignore`, `.dev.vars.example` | deploy: projekt, headers/CSP, vad som inte publiceras, nycklar lokalt | deployen ändras |

Håll isär lagren: `analysis.js` vet inget om texter eller riktvärden och kastar fel som koder
(`E_NO_SHOT`), aldrig som färdig mening. `rules.js` vet inget om landmarks. `i18n.js` vet inget
om basket. `app.js` vet inget om riktvärden – det frågar `rules.js`. `coach.js` vet inget om
ledpunkter och inget om gränssnittet: det bygger anropet av det `rules.js` och `analysis.js`
redan räknat fram, och lämnar tillbaka listposter. Det importerar med flit inte `i18n.js` –
den läser `navigator` redan vid import, och då går modulen inte att testa i node.

Feedbacktexterna ligger i `rules.js`, inte i `i18n.js`, eftersom de hör ihop med gränsen de
beskriver: ändrar du ett riktvärde ska texten bredvid ändras i samma fil.

`draw.js` ligger mellan `analysis.js` och de två ställen som ritar faser: resultatvyn och
delningsbilden. Ritade de var för sig skulle samma skott kunna se olika ut i appen och i det
tränaren får skickat till sig.

Vinkelbågens radie sätts av det kortaste benet i leden (`arcRadius`), inte av rutans bredd.
Låret och vaden är ungefär en sjundedel av rutan breda, men överarmen i set point är hälften
så lång – en fast radie lade bågen utanför både axel och handled, och den såg ut att höra till
någon annan del av kroppen än den den mätte. Siffran läggs ut längs vinkelns bisektris, så den
följer med bågen.

## Kommandon

```
npx serve .              # lokal server (file:// fungerar inte med ES-moduler)
node test-units.mjs      # kontroller utan testklipp: hastighetsgissning, fasdetektering
                         # (syntetisk streckgubbe + ledpunkter i fixtures/), prioritering,
                         # språk, delningsbildens utsnitt, vinkelbågarnas geometri
node test.mjs            # kör analys + regler mot samples/*_lm.json, skriver faser, mätvärden,
                         # måtten efter släppet och fokus. Kör före och efter en ändring i
                         # analysis.js eller rules.js och jämför utskrifterna.
npx wrangler deploy      # publicera
npx wrangler secret put ANTHROPIC_API_KEY       # nyckeln till modellen, en gång
npx wrangler dev --persist-to /tmp/emitto-dev   # enda sättet att testa _headers och /api/coach
                                                # lokalt. Utan --persist-to startar servern om
                                                # i loop. Nyckeln läses ur .dev.vars.
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

1. Sträckningsfasen = 0,4 s-fönstret där `ext` ökar mest **bland de fönster som slutar med
   handleden över huvudet**. `extUp` (handledens höjd över axeln, i bållängder) måste nå 0,5
   och ha stigit minst 0,3 under fönstret. Utan det kravet vinner ofta en annan rörelse:
   att ta emot bollen, sänka den eller dribbla sträcker armen lika mycket – men framåt och
   nedåt. Finns flera skott i klippet vinner det med störst utslag.
2. Set point = botten av dalen närmast sträckningen. Fönstret med störst utslag kan börja en
   ruta eller två före armens djupaste vikning, så vi går först framåt så länge armen
   fortsätter vikas (max 0,3 s) och sedan bakåt från botten. Bakåtvandringen stannar när `ext`
   stigit 0,15 över dalens botten – då är vi ur dalen och inne i en annan rörelse. (Att ta
   bara minsta `ext` under 1,5 s bakåt gör att en djupare armvikning tidigare, som en boll som
   tas emot vid bröstet, vinner; utan steget framåt hamnar set point en ruta för tidigt och
   armbågsvinkeln blir 30° fel.)
3. Släpp = när `ext` passerat 35 % av vägen från set point till fullt sträckt. Sökningen går
   bakåt från fullt sträckt arm, så en skakning tidigare i dalen inte räknas som släppet.
   Ligger ~0,1 s efter verkligt släpp – det är känt och kompenseras inte. (Kontrollmätt på
   `examples/20260906_130903.mp4`: bollen lämnar fingrarna mellan 1,47 och 1,53 s, och
   detekteringen svarar 1,47–1,53 beroende på brus i ledpunkterna. På det klippet ligger
   den alltså rätt, snarare än sent. Ändra inte 35 % utan att mäta på flera klipp.)
4. Lägsta läge = minsta knävinkel (medel av båda ben) från 1,2 s före set point till släppet.
5. Frånskjut = fotleden 1,5 % kroppslängd över golvnivån (median av första 0,3 s).

Hittas ingen kandidat som klarar höjdkraven kastas `E_NO_SHOT`. Hellre "jag hittar inget
skott" än fyra faser ur fel sekund.

`test-units.mjs` täcker det här på två sätt, båda utan att behöva klipp eller MediaPipe: en
syntetisk streckgubbe byggd av nyckelposer, och riktiga ledpunkter i
`fixtures/catch-then-shot_lm.json` (avlästa ur `examples/20260906_130903.mp4`, 15 rutor/s,
bara de leder `analysis.js` läser). Båda börjar med att bollen tas emot och sänks – det är
regressionstestet: den gamla regeln lade faserna i fångsten, den nya i skottet. Testerna
kontrollerar också att den gamla regeln fortfarande faller för fångsten, så att de inte tyst
slutar testa rätt sak den dagen fixturen byts ut.

Skjutarm = den handled som når högst. Vinklar räknas med bildens aspect ratio, annars blir de fel
i stående video.

## Uppspelningshastighet

Slow motion är inte bara fel sekunder. `findPhases` letar i fönster mätta i sekunder
(0,4 s sträckning, 1,5 s set point, 1,2 s lägsta läge), så ett fyrgångers klipp får fönster
som täcker en fjärdedel av rörelsen och faserna spårar ur. Därför skalas tidsaxeln om
**innan** faserna söks – `rescaleTime(sig, faktor)` – och allt nedströms räknar i verklig tid.
`findPhases` är oförändrad och vet inget om hastighet.

På Auto gissas faktorn ur hoppets fria fall (`estimateSpeed`). Höjden uttrycks i kroppslängder,
så kameraavstånd och upplösning faller bort. Tyngdaccelerationen blir då 5,2–7,0 kroppslängder/s²
för en kropp på 1,4–1,9 m; vi antar 1,65. Tid går i kvadrat, så kandidaterna 1×, 2×, 4× och 8×
ligger en faktor två isär och spelarens verkliga längd spelar nästan ingen roll.

Två krav sållar bort falska positiver: toppen måste nå 0,08 kroppslängder (~14 cm), och
parabeln måste passa med r² ≥ 0,9. Utan höjdkravet skulle en mjuk tåhävning – långsammare än
fritt fall – läsas som slow motion. Lämnar spelaren inte golvet svarar `estimateSpeed` null och
appen räknar i normal fart och säger att den gjort det. Gissa inte där det inte går att veta.

Hastigheten kan väljas före analysen och ändras i resultatet. Ändringen kör om allt från de
redan avlästa ledpunkterna – MediaPipe går inte igen, bara de fyra bildrutorna hämtas på nytt.

## Flödet (app.js)

Tre vyer i samma sida, ingen router: `#view-start` → `#view-loading` → `#view-result`. Analysen
startar av sig själv när en fil valts – ingen knapp. Under laddningen studsar en boll och
progressbaren fylls av seek-loopen.

Resultatvyn har faserna som en svepbar rad. Tryck på ett kort ritar ut vinklarna i leden med
färg efter status och listar fasens mätvärden mot riktvärdet.

**Fasrutan klipps runt spelaren** (`personCrop`, ruta 3:4), samma utsnitt som delningsbilden.
Hela bildrutan såg riktig ut på ett närbildsklipp men inte på ett filmat från läktaren: är
spelaren en sjättedel av bildhöjden blir överarmen ~14 px i den sparade rutan, kortare än
bågens minsta radie, och både båge och siffra är då ritade för kortet i stället för för
kroppen. Priset är att en vidvinkelbild förstoras mycket (~5×) och blir mjuk – den gränsen
sitter i `PHASE_H`.

**Fasbilden tas i analyssvepet, inte efteråt.** Varje avläst ruta sparas som JPEG i
kortstorlek (~35 kB, ~4 MB för åtta sekunder) i samma ögonblick som MediaPipe läser videon.
Att i stället söka tillbaka till fasens tid efteråt gav fel bild på telefon: två sökningar
till samma tid behöver inte ge samma ruta, och då hamnar rätt skelett på fel bild. Att vänta
på `requestVideoFrameCallback` och att kontrollera `mediaTime` räckte inte – därför finns
ingen andra sökning kvar alls. Att spara rutorna i full upplösning kostade över 100 MB; i
kortstorlek som JPEG är det en bråkdel.

`seek()` i svepet väntar ändå på `requestVideoFrameCallback` och läser `mediaTime`: rutans
egen tid blir dess `t`, aldrig den vi bad om. Landar sökningen fel går den tillbaka 0,4 s och
söker fram igen, två gånger. Av samma skäl är videoelementet inte `display:none` utan en
genomskinlig pixel – en gömd video slutar måla upp rutor.

Resultatet ligger kvar i `last`, så språkbyte ritar om utan att analysera igen.

## Dela resultatet (share.js)

Två format, för två olika saker. **Bilden** (JPEG, 1080 px bred) är förstahandsvalet: den
hamnar direkt i chatten och syns utan att någon behöver öppna en fil – de fyra faserna,
listan och alla mätvärden mot riktvärdena. **Sidan** (en enda HTML-fil, ~40 kB) har hela
rapporten med varför, övning och pepp, och är till för den som vill spara eller maila.

Båda går ut genom `deliver()`: Web Share med fil om webbläsaren kan, annars nedladdning.
Ingen av vägarna passerar en server. Bilderna kommer från rutor som redan är avlästa, och
det är användaren som väljer att skicka dem – löftet gäller klippet, och klippet skickas
aldrig.

Två saker är inte godtyckliga:

- **Bilden görs i förväg**, så snart resultatet ritats (`prepareShare`). Safari kräver att
  `navigator.share` anropas i samma klick som användaren gjorde, och ritas bilden först
  efter klicket hinner den kedjan brytas – då öppnas aldrig delningsrutan. Är bilden klar
  blir klicket bara ett anrop. Språkbyte gör om den.
- **Rutorna klipps runt spelaren** (`personCrop` i `draw.js`). Klippen är filmade på håll
  för att hela kroppen ska synas; med fyra rutor bredvid varandra i en delningsbild blir
  spelaren annars en streckgubbe i frimärksformat. Utsnittet utgår från ledpunkterna, så
  hela kroppen är alltid med – `test-units.mjs` kontrollerar just det. Resultatvyn använder
  samma utsnitt, så appen och det tränaren får skickat visar samma bild.

Sidan bär inte med sig typsnitten: tre TTF-filer hade lagt en halv megabyte till en fil som
ska kunna mailas. Färgerna och strukturen bär ändå.

## Prioritering (rules.js)

`PRIORITY` är rörelsekedjan nedifrån och upp: knädjup → tid → knä vid släpp → bållutning →
armbåge → släpphöjd. Första avvikelsen vinner, om inte en senare avviker mer än dubbelt så
mycket – då lyfts den först. `issueList` ger max 5 och fyller aldrig ut listan med påhittade
fel: finns två avvikelser blir listan två lång. Prioriteringen är deterministisk och ska förbli
det – en LLM får formulera, aldrig välja. Det är inte bara en instruktion i prompten:
`worker/index.js` kastar svaret om `priority.key` inte är `issues[0].key` eller om `secondary`
inte följer resten i ordning, och `merge()` i `coach.js` vägrar lägga modellens ord på en post
med annan nyckel. Tycker modellen att listan är fel får den säga det i `disagreement`, som
visas nedtonat.

Åldersband och val av skjuthand är borttagna ur gränssnittet. Skjutarmen gissas av `pickSide`
(handleden som når högst). Riktvärdena är de tidigare vuxenvärdena, eftersom 14 år var förvalt
och landade där – bedömningen av ett givet klipp är alltså oförändrad.

## Den AI-formulerade texten (coach.js, worker/)

Riktvärdestexterna i `rules.js` är korrekta men statiska: samma mening till alla, ingen koppling
mellan avvikelserna, inget om det `analysis.js` inte kan mäta. Ovanpå dem ligger ett lager som
låter en språkmodell **formulera** samma analys – knyta ihop det som hänger ihop, motivera med
forskningsstöd, och säga något om det som syns i bilderna.

Kedjan: `app.js` ritar resultatet med `rules.js` texter → `coach.js` bygger en payload av det som
redan är uträknat → `POST /api/coach` → `worker/index.js` validerar, frågar modellen med
`worker/prompt.js` som systemprompt och **kontrollerar svaret mot listan** → `merge()` lägger
orden på rätt post och vyn ritas om, märkt "AI-formulerad".

Vad modellen får: skriva sammanhängande text, knyta ihop avvikelser, motivera med källor, föreslå
övning, anpassa tonen efter ålder, och skriva observationer ur bilderna. Vad den inte får: välja
eller ordna om listan, uppskatta siffror ur bilderna, ändra bedömningen inom/utanför riktvärdet,
eller hitta på fel som inte finns i listan.

**Undantaget är det som händer efter släppet.** `rules.js` täcker rörelsekedjan fram till
släppet; bakåtlutning, framåtdrift och landning finns inte i `PRIORITY` alls. `postRelease()` i
`analysis.js` mäter fyra tal (`landing_ms`, `driftLanding`, `trunkAfterRelease`,
`landingSplit_ms`), de skickas som `postRelease` utan `ref` och utan `status`, och modellen får
skriva högst en punkt om dem i fältet `after` – visad som en egen ruta efter listan, aldrig som
en rad i den. Trösklarna för när det är värt att nämna ligger i `worker/prompt.js`, **inte** i
`rules.js`: de är gissade startvärden som ingen mätt mot egna klipp. Flytta dem inte förrän de
är kalibrerade – i `rules.js` skulle de börja se ut som riktvärden i appens mening.

Konfidens räknas i `coach.js`, inte i `analysis.js`. Under 50 avlästa rutor per verklig sekund
märks mätvärdena `confidence: 'low'`, liksom mätvärden vars leder MediaPipe såg dåligt
(`visibilityByMetric`). Observera riktningen: slow motion ger *fler* rutor per verklig sekund,
inte färre – `rescaleTime` delar tiden med faktorn, så 15 rutor/s i ett 4×-klipp är 60 i verklig
tid. Vid normal fart är alltså allt osäkert mätt, och det ska modellen säga rakt ut.

Bildrutorna är frivilliga och av som standard (kryssruta i resultatvyn, ihågkommen i sessionen).
De är beskurna stillbilder ur rutor som redan lästs av, via samma `personCrop` som resultatvyn,
högst fem stycken, högst 480 px. Klippet lämnar aldrig enheten, med eller utan kryss.

Åldern är ett frivilligt tal i startvyn. Den styr bara ordvalen i den AI-formulerade texten –
aldrig riktvärdena, som gäller alla åldrar.

**Fallbacken är normalläget, inte ett undantag.** Går anropet inte igenom – offline, saknad
nyckel, timeout, eller ett svar som inte följer listan – står `rules.js` texter kvar och det enda
som syns är en nedtonad rad. Appen ska gå att använda helt utan Workern.

## Kända svagheter

- Armbågsvinkeln är brusig när bollen skymmer armen. Om den ger orimliga tips: ta bort
  `elbowSet` ur `PRIORITY` hellre än att vidga gränserna.
- Riktvärdena gäller nu alla åldrar. För en tioåring är de för hårda. Kalibrera mot egna klipp
  innan du delar upp dem i band igen.
- Fotställning i bredd syns inte från sidan. Säg inget om den.
- Kravet på att handleden ska över huvudet gör att ett klipp där MediaPipe tappar den
  skjutande handleden i sträckningen ger `E_NO_SHOT` i stället för fel faser. Det är
  avsiktligt, men det betyder att dåligt spårade klipp nu oftare säger nej.
- På Auto läses bara de första 8 sekunderna av klippet. Ett 8×-klipp som är längre än så kan
  ha skottet utanför fönstret – välj hastigheten manuellt då, för då sträcks fönstret ut lika
  mycket. Att först gissa och sedan läsa om klippet vore ett andra svep till.
- Exempelklippen måste vara **H.264**. iPhone spelar in i HEVC, som Safari klarar men Chrome
  och Firefox ofta inte. `examples/LeoNormal.mp4` och `examples/20260906_130903.mp4` är båda
  HEVC (`hvc1`, 1920×1080 med rotationsflagga) och fungerar därför bara i Safari – exportera
  om dem. 20260906 ligger inte i `EXAMPLES` i `app.js` ännu, just därför. Klipp som webbläsaren inte kan avkoda ger nu ett tydligt fel (`E_VIDEO`)
  i stället för en laddning som snurrar för evigt, men felet kvarstår för besökaren.
- Fasbilderna sparas 560 px höga (`PHASE_H`) som hela bildrutan. Utsnittet runt spelaren
  görs först när fasen ritas, så det som blir kvar av spelaren är det som fick plats i de
  560 pixlarna: ~1,5 gångers förstoring på ett närbildsklipp, ~5 på ett filmat från
  läktaren, och då är bilden mjuk. Höj `PHASE_H` bara om minnet i svepet tål det – åtta
  sekunder ligger redan på ~4 MB. Billigare vore att klippa redan i svepet, där videon
  fortfarande finns i full upplösning: samma bytes, mer spelare. Det kräver att utsnittet
  sparas per ruta, eftersom `drawFrame` behöver veta vilket utsnitt bilden redan har.
- Modellens `observations` är just observationer ur fyra–fem stillbilder, inte mätvärden. Att
  "följningen hålls kvar" är en bild av en tiondels sekund, inte en mätning över tid – texten
  ska säga "i bilden ser det ut som", och gör den inte det är det prompten som ska ändras.
- Trösklarna i `worker/prompt.js` för när drift och landning är värda att nämna är gissade, inte
  mätta. De första klippen med tydlig framåtdrift bör jämföras mot dem innan de flyttas någonstans.
- Vid 15 rutor/s får varje mätvärde `confidence: 'low'`. Det är ärligt men trubbigt: en vinkel i
  lägsta läget är inte lika känslig för bildfrekvensen som tiden mellan två faser. Dela upp det
  när det finns klipp i 60 bilder/s att jämföra med.
- Seek-loopen i `app.js` kan vara långsam på telefon. Sänk `SAMPLE_FPS` (15 → 10) före andra
  optimeringar. `delegate: 'GPU'` kan behöva bli `'CPU'` på vissa Android-enheter.

## Design

Bläck `#10262E`, boll `#FF6A2B`, yta `#EAF0F2`. Orange används bara där något händer
(primärknapp, logotypens spår, etta i listan, plustecknen) – inte som dekoration. Barlow Condensed för rubriker
och siffror, Barlow för brödtext, båda självhostade i `fonts/`. Inga externa anrop utöver
MediaPipe. Lågmäld ton på båda språken. Listan inleds alltid med vad som ligger inom
riktvärdena – aldrig en rad fel utan att först säga vad som är bra.

## Att inte göra

- Backend finns nu, men bara för texten: `/api/coach` tar emot siffror och – efter kryss i en
  ruta – några beskurna stillbilder. Aldrig video, aldrig ledpunktsströmmar, ingen lagring,
  inget konto, inga loggar om spelaren. Historik och trender är fortfarande steg två.
- Inga ramverk eller byggsteg. Om det kliar: fråga först.
- Ändra inte riktvärden för att få ett visst klipp att "passa". Ändra bara med stöd i klipp
  eller källor, och skriv varför i en kommentar i `rules.js`.
