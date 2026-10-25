import { readFileSync } from 'node:fs';
import { unpackDatabase } from '../src/fooddb.js';

let cache;
/** The bundled food database as a Map, as the app sees it. */
export function loadFoods() {
  if (!cache) {
    const json = JSON.parse(readFileSync(new URL('../data/foods.json', import.meta.url), 'utf8'));
    cache = new Map(unpackDatabase(json).map((f) => [f.id, f]));
  }
  return cache;
}

export function memoryStorage() {
  const data = {};
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
}
