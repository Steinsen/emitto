# Emitto – MVP

Statisk webbapp: välj ett klipp filmat från sidan, få fyra faser med skelett, mätvärden mot
forskningens riktvärden och en kort prioriterad lista över vad som är värt att jobba på. All
analys körs i webbläsaren (MediaPipe Pose via WASM) – videon lämnar aldrig telefonen.
Gränssnittet finns på svenska och engelska och väljer språk efter webbläsaren.

Texten i listan formuleras av en språkmodell via `/api/coach` i samma Worker, utifrån de
mätvärden som redan räknats fram på enheten. Ordningen i listan kommer alltid från `rules.js`
och kan inte ändras av modellen. Anropet görs medan laddningsvyn står kvar, så hela resultatet
visas på en gång. Går det inte igenom står `rules.js` egna texter kvar – appen fungerar utan det.

## Så används den
Välj ett klipp. Analysen startar direkt. Är klippet filmat i slow motion kan du välja
hastigheten innan, eller låta Auto gissa den ur hoppets fria fall – resultatsidan visar
alltid vilken hastighet analysen räknar i, och där går den att ändra och räkna om. När den är klar visas faserna som en svepbar rad –
tryck på en bild för att se vinklarna i leden och vilka som ligger utanför riktvärdet. Under
faserna ligger listan med det som är värt att jobba på, i prioriterad ordning. Varje punkt
fälls ut med ett plus: varför det inte är optimalt, en övning, och en rad pepp.

Resultatet går att dela på två sätt. **Dela som bild** ger en bild med faserna, listan och
alla mätvärden – på telefonen öppnas den vanliga delningsrutan, så den kan skickas i samma
chatt som allt annat. **Spara som sida** ger en enda HTML-fil med hela rapporten, bilderna
inbakade och inga externa anrop: att spara, maila eller skriva ut. Båda skapas i webbläsaren
av rutor som redan är avlästa – klippet laddas fortfarande aldrig upp.

## Filer
- `index.html` – gränssnitt och stil, de tre vyerna
- `app.js` – laddar klipp, kör MediaPipe ruta för ruta, ritar faser och listor
- `draw.js` – ritar en fas: bilden, skelettet och vinkelbågarna (används av både vyn och delningen)
- `share.js` – delningsbild med faserna (JPEG) och rapporten som ren text
- `analysis.js` – hittar faserna (lägsta läge, set point, släpp, frånskjut, följning) och räknar mätvärden
- `rules.js` – riktvärden, prioriteringslogik, feedbacktexter på båda språken. **Det är här du justerar.**
- `coach.js` – bygger anropet till `/api/coach` och lägger svaret ovanpå listan
- `worker/index.js` – `/api/coach`: validering, anropet till modellen, kontroll av svaret
- `worker/prompt.js` – systemprompten på båda språken, med mätdefinitioner och källor
- `i18n.js` – gränssnittets strängar och språkval
- `test-units.mjs` – kontroller utan testklipp: `node test-units.mjs`
- `test.mjs` – analys + regler mot `samples/*_lm.json`: `node test.mjs`
- `examples/` – färdiga klipp som kan analyseras direkt från startsidan

## Köra lokalt
ES-moduler kräver en webbserver (inte `file://`):
```
npx serve .
```
Öppna på telefonen via datorns IP eller kör i desktop-webbläsare med ett uppladdat klipp.

## Deploy på Cloudflare Workers
Ingen build – repo-roten *är* sajten, publicerad som en Worker med static assets.
Konfigurationen ligger i tre filer:

- `wrangler.toml` – projektnamn `emitto`, `[assets] directory = "./"`
- `.assetsignore` – vad som *inte* publiceras. Workers static assets har ingen inbyggd
  ignorerlista som Pages har, så utan raden `.git` där hamnar hela repohistoriken publikt
  läsbar på domänen. Rör den bara för att lägga till, aldrig för att ta bort.
- `_headers` – säkerhetsheaders, CSP och cache-regler

Första gången:
```
npx wrangler login
npx wrangler deploy
```
Sedan räcker `npx wrangler deploy`. Kopplar du repot i dashboarden (Workers & Pages → emitto →
Settings → Builds) körs samma kommando vid varje push till `main`.

Custom domain: Workers & Pages → emitto → Settings → Domains & Routes → `skott.steinsen.com`.

### Testa headers lokalt
`npx serve .` läser varken `_headers` eller `.assetsignore`. För det behövs wrangler:
```
npx wrangler dev --persist-to /tmp/emitto-dev
```
`--persist-to` är inte valfritt. Utan den skriver wrangler sin lokala state till `.wrangler/`
inne i assets-katalogen, filbevakaren ser skrivningen och servern startar om – i en loop som
aldrig hinner svara på en request.

### CSP:n
`connect-src` i `_headers` är den tekniska motsvarigheten till löftet att videon aldrig lämnar
enheten: sidan får bara prata med jsDelivr (MediaPipes WASM) och storage.googleapis.com
(pose-modellen). Klippet läses som `blob:` och kan inte skickas någonstans. Workern för
feedbacktexterna ligger på samma origin som sidan, så `'self'` täcker den – CSP:n behövde inte
vidgas. Dit går siffrorna och fem beskurna stillbilder på spelaren – aldrig klippet.

### Nyckeln till modellen
```
npx wrangler secret put ANTHROPIC_API_KEY     # produktion
cp .dev.vars.example .dev.vars                # lokalt, gitignorad
```
Modellen sätts med `ANTHROPIC_MODEL` i `wrangler.toml` (default `claude-sonnet-5`). Utan nyckel
svarar `/api/coach` med `E_COACH_CONFIG` och appen visar `rules.js` texter, som vanligt.

## Hur prioriteringen fungerar
Mätvärdena graderas mot ett intervall och en tolerans (`rules.js` → `REF`). Ordningen i `PRIORITY`
är rörelsekedjan nedifrån och upp. Första avvikelsen i kedjan hamnar överst, om inte något längre
ner avviker mer än dubbelt så mycket. Listan blir aldrig längre än fem och fylls aldrig ut med
påhittade fel.

## Kända begränsningar
- Sidovy krävs. Fotställning i bredd syns inte.
- Bollen detekteras inte; släppet uppskattas från armsträckningen (ca 0,1 s senare än verkligt släpp).
- Skottet väljs som den armsträckning som slutar med handleden över huvudet. Innehåller klippet
  flera skott analyseras det med störst utslag. Syns ingen sådan sträckning säger appen att den
  inte hittar något skott.
- Armbågsvinkeln är brusig när bollen skymmer armen. Lita mer på knä, tid och släpphöjd.
- Riktvärdena är vuxenvärden och gäller alla åldrar. För de yngsta är de för hårda. Kalibrera mot egna klipp.
- Skjutarmen gissas från vilken handled som når högst. Ingen manuell inställning finns.
- Hastigheten kan bara gissas när spelaren hoppar. Vid straffkast får du välja den själv.
- Klippet måste vara i ett format webbläsaren kan avkoda. iPhone spelar in i HEVC, som Safari
  klarar men Chrome och Firefox ofta inte – då säger appen till i stället för att fastna.

## Nästa steg
1. Turnstile framför `/api/coach`. Just nu står ett tak per IP ensamt (rate-limit-binding).
2. D1: spara analyser per spelare → historik och "timing sitter, nu går vi vidare".
3. Vinkelkontroll: varna om kameran inte står i sidovy.

## Varumärke
- `logo.svg` / `logo-dark.svg` – ordmärke. Pricken över i:et lämnar stapeln: släppet.
- `icon.svg` – appikon (bara märket), används som favicon och på hemskärmen.
- Färger: bläck `#10262E`, boll `#FF6A2B` (bara där något händer: knappen, spåret, fokusrutan), yta `#EAF0F2`.
- Typsnitt: Barlow Condensed SemiBold för rubriker och siffror, Barlow för brödtext. Ligger i `fonts/` – inga externa anrop.
