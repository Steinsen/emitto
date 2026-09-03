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

## Deploy på Cloudflare Pages
Ingen build – repo-roten *är* sajten. Konfigurationen ligger i tre filer:

- `wrangler.toml` – projektnamn `emitto`, `pages_build_output_dir = "."`
- `_headers` – säkerhetsheaders, CSP och cache-regler
- `_redirects` – skickar `/CLAUDE.md`, `/README.md` och `/wrangler.toml` till startsidan
  (de skulle annars vara läsbara på domänen)

Första gången:
```
npx wrangler login
npx wrangler pages project create emitto --production-branch main
npx wrangler pages deploy .
```
Sedan räcker `npx wrangler pages deploy .`. Vill du ha deploy vid varje push: koppla repot i
Cloudflare-dashboarden i stället, lämna build command tom och sätt output-katalog till `/`.

Lägg till `skott.steinsen.com` som custom domain i Pages-projektet (Pages → emitto → Custom
domains). DNS ligger redan i Cloudflare, så CNAME:n skapas automatiskt.

Testa headers och redirects lokalt innan deploy – `npx serve .` läser dem inte:
```
npx wrangler pages dev .
```

### CSP:n
`connect-src` i `_headers` är den tekniska motsvarigheten till löftet att videon aldrig lämnar
enheten: sidan får bara prata med jsDelivr (MediaPipes WASM) och storage.googleapis.com
(pose-modellen). Klippet läses som `blob:` och kan inte skickas någonstans. Lägger du till en
Worker för feedbacktexterna måste dess origin in i `connect-src` – och då är det bara siffror
som skickas.

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
2. D1: spara analyser per spelare → historik och "timing sitter, nu går vi vidare".
3. Vinkelkontroll: varna om kameran inte står i sidovy.

## Varumärke
- `logo.svg` / `logo-dark.svg` – ordmärke. Pricken över i:et lämnar stapeln: släppet.
- `icon.svg` – appikon (bara märket), används som favicon och på hemskärmen.
- Färger: bläck `#10262E`, boll `#FF6A2B` (bara där något händer: knappen, spåret, fokusrutan), yta `#EAF0F2`.
- Typsnitt: Barlow Condensed SemiBold för rubriker och siffror, Barlow för brödtext. Ligger i `fonts/` – inga externa anrop.
