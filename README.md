# Emitto – MVP

Statisk webbapp: filma ett skott från sidan, få fyra faser med skelett, mätvärden mot
forskningens riktvärden och **en** prioriterad sak att jobba på. All analys körs i webbläsaren
(MediaPipe Pose via WASM) – videon lämnar aldrig telefonen.

## Filer
- `index.html` – gränssnitt och stil
- `app.js` – laddar klipp, kör MediaPipe ruta för ruta, ritar resultat
- `analysis.js` – hittar faserna (lägsta läge, set point, släpp, frånskjut, följning) och räknar mätvärden
- `rules.js` – referensvärden per åldersband, prioriteringslogik, feedbacktexter. **Det är här du justerar.**

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
(pose-modellen). Klippet läses som `blob:` och kan inte skickas någonstans. När Workern för
feedbacktexterna kommer ligger den på samma origin som sidan, så `'self'` täcker den redan –
CSP:n behöver inte vidgas, och det är fortfarande bara siffror som skickas.

## Hur prioriteringen fungerar
Mätvärdena graderas mot ett intervall och en tolerans (`rules.js` → `REF`). Ordningen i `PRIORITY`
är rörelsekedjan nedifrån och upp. Första avvikelsen i kedjan blir fokus, om inte något längre ner
avviker mer än dubbelt så mycket. Under 10 år mäts allt men inget bedöms.

## Kända begränsningar
- Sidovy krävs. Fotställning i bredd syns inte.
- Bollen detekteras inte; släppet uppskattas från armsträckningen (ca 0,1 s senare än verkligt släpp).
- Armbågsvinkeln är brusig när bollen skymmer armen. Lita mer på knä, tid och släpphöjd.
- Ungdomsreferenserna är gissningar utifrån vuxenstudier. Kalibrera mot egna klipp.

## Nästa steg
1. Worker som får siffrorna och formulerar feedback med en LLM (bara ettan i prioriteringen).
   Lägg `main = "worker.js"` i `wrangler.toml` – samma projekt, samma origin, ingen CORS.
2. D1: spara analyser per spelare → historik och "timing sitter, nu går vi vidare".
3. Vinkelkontroll: varna om kameran inte står i sidovy.

## Varumärke
- `logo.svg` / `logo-dark.svg` – ordmärke. Pricken över i:et lämnar stapeln: släppet.
- `icon.svg` – appikon (bara märket), används som favicon och på hemskärmen.
- Färger: bläck `#10262E`, boll `#FF6A2B` (bara där något händer: knappen, spåret, fokusrutan), yta `#EAF0F2`.
- Typsnitt: Barlow Condensed SemiBold för rubriker och siffror, Barlow för brödtext. Ligger i `fonts/` – inga externa anrop.
