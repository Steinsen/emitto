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
Ingen build. Skapa ett Pages-projekt, peka på repot, lämna build command tom och output-katalog `/`.
Eller direkt: `npx wrangler pages deploy .`
Lägg till `skott.steinsen.com` som custom domain i Pages-projektet.

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
