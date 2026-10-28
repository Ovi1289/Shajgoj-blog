import { config } from "./config.js";

const esc = (s) =>
  String(s ?? "").replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[ch]);

const money = (n) => (n || n === 0 ? `${config.shop.currency}${Number(n).toLocaleString("en-IN")}` : "");

function layout({ title, description = "", image = "", url = "", body }) {
  const brand = config.shop.brandColor;
  return `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ""}
${url ? `<meta property="og:url" content="${esc(url)}">` : ""}
<meta property="og:type" content="product">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;600;700&display=swap">
<style>
  :root { --brand: ${brand}; --ink: #1d1d1f; --muted: #6b6b73; --line: #ececf0; --bg: #f7f7f9; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Hind Siliguri", system-ui, sans-serif; color: var(--ink); background: var(--bg); }
  a { color: inherit; text-decoration: none; }
  header { background: #fff; border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 2; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 0 16px; }
  .bar { display: flex; align-items: center; gap: 16px; height: 60px; }
  .logo { font-weight: 700; font-size: 22px; color: var(--brand); }
  .cats { display: flex; gap: 8px; overflow-x: auto; padding: 12px 0; }
  .chip { white-space: nowrap; padding: 6px 14px; border-radius: 999px; background: #fff; border: 1px solid var(--line); font-size: 14px; }
  .chip.on { background: var(--brand); color: #fff; border-color: var(--brand); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 14px; padding: 8px 0 40px; }
  .card { background: #fff; border-radius: 14px; overflow: hidden; border: 1px solid var(--line); }
  .card img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
  .card .b { padding: 10px 12px 14px; }
  .brandname { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .name { font-weight: 600; font-size: 15px; line-height: 1.3; margin: 2px 0 6px; }
  .price { font-weight: 700; color: var(--brand); }
  .mrp { color: var(--muted); text-decoration: line-through; font-size: 13px; margin-left: 6px; font-weight: 400; }
  .pd { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; padding: 24px 0 48px; }
  .pd img { width: 100%; border-radius: 16px; background: #fff; border: 1px solid var(--line); }
  .pd h1 { font-size: 28px; margin: 4px 0 8px; }
  .meta { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 14px; margin: 16px 0; }
  .meta dt { color: var(--muted); }
  .meta dd { margin: 0; }
  .btns { display: flex; gap: 10px; flex-wrap: wrap; margin: 18px 0; }
  .btn { padding: 12px 20px; border-radius: 10px; font-weight: 600; background: var(--brand); color: #fff; }
  .btn.alt { background: #25d366; }
  .btn.ghost { background: #fff; color: var(--ink); border: 1px solid var(--line); }
  ul.benefits { padding-left: 18px; }
  .empty { text-align: center; color: var(--muted); padding: 80px 0; }
  footer { color: var(--muted); font-size: 13px; padding: 24px 0 40px; text-align: center; }
  @media (max-width: 720px) { .pd { grid-template-columns: 1fr; gap: 16px; } .pd h1 { font-size: 22px; } }
</style>
</head>
<body>
<header><div class="wrap bar"><a class="logo" href="/">${esc(config.shop.name)}</a></div></header>
<main class="wrap">${body}</main>
<footer>© ${new Date().getFullYear()} ${esc(config.shop.name)}${config.shop.phone ? ` · ${esc(config.shop.phone)}` : ""}</footer>
</body>
</html>`;
}

function card(p) {
  return `<a class="card" href="/p/${esc(p.slug)}">
  <img src="${esc(p.images.main)}" alt="${esc(p.name)}" loading="lazy">
  <div class="b">
    ${p.brand ? `<div class="brandname">${esc(p.brand)}</div>` : ""}
    <div class="name">${esc(p.name)}</div>
    <div class="price">${money(p.price)}${p.mrp && p.mrp > p.price ? `<span class="mrp">${money(p.mrp)}</span>` : ""}</div>
  </div>
</a>`;
}

export function shopPage(list, { category = "" } = {}) {
  const categories = [...new Set(list.map((p) => p.category).filter(Boolean))].sort();
  const shown = category ? list.filter((p) => p.category === category) : list;
  const chips = [`<a class="chip ${category ? "" : "on"}" href="/">সব পণ্য</a>`]
    .concat(categories.map((c) => `<a class="chip ${c === category ? "on" : ""}" href="/?category=${encodeURIComponent(c)}">${esc(c)}</a>`))
    .join("");
  return layout({
    title: category ? `${category} — ${config.shop.name}` : config.shop.name,
    description: `${config.shop.name} — অনলাইন শপ`,
    body: `<nav class="cats">${chips}</nav>
<section class="grid">${shown.map(card).join("") || `<p class="empty">এখনো কোনো পণ্য নেই</p>`}</section>`,
  });
}

export function productPage(p) {
  const url = `${config.publicBaseUrl}/p/${p.slug}`;
  const orderText = encodeURIComponent(`আমি এই পণ্যটি অর্ডার করতে চাই: ${p.name} (${url})`);
  const phone = config.shop.phone.replace(/[^\d]/g, "");
  const facts = [
    ["ব্র্যান্ড", p.brand],
    ["ক্যাটাগরি", [p.category, p.subCategory].filter(Boolean).join(" › ")],
    ["সাইজ", p.size],
    ["মেয়াদ শেষ", p.expiryDate],
    ["উৎপাদন", p.manufactureDate],
    ["ব্যাচ", p.batchNo],
    ["উৎপত্তি", p.countryOfOrigin],
  ].filter(([, v]) => v);

  return layout({
    title: `${p.name} — ${config.shop.name}`,
    description: p.shortDescription,
    image: `${config.publicBaseUrl}${p.images.main}`,
    url,
    body: `<article class="pd">
  <div><img src="${esc(p.images.main)}" alt="${esc(p.name)}"></div>
  <div>
    ${p.brand ? `<div class="brandname">${esc(p.brand)}</div>` : ""}
    <h1>${esc(p.name)}</h1>
    <div class="price" style="font-size:24px">${money(p.price)}${p.mrp && p.mrp > p.price ? `<span class="mrp">${money(p.mrp)}</span>` : ""}</div>
    <p>${esc(p.shortDescription)}</p>
    <div class="btns">
      ${phone ? `<a class="btn alt" href="https://wa.me/${phone}?text=${orderText}">WhatsApp-এ অর্ডার</a>` : ""}
      ${phone ? `<a class="btn ghost" href="tel:${phone}">কল করুন</a>` : ""}
    </div>
    <dl class="meta">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    ${p.keyBenefits?.length ? `<h3>মূল সুবিধা</h3><ul class="benefits">${p.keyBenefits.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
    <h3>বিস্তারিত</h3>
    ${String(p.description || "").split(/\n+/).map((para) => `<p>${esc(para)}</p>`).join("")}
    ${p.keyIngredients?.length ? `<h3>উপাদান</h3><p>${esc(p.keyIngredients.join(", "))}</p>` : ""}
    ${p.howToUse ? `<h3>ব্যবহারবিধি</h3><p>${esc(p.howToUse)}</p>` : ""}
  </div>
</article>`,
  });
}

export function notFoundPage() {
  return layout({ title: "Not found", body: `<p class="empty">পণ্যটি পাওয়া যায়নি। <a href="/" style="color:var(--brand)">শপে ফিরে যান</a></p>` });
}
