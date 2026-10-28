import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./config.js";

// A tiny JSON-file store. Enough for a single shop; swap for SQL/Postgres when
// the catalogue grows past a few thousand products.
const DB_FILE = path.join(DATA_DIR, "db.json");

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return { products: [], posts: [], ads: [] };
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

const state = load();

function save() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export const newId = () => crypto.randomBytes(6).toString("hex");
const now = () => new Date().toISOString();

function makeCollection(name) {
  return {
    all: () => [...state[name]].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    get: (id) => state[name].find((x) => x.id === id) || null,
    where: (fn) => state[name].filter(fn),
    insert(doc) {
      const row = { id: newId(), createdAt: now(), updatedAt: now(), ...doc };
      state[name].push(row);
      save();
      return row;
    },
    update(id, patch) {
      const row = state[name].find((x) => x.id === id);
      if (!row) return null;
      Object.assign(row, patch, { updatedAt: now() });
      save();
      return row;
    },
    remove(id) {
      const i = state[name].findIndex((x) => x.id === id);
      if (i >= 0) state[name].splice(i, 1);
      save();
    },
  };
}

export const products = makeCollection("products");
export const posts = makeCollection("posts");
export const ads = makeCollection("ads");

export function slugify(text) {
  const base = String(text || "product")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  let slug = base || "product";
  let n = 2;
  while (state.products.some((p) => p.slug === slug)) slug = `${base}-${n++}`;
  return slug;
}
