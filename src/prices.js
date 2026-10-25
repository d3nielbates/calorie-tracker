// Estimated UK supermarket prices for the curated foods, used to cost the
// shopping list. These are typical standard own-label prices at the big
// supermarkets in 2025, rounded, NOT live prices: there is no open UK price
// feed. People can type their own price for any item.
//
// Each entry: [grams per pack as eaten, price in pence, pack description,
// staple?]. For foods eaten cooked, the grams are the cooked yield of the
// pack (e.g. 500 g dried pasta makes about 1.2 kg cooked). Staples are
// cupboard items that last for weeks, so most weeks you won't need to buy them.

export const PRICES_AS_OF = '2025';

export const SHOPS = {
  typical: { label: "Tesco, Sainsbury's, Asda or Morrisons", factor: 1 },
  discount: { label: 'Aldi or Lidl', factor: 0.85 },
  coop: { label: 'Co-op or a convenience store', factor: 1.2 },
  premium: { label: 'Waitrose or M&S', factor: 1.3 },
};

const S = true; // staple
export const PRICES = {
  'milk-semi': [2272, 155, '4 pints (2.27 L)'], 'milk-skimmed': [2272, 155, '4 pints (2.27 L)'], 'milk-whole': [2272, 165, '4 pints (2.27 L)'],
  'yog-greek-0': [500, 150, '500 g pot'], 'yog-greek-full': [500, 150, '500 g pot'], 'yog-natural-low': [500, 85, '500 g pot'], 'yog-fruit-low': [500, 100, '4 x 125 g pots'],
  egg: [600, 275, '12 medium eggs'], 'egg-boiled': [600, 275, '12 medium eggs'], 'egg-scrambled': [600, 275, '12 medium eggs'], 'egg-white': [396, 275, '12 medium eggs (whites only)'],
  cheddar: [400, 340, '400 g block'], 'cheddar-light': [350, 300, '350 g block'], cottage: [300, 120, '300 g tub'], 'mozzarella-light': [125, 85, '125 g ball'],
  feta: [200, 175, '200 g pack'], parmesan: [100, 195, '100 g grated'], 'cream-cheese-light': [180, 110, '180 g tub'], ricotta: [250, 125, '250 g tub'],
  butter: [250, 240, '250 g block', S], 'cream-single': [300, 105, '300 ml pot'], 'cream-double': [300, 150, '300 ml pot'], 'soured-cream': [300, 110, '300 ml pot'],
  'soya-milk': [1000, 140, '1 L carton'], 'almond-milk': [1000, 140, '1 L carton'],

  'porridge-oats': [1000, 95, '1 kg bag'], 'bread-wholemeal': [800, 85, '800 g loaf'], 'bread-white': [800, 75, '800 g loaf'], 'bread-seeded': [800, 140, '800 g loaf'],
  'wrap-white': [496, 110, '8 wraps'], 'wrap-wholemeal': [496, 120, '8 wraps'], 'pitta-white': [360, 55, '6 pittas'], 'pitta-wholemeal': [360, 65, '6 pittas'],
  bagel: [425, 130, '5 bagels'], 'english-muffin': [360, 95, '6 muffins'], naan: [260, 100, '2 naans'], croissant: [228, 150, '4 croissants'],
  weetabix: [430, 285, '24 biscuits'], 'shredded-wheat': [360, 250, '16 biscuits'], cornflakes: [500, 140, '500 g box'], 'rice-krispies': [510, 170, '510 g box'],
  muesli: [1000, 200, '1 kg bag'], granola: [500, 175, '500 g bag'], ryvita: [250, 130, '250 g pack'], 'rice-cake': [130, 90, '130 g pack'],

  'pasta-dry': [500, 75, '500 g bag'], 'pasta-cooked': [1200, 75, '500 g dried (about 1.2 kg cooked)'], 'pasta-wholewheat-cooked': [1200, 85, '500 g dried (about 1.2 kg cooked)'],
  'rice-white-cooked': [2500, 125, '1 kg rice (about 2.5 kg cooked)'], 'rice-brown-cooked': [2400, 150, '1 kg rice (about 2.4 kg cooked)'],
  'couscous-cooked': [1250, 100, '500 g dried (about 1.25 kg cooked)'], 'quinoa-cooked': [840, 180, '300 g dried (about 840 g cooked)'],
  'egg-noodles-cooked': [650, 95, '250 g dried (about 650 g cooked)'], 'rice-noodles-cooked': [600, 125, '250 g dried (about 600 g cooked)'],
  'bulgur-cooked': [1400, 150, '500 g dried (about 1.4 kg cooked)'], 'barley-cooked': [1500, 95, '500 g pearl barley (about 1.5 kg cooked)'],

  'potato-jacket': [1000, 100, '4 baking potatoes'], 'potato-new-boiled': [1000, 110, '1 kg bag'], 'sweet-potato-baked': [1000, 150, '1 kg bag'],
  'chips-oven': [1500, 200, '1.5 kg frozen bag'], mash: [2000, 160, '2 kg potatoes (plus a splash of milk)'],

  'chicken-breast-cooked': [750, 600, '1 kg raw breast fillets (about 750 g cooked)'], 'chicken-breast-raw': [1000, 600, '1 kg breast fillets'],
  'chicken-thigh-cooked': [700, 500, '1 kg boneless thighs (about 700 g cooked)'], 'turkey-mince-cooked': [375, 325, '500 g pack (about 375 g cooked)'],
  'turkey-mince-raw': [500, 325, '500 g pack'], 'beef-mince-5-raw': [500, 375, '500 g pack, 5% fat'], 'beef-mince-10-cooked': [370, 320, '500 g pack (about 370 g cooked)'],
  'sirloin-cooked': [340, 700, '2 steaks, 450 g raw'], 'pork-tenderloin': [375, 400, '500 g fillet (about 375 g cooked)'], 'ham-sliced': [125, 150, '10 slices'],
  'bacon-back': [180, 230, '300 g pack (about 180 g grilled)'], 'bacon-streaky': [150, 230, '300 g pack (about 150 g grilled)'],
  'sausage-pork': [360, 250, '8 sausages'], 'lamb-mince-cooked': [360, 450, '500 g pack (about 360 g cooked)'],

  'salmon-cooked': [200, 400, '2 fillets, 240 g'], 'salmon-raw': [240, 400, '2 fillets, 240 g'], 'smoked-salmon': [100, 250, '100 g pack'],
  'cod-cooked': [220, 450, '2 fillets, 260 g'], 'haddock-cooked': [220, 450, '2 fillets, 260 g'], 'pollock-cooked': [450, 300, '4 frozen fillets, 520 g'],
  'tuna-tin': [408, 320, '4 x 145 g tins'], 'mackerel-cooked': [200, 250, '2 fillets'], 'sardines-tin': [90, 85, '120 g tin'], 'trout-cooked': [220, 400, '2 fillets'],
  'prawns-cooked': [250, 350, '250 g frozen cooked prawns'], 'mussels-cooked': [150, 250, '500 g in shell'], 'fish-fingers': [300, 175, '10 fish fingers'],

  'lentils-cooked': [240, 75, '400 g tin'], 'lentils-dry': [500, 150, '500 g bag'], 'chickpeas-tin': [240, 65, '400 g tin'], 'kidney-beans-tin': [240, 55, '400 g tin'],
  'black-beans': [240, 80, '400 g tin'], 'baked-beans': [415, 80, '415 g tin'], 'butter-beans': [240, 70, '400 g tin'], 'peas-frozen': [1000, 140, '1 kg frozen'],
  edamame: [400, 250, '400 g frozen'], 'tofu-firm': [280, 200, '280 g block'], tempeh: [200, 300, '200 g block'], 'veggie-burger': [340, 275, '4 burgers'],
  'veggie-sausage': [300, 250, '6 sausages'], hummus: [200, 95, '200 g tub'],

  broccoli: [350, 79, '1 head'], 'spinach-raw': [240, 150, '240 g bag'], 'spinach-cooked': [900, 140, '900 g frozen'], 'carrot-raw': [1000, 55, '1 kg bag'],
  'carrot-boiled': [1000, 55, '1 kg bag'], tomato: [480, 75, '6 tomatoes'], 'tomatoes-tin': [400, 45, '400 g tin'], passata: [500, 55, '500 g carton'],
  'tomato-paste': [200, 70, '200 g tube', S], onion: [1000, 90, '1 kg bag'], 'spring-onion': [100, 55, '1 bunch'], 'pepper-red': [480, 140, '3 peppers'],
  'pepper-green': [480, 140, '3 peppers'], cucumber: [350, 75, '1 cucumber'], 'lettuce-romaine': [300, 105, '2 little gem / romaine hearts'],
  'lettuce-iceberg': [500, 65, '1 lettuce'], rocket: [60, 100, '60 g bag'], mushrooms: [300, 100, '300 g punnet'], courgette: [500, 110, '3 courgettes'],
  aubergine: [300, 85, '1 aubergine'], cauliflower: [600, 110, '1 cauliflower'], cabbage: [800, 75, '1 cabbage'], kale: [200, 100, '200 g bag'],
  sprouts: [500, 100, '500 g bag'], 'green-beans': [220, 105, '220 g pack'], sweetcorn: [165, 60, '198 g tin'], mangetout: [150, 110, '150 g pack'],
  avocado: [260, 120, '2 avocados'], garlic: [150, 70, '4 bulbs', S], celery: [400, 70, '1 head'], asparagus: [250, 200, '250 g bunch'],
  beetroot: [250, 90, '250 g cooked beetroot'], leek: [500, 140, '2-3 leeks'], parsnip: [500, 75, '500 g bag'], swede: [800, 70, '1 swede'],
  butternut: [800, 115, '1 squash'], 'mixed-veg': [1000, 140, '1 kg frozen'], ginger: [100, 60, '1 root', S], chilli: [50, 60, '50 g pack', S], coriander: [30, 75, '30 g pack'],

  apple: [600, 160, '6 apples'], banana: [500, 90, '5 bananas'], orange: [520, 160, '4 oranges'], satsuma: [450, 160, '600 g bag'],
  strawberries: [400, 250, '400 g punnet'], blueberries: [150, 175, '150 g punnet'], raspberries: [150, 200, '150 g punnet'], blackberries: [150, 200, '150 g punnet'],
  'frozen-berries': [500, 250, '500 g frozen'], grapes: [500, 200, '500 g pack'], pear: [550, 140, '4 pears'], kiwi: [375, 100, '5 kiwis'],
  mango: [400, 180, '2 mangoes'], pineapple: [600, 125, '1 pineapple'], melon: [1000, 160, '1 honeydew'], watermelon: [3000, 350, '1 watermelon'],
  plum: [400, 150, '400 g pack'], peach: [360, 180, '4 peaches'], cherries: [300, 300, '300 g punnet'], raisins: [500, 180, '500 g bag'], dates: [250, 150, '250 g pack'],
  'lemon-juice': [250, 85, '250 ml bottle', S], 'orange-juice': [1000, 160, '1 L carton'],

  almonds: [200, 250, '200 g bag'], walnuts: [150, 220, '150 g bag'], cashews: [200, 250, '200 g bag'], 'mixed-nuts': [200, 250, '200 g bag'], peanuts: [200, 120, '200 g bag'],
  'peanut-butter': [340, 175, '340 g jar', S], chia: [300, 300, '300 g bag', S], flaxseed: [250, 200, '250 g bag', S], 'pumpkin-seeds': [150, 175, '150 g bag', S],
  'sunflower-seeds': [200, 100, '200 g bag', S], tahini: [270, 300, '270 g jar', S],

  'olive-oil': [500, 600, '500 ml bottle', S], 'rapeseed-oil': [1000, 220, '1 L bottle', S], 'spread-light': [500, 150, '500 g tub', S], mayo: [500, 200, '500 ml jar', S],
  'mayo-light': [500, 200, '500 ml jar', S], ketchup: [460, 110, '460 g bottle', S], 'soy-sauce': [150, 100, '150 ml bottle', S], pesto: [190, 150, '190 g jar'],
  'pasta-sauce': [500, 110, '500 g jar'], salsa: [300, 120, '300 g jar'], 'coconut-milk': [400, 95, '400 ml tin, light'], 'chicken-stock': [5000, 60, '10 stock cubes', S],
  mustard: [180, 80, '180 g jar', S], balsamic: [250, 140, '250 ml bottle', S], 'curry-powder': [100, 100, '100 g jar', S], honey: [340, 175, '340 g jar', S],
  jam: [454, 90, '454 g jar', S], sugar: [1000, 105, '1 kg bag', S], 'dark-choc': [100, 130, '100 g bar'], crisps: [150, 140, '6 bags'],
  popcorn: [250, 100, '250 g kernels'], 'cookie-choc': [200, 120, '200 g pack'], 'oat-biscuit': [300, 100, '300 g pack'], 'cereal-bar': [144, 150, '6 bars'],
  'ice-cream': [1000, 200, '2 L tub'],
  coffee: [13750, 350, '100 g instant (about 55 cups)', S], tea: [20000, 250, '80 tea bags', S], cola: [2000, 180, '2 L bottle'],
  beer: [1760, 450, '4 x 440 ml cans'], 'wine-red': [750, 650, '75 cl bottle'], 'wine-white': [750, 650, '75 cl bottle'], water: [1000, 0, 'Tap water', S],
};

const bare = (id) => id.replace(/^uk:/, '');

/** Price info for a food id, or null if none is known. */
export function priceFor(id) {
  const p = PRICES[bare(id)];
  return p ? { packGrams: p[0], pence: p[1], pack: p[2], staple: Boolean(p[3]) } : null;
}

/**
 * Add estimated costs to shopping-list rows. `overrides` maps a food id to
 * the price in pounds the person pays for one pack (it replaces the estimate
 * and is not adjusted by shop). Returns { rows, buyPence, usedPence,
 * staplesPence, unpriced }.
 *  - buy: whole packs needed this week (excluding cupboard staples)
 *  - used: the share of each pack actually eaten this week
 */
export function costShoppingList(rows, { shop = 'typical', overrides = {} } = {}) {
  const factor = SHOPS[shop]?.factor ?? 1;
  let buyPence = 0;
  let usedPence = 0;
  let staplesPence = 0;
  const unpriced = [];
  const out = rows.map((r) => {
    const p = priceFor(r.foodId);
    if (!p) { unpriced.push(r.name); return { ...r, price: null }; }
    const own = Number(overrides[bare(r.foodId)]);
    const custom = Number.isFinite(own) && own >= 0;
    const packPence = custom ? Math.round(own * 100) : Math.round(p.pence * factor);
    const packs = Math.max(1, Math.ceil(r.grams / p.packGrams - 0.02)); // 2% slack for rounding
    const buy = packs * packPence;
    const used = Math.round((r.grams / p.packGrams) * packPence);
    usedPence += used;
    if (p.staple) staplesPence += buy; else buyPence += buy;
    return { ...r, price: { ...p, packPence, packs, buyPence: buy, usedPence: used, custom } };
  });
  return { rows: out, buyPence, usedPence, staplesPence, unpriced };
}

export const formatPounds = (pence) => `£${(pence / 100).toFixed(2)}`;
