import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import { config, facebookDryRun, adsDryRun, PUBLIC_DIR, UPLOAD_DIR } from "./config.js";
import { products, posts, ads, newId, slugify } from "./db.js";
import { extractProduct, creativeCopy, writeCaption, parseAudience, AIError } from "./ai.js";
import { normalizePhoto, visionCopy, removeBackground, websiteImage, renderCreative, TEMPLATES } from "./image.js";
import { publishPhotoPost, adAccountInfo, buildTargeting, setAdStatus, adInsights, FacebookError } from "./facebook.js";
import { startScheduler, launchAd } from "./scheduler.js";
import { shopPage, productPage, notFoundPage } from "./views.js";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 4 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith("image/")),
});

app.use(express.json({ limit: "1mb" }));
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d" }));

// ------------------------------------------------------------- storefront

const live = () => products.where((p) => p.status === "published").sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

app.get("/", (req, res) => res.send(shopPage(live(), { category: req.query.category || "" })));
app.get("/p/:slug", (req, res) => {
  const p = products.where((x) => x.slug === req.params.slug && x.status === "published")[0];
  if (!p) return res.status(404).send(notFoundPage());
  res.send(productPage(p));
});
app.get("/api/public/products", (_req, res) => res.json(live().map(publicProduct)));

// ------------------------------------------------------------ admin auth

function requireAdmin(req, res, next) {
  if (!config.adminPassword) return next();
  const [, encoded = ""] = (req.headers.authorization || "").split(" ");
  const password = Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(password);
  const b = Buffer.from(config.adminPassword);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.set("WWW-Authenticate", 'Basic realm="admin"').status(401).send("Login required");
}

app.use(["/admin", "/api"], (req, res, next) => (req.path.startsWith("/public") ? next() : requireAdmin(req, res, next)));
app.use("/admin", express.static(path.join(PUBLIC_DIR, "admin")));

app.get("/api/status", async (_req, res) => {
  res.json({
    shop: config.shop,
    publicBaseUrl: config.publicBaseUrl,
    facebookDryRun,
    adsDryRun,
    adAccount: await adAccountInfo().catch((e) => ({ error: e.message })),
    templates: TEMPLATES,
  });
});

// -------------------------------------------------------------- products

const productDir = (id) => path.join(UPLOAD_DIR, id);
const productUrl = (id, file) => `/uploads/${id}/${file}`;
const productLink = (p) => `${config.publicBaseUrl}/p/${p.slug}`;

app.get("/api/products", (_req, res) => res.json(products.all()));
app.get("/api/products/:id", (req, res) => res.json(mustFind(products, req.params.id)));

// Step 1+2+3: photo(s) → background removed → details read by AI → draft product.
app.post("/api/products/analyze", upload.array("photos", 4), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "অন্তত একটি ছবি দিন (photos)" });
  const id = newId();
  const dir = productDir(id);
  fs.mkdirSync(dir, { recursive: true });

  const photos = await Promise.all(req.files.map((f) => normalizePhoto(f.buffer)));
  photos.forEach((buf, i) => fs.writeFileSync(path.join(dir, `original-${i + 1}.jpg`), buf));

  const [cutout, details] = await Promise.all([
    removeBackground(photos[0]),
    Promise.all(photos.map(visionCopy)).then((imgs) =>
      extractProduct(imgs.map((buffer) => ({ buffer, mediaType: "image/jpeg" })), {
        language: req.body.language || "bn",
        hint: req.body.hint || "",
      }),
    ),
  ]);
  fs.writeFileSync(path.join(dir, "cutout.png"), cutout);
  fs.writeFileSync(path.join(dir, "main.jpg"), await websiteImage(cutout));

  const product = products.insert({
    id,
    status: "draft",
    slug: slugify(details.product_name),
    name: details.product_name,
    brand: details.brand,
    category: details.category,
    subCategory: details.sub_category,
    size: details.size,
    mrp: details.mrp,
    price: req.body.price ? Number(req.body.price) : details.mrp,
    stock: req.body.stock ? Number(req.body.stock) : null,
    expiryDate: details.expiry_date,
    manufactureDate: details.manufacture_date,
    batchNo: details.batch_no,
    countryOfOrigin: details.country_of_origin,
    keyIngredients: details.key_ingredients,
    keyBenefits: details.key_benefits,
    shortDescription: details.short_description,
    description: details.description,
    howToUse: details.how_to_use,
    tags: details.tags,
    uncertainFields: details.uncertain_fields,
    images: {
      main: productUrl(id, "main.jpg"),
      cutout: productUrl(id, "cutout.png"),
      originals: photos.map((_, i) => productUrl(id, `original-${i + 1}.jpg`)),
    },
    creatives: [],
  });
  res.status(201).json(product);
});

const EDITABLE = [
  "name", "brand", "category", "subCategory", "size", "mrp", "price", "stock", "expiryDate", "manufactureDate",
  "batchNo", "countryOfOrigin", "keyIngredients", "keyBenefits", "shortDescription", "description", "howToUse", "tags",
];

app.patch("/api/products/:id", (req, res) => {
  mustFind(products, req.params.id);
  const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => EDITABLE.includes(k)));
  for (const k of ["mrp", "price", "stock"]) if (k in patch) patch[k] = patch[k] === "" || patch[k] === null ? null : Number(patch[k]);
  res.json(products.update(req.params.id, patch));
});

// Step 4: put the product live on the website.
app.post("/api/products/:id/publish", (req, res) => {
  const p = mustFind(products, req.params.id);
  if (!p.price) return res.status(400).json({ error: "ওয়েবসাইটে দেওয়ার আগে দাম (price) দিন" });
  res.json(products.update(p.id, { status: "published", publishedAt: p.publishedAt || new Date().toISOString(), url: productLink(p) }));
});

app.post("/api/products/:id/unpublish", (req, res) => {
  mustFind(products, req.params.id);
  res.json(products.update(req.params.id, { status: "draft" }));
});

app.delete("/api/products/:id", (req, res) => {
  mustFind(products, req.params.id);
  products.remove(req.params.id);
  fs.rmSync(productDir(req.params.id), { recursive: true, force: true });
  res.status(204).end();
});

// Step 5: AI creatives — one copy set rendered in every template.
app.post("/api/products/:id/creatives", async (req, res) => {
  const p = mustFind(products, req.params.id);
  const { offer = "", language = "en", templates = TEMPLATES } = req.body;
  const copy = await creativeCopy(p, { offer, language });
  const cutout = fs.readFileSync(path.join(productDir(p.id), "cutout.png"));
  const stamp = Date.now();
  const made = [];
  for (const template of templates.filter((t) => TEMPLATES.includes(t))) {
    const file = `creative-${template}-${stamp}.jpg`;
    fs.writeFileSync(path.join(productDir(p.id), file), await renderCreative(cutout, copy, { template, price: p.price }));
    made.push({ id: `${template}-${stamp}`, template, url: productUrl(p.id, file), copy, createdAt: new Date().toISOString() });
  }
  products.update(p.id, { creatives: [...made, ...(p.creatives || [])].slice(0, 30) });
  res.json(made);
});

// Step 6: Facebook caption.
app.post("/api/products/:id/caption", async (req, res) => {
  const p = mustFind(products, req.params.id);
  const { tone = "friendly", language = "bn", offer = "" } = req.body;
  res.json(await writeCaption(p, { link: productLink(p), tone, language, offer }));
});

// ----------------------------------------------------------- facebook post

app.get("/api/posts", (_req, res) => res.json(posts.all()));

// Step 7: post the creative + caption + link now or at a scheduled time.
app.post("/api/posts", async (req, res) => {
  const { productId, creativeUrl, message, publishAt } = req.body;
  let p = mustFind(products, productId);
  if (!message) return res.status(400).json({ error: "Caption (message) দিন" });
  const creative = (p.creatives || []).find((c) => c.url === creativeUrl);
  const imageFile = creative ? path.join(productDir(p.id), path.basename(creative.url)) : path.join(productDir(p.id), "main.jpg");

  // The post links to the product page, so the product must be live first.
  if (p.status !== "published") {
    if (!p.price) return res.status(400).json({ error: "পোস্ট করার আগে পণ্যের দাম দিন" });
    p = products.update(p.id, { status: "published", publishedAt: new Date().toISOString(), url: productLink(p) });
  }
  const fbRes = await publishPhotoPost({ imagePath: imageFile, message, publishAt: publishAt || null });
  const post = posts.insert({
    productId: p.id,
    productName: p.name,
    creativeUrl: creative?.url || p.images.main,
    message,
    publishAt: publishAt ? new Date(publishAt).toISOString() : new Date().toISOString(),
    status: fbRes.scheduled ? "scheduled" : "published",
    dryRun: facebookDryRun,
    fb: fbRes,
    permalink: facebookDryRun ? null : `https://www.facebook.com/${fbRes.postId}`,
  });
  res.status(201).json(post);
});

// --------------------------------------------------------------------- ads

app.get("/api/ads", async (_req, res) => {
  const list = ads.all();
  const withStats = await Promise.all(
    list.map(async (a) => (a.status === "running" || a.status === "paused" ? { ...a, insights: await adInsights(a).catch(() => null) } : a)),
  );
  res.json(withStats);
});

// "Ei audience-e ad chalao" → structured targeting, shown before spending money.
app.post("/api/ads/audience", async (req, res) => {
  const { text, productId } = req.body;
  if (!text) return res.status(400).json({ error: "Audience লিখুন" });
  const p = productId ? products.get(productId) : null;
  const audience = await parseAudience(text, p || { name: "General products" });
  const { targeting, resolved } = await buildTargeting(audience);
  res.json({ audience, targeting, resolved });
});

// Step 8: budget ($), dates and audience → ad from the post.
app.post("/api/ads", async (req, res) => {
  const { postId, budget, budgetType = "lifetime", startTime, endTime, audience, goal = "engagement" } = req.body;
  const post = mustFind(posts, postId);
  const amount = Number(budget);
  if (!(amount >= 1)) return res.status(400).json({ error: "বাজেট কমপক্ষে $1 দিন" });
  if (!audience?.countries) return res.status(400).json({ error: "আগে audience preview করুন" });
  const start = startTime ? new Date(startTime) : new Date();
  const end = endTime ? new Date(endTime) : null;
  if (Number.isNaN(start.getTime()) || (end && Number.isNaN(end.getTime()))) return res.status(400).json({ error: "তারিখ ঠিক নেই" });
  if (budgetType === "lifetime" && !end) return res.status(400).json({ error: "মোট বাজেটের জন্য শেষ তারিখ দিন" });
  if (end && end <= start) return res.status(400).json({ error: "শেষ তারিখ শুরুর পরে হতে হবে" });
  if (end && end.getTime() < Date.now() + 60 * 60 * 1000) return res.status(400).json({ error: "শেষ তারিখ ভবিষ্যতে হতে হবে" });

  const ad = ads.insert({
    postId: post.id,
    productId: post.productId,
    productName: post.productName,
    budget: amount,
    budgetType,
    startTime: start.toISOString(),
    endTime: end?.toISOString() || null,
    audience,
    goal,
    status: "waiting_for_post",
    dryRun: adsDryRun,
  });
  // A scheduled post can't be promoted until Facebook publishes it; the
  // scheduler launches the ad then.
  res.status(201).json(post.status === "published" ? await launchAd(ad.id) : ad);
});

app.post("/api/ads/:id/:action", async (req, res, next) => {
  if (!["pause", "resume"].includes(req.params.action)) return next();
  const ad = mustFind(ads, req.params.id);
  if (!ad.fb) return res.status(400).json({ error: "Ad এখনো চালু হয়নি" });
  const status = req.params.action === "pause" ? "PAUSED" : "ACTIVE";
  await setAdStatus(ad, status);
  res.json(ads.update(ad.id, { status: status === "PAUSED" ? "paused" : "running" }));
});

app.post("/api/ads/:id/retry", async (req, res) => {
  const ad = mustFind(ads, req.params.id);
  if (ad.status !== "error") return res.status(400).json({ error: "Only failed ads can be retried" });
  res.json(await launchAd(ad.id));
});

// ------------------------------------------------------------------ errors

class NotFound extends Error {}

function mustFind(collection, id) {
  const row = collection.get(id);
  if (!row) throw new NotFound("Not found");
  return row;
}

function publicProduct(p) {
  const { uncertainFields, creatives, stock, ...rest } = p;
  return { ...rest, url: productLink(p) };
}

app.use((err, _req, res, _next) => {
  if (err instanceof NotFound) return res.status(404).json({ error: err.message });
  if (err instanceof AIError || err instanceof FacebookError || err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: err.message || "Server error" });
});

app.listen(config.port, () => {
  console.log(`Shop:  ${config.publicBaseUrl}/`);
  console.log(`Admin: ${config.publicBaseUrl}/admin/`);
  if (facebookDryRun) console.log("Facebook: DRY RUN (set FB_PAGE_ID + FB_PAGE_ACCESS_TOKEN to post for real)");
  if (!facebookDryRun && adsDryRun) console.log("Ads: DRY RUN (set FB_AD_ACCOUNT_ID to run real ads)");
  startScheduler();
});

