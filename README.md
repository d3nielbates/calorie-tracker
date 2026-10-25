# Calorie Tracker

A calorie, nutrient and weight-loss tracker for UK users, with daily targets
based on UK guidance and a weekly meal planner. It's a plain web app (HTML, CSS
and JavaScript modules, no build step and no runtime dependencies), so it works
on a phone or a desktop browser and can be added to the home screen.

**Not medical advice.** The app shows general guidance from UK public health
references. It blocks weight-loss targets for under-18s, during pregnancy or
breastfeeding, and below a BMI of 18.5.

## Run it

```bash
npm start            # serves the app at http://localhost:8080
```

Any static web host works (GitHub Pages, Netlify, an S3 bucket): upload the
folder as-is. It must be served over http(s), not opened as a file.

Data is stored in the browser's localStorage on that device only. Use
Profile → Export backup to keep a copy or move to another device.

## Features

- **Food diary**: breakfast, lunch, dinner and snacks; search, portions, edit,
  quick-add calories, create foods from a label, barcode lookup (and camera
  scanning where the browser supports it, e.g. Chrome on Android).
- **Daily targets**: calories, protein, carbs, fat, saturated fat, sugars,
  fibre, salt and 19 vitamins and minerals, with progress bars.
- **Weight tracking**: kg or stone/lb, smoothed trend line, weekly rate,
  projected goal date.
- **Weekly meal planner**: 57 UK-style meals, portioned to your targets; diet
  (vegan, vegetarian, pescatarian) and allergen exclusions; swap any meal;
  shopping list; log a planned meal or day to the diary.

## How targets are calculated (`src/targets.js`)

| What | Method |
| --- | --- |
| Resting energy | Mifflin-St Jeor (1990) |
| Maintenance | Resting energy × activity factor (1.2 to 1.9) |
| Weight loss | 7,700 kcal per kg; choice of 0.25 to 1 kg a week |
| Safety limits | Never below 1,200 kcal (women) / 1,500 kcal (men); loss capped at 1 kg and 1% of body weight a week |
| Protein | 1.4 g/kg of reference weight (current weight capped at BMI 25) when losing; ≥ UK RNI 0.75 g/kg; ≤ 35% of energy |
| Fat / saturates | 30% of energy (UK max 35%); saturates < 10% (SACN 2019) |
| Fibre / salt / sugars | 30 g (SACN 2015); < 6 g; < 90 g per 2,000 kcal (UK label RI) |
| Vitamins and minerals | UK RNIs (DH 1991), vitamin D 10 µg (SACN 2016), by sex and age |

## Food data: what is and isn't covered

| Source | What | Notes |
| --- | --- | --- |
| UK basics (`data-src/uk-foods.mjs`) | 208 everyday foods with UK names and portions | Values from USDA SR28, matched to the closest UK product (e.g. unfortified milk, semi-skimmed blended to 1.7% fat) |
| USDA SR28 (`vendor/sr28`) | 7,660 reference foods with 27 nutrients | Public domain. Carbohydrate converted to the UK basis (fibre excluded), sodium to salt. US names; search maps UK words (courgette → zucchini) |
| Open Food Facts | UK supermarket products, searched live in the browser | Open data (ODbL), filtered to products sold in the UK, with an optional shop filter. Crowd-sourced: good coverage of big brands and own-label lines, but not every product; label values can be outdated; most products list only label nutrients |

Known gaps:

- **Not every UK supermarket product is included.** No public dataset has all
  of them. Missing products can be added by barcode (if on Open Food Facts) or
  typed in from the label.
- **UK CoFID (McCance & Widdowson) is not bundled yet.** It couldn't be
  downloaded from the build environment. It is the better source for UK
  generic foods and micronutrients; adding it means writing an importer for
  the CoFID spreadsheet like `src/importers/sr28.js`.
- Iodine and free sugars aren't tracked (not in the source data).
- Vitamin A uses retinol activity equivalents (US); the UK uses retinol
  equivalents, which count beta-carotene at about twice the value.

### Offline pack of UK products (optional)

With internet access, download the Open Food Facts CSV export
(`https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz`,
about 1 GB) and run:

```bash
node scripts/import-off-uk.mjs en.openfoodfacts.org.products.csv.gz --clean
```

This writes `data/off-uk.json` (UK products only) and registers it in
`data/packs.json`; the app loads it automatically. `--clean` drops products
whose label data fails the consistency checks. Expect a large file; consider
filtering further before hosting it.

## Tests

```bash
npm test             # unit tests (node:test), no dependencies
npm run test:e2e     # browser test with Playwright + Chromium (Open Food Facts mocked)
npm run build:foods  # rebuild data/foods.json after editing data-src/uk-foods.mjs
```

## Code map

- `src/targets.js`: energy and nutrient targets, safety rules
- `src/planner.js`, `src/meals.js`: meal planner and meal library
- `src/importers/`: USDA SR28 parser, Open Food Facts API and CSV importers
- `src/search.js`: food search with UK→US synonyms
- `src/store.js`: diary, weights, custom foods, storage and backups
- `src/trend.js`, `src/units.js`: weight trend, unit conversion, dates
- `src/app.js`: the user interface
