import sharp from "sharp";
import { config } from "./config.js";

const FONT = "'Hind Siliguri','Noto Sans Bengali','Noto Sans','DejaVu Sans',Arial,sans-serif";

// Upright, bounded-size JPEG so phone photos (EXIF rotation, 12MP) behave.
export async function normalizePhoto(buffer) {
  return sharp(buffer)
    .rotate()
    .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
}

// Smaller copy for the vision model; Claude downsamples past ~1568px anyway.
export async function visionCopy(buffer) {
  return sharp(buffer).resize(1568, 1568, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}

// Returns a transparent PNG cropped tight around the product.
export async function removeBackground(buffer) {
  const cut = config.removeBgApiKey ? await removeBgApi(buffer) : await removeBgLocal(buffer);
  return sharp(cut).trim({ threshold: 1 }).png().toBuffer();
}

async function removeBgLocal(buffer) {
  // Loaded lazily: the ONNX model takes a few seconds to initialise.
  const { removeBackground: run } = await import("@imgly/background-removal-node");
  const blob = await run(new Blob([buffer], { type: "image/jpeg" }), { output: { format: "image/png" } });
  return Buffer.from(await blob.arrayBuffer());
}

async function removeBgApi(buffer) {
  const form = new FormData();
  form.append("image_file", new Blob([buffer], { type: "image/jpeg" }), "photo.jpg");
  form.append("size", "auto");
  const res = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: { "X-Api-Key": config.removeBgApiKey },
    body: form,
  });
  if (!res.ok) throw new Error(`remove.bg failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// Clean square catalogue photo: product centred on white.
export async function websiteImage(cutout, size = 1200) {
  const inner = Math.round(size * 0.82);
  const fitted = await sharp(cutout).resize(inner, inner, { fit: "inside" }).toBuffer();
  const meta = await sharp(fitted).metadata();
  return sharp({ create: { width: size, height: size, channels: 3, background: "#ffffff" } })
    .composite([{ input: fitted, left: Math.round((size - meta.width) / 2), top: Math.round((size - meta.height) / 2) }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

// ------------------------------------------------------------------ creatives

export const TEMPLATES = ["spotlight", "split", "minimal"];

const S = 1080;

export async function renderCreative(cutout, copy, { template = "spotlight", price = null, shopName = config.shop.name } = {}) {
  const c = {
    bg: safeColor(copy.background, "#fde4ec"),
    accent: safeColor(copy.accent, config.shop.brandColor),
    text: safeColor(copy.text_color, "#1a1a1a"),
  };
  const priceText = price ? `${config.shop.currency}${price}` : "";
  const layout = LAYOUTS[template] || LAYOUTS.spotlight;
  const { box, svg } = layout({ copy, c, priceText, shopName });

  const fitted = await sharp(cutout).resize(box.w, box.h, { fit: "inside" }).png().toBuffer();
  const m = await sharp(fitted).metadata();
  const left = Math.round(box.x + (box.w - m.width) / 2);
  const top = Math.round(box.y + (box.h - m.height) / 2);
  const shadow = await dropShadow(fitted);

  return sharp(Buffer.from(svg.background))
    .composite([
      { input: shadow, left: left - SHADOW_PAD + 10, top: top - SHADOW_PAD + 24 },
      { input: fitted, left, top },
      { input: Buffer.from(svg.overlay), left: 0, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

// Soft shadow; padded so the blur isn't clipped at the image edge.
const SHADOW_PAD = 48;

async function dropShadow(png) {
  const pad = { top: SHADOW_PAD, bottom: SHADOW_PAD, left: SHADOW_PAD, right: SHADOW_PAD };
  const silhouette = await sharp(png)
    .ensureAlpha()
    .extend({ ...pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .linear([0, 0, 0, 0.28], [0, 0, 0, 0]) // black, 28% opacity
    .png()
    .toBuffer();
  return sharp(silhouette).blur(22).png().toBuffer();
}

const LAYOUTS = {
  spotlight: ({ copy, c, priceText, shopName }) => ({
    box: { x: 190, y: 250, w: 700, h: 560 },
    svg: {
      background: svgDoc(`
        <defs><radialGradient id="g" cx="50%" cy="55%" r="65%">
          <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="${c.bg}"/>
        </radialGradient></defs>
        <rect width="${S}" height="${S}" fill="url(#g)"/>
        <ellipse cx="540" cy="800" rx="330" ry="40" fill="${c.accent}" opacity="0.12"/>`),
      overlay: svgDoc(`
        ${textLines(copy.headline, { x: 540, y: 110, size: 72, weight: 800, color: c.text, anchor: "middle", maxChars: 22 })}
        ${textLines(copy.subheadline, { x: 540, y: 200, size: 36, weight: 500, color: c.text, anchor: "middle", maxChars: 42, opacity: 0.8 })}
        ${badge(copy.badge, 900, 300, c.accent)}
        ${priceText ? pill(priceText, 540, 880, "#ffffff", c.text, 44) : ""}
        ${pill(copy.cta, 540, 975, c.accent, "#ffffff", 38)}
        ${textLines(shopName, { x: 40, y: 1055, size: 24, weight: 600, color: c.text, opacity: 0.6, maxChars: 40 })}`),
    },
  }),

  split: ({ copy, c, priceText, shopName }) => ({
    box: { x: 520, y: 140, w: 520, h: 800 },
    svg: {
      background: svgDoc(`
        <rect width="${S}" height="${S}" fill="#ffffff"/>
        <rect width="500" height="${S}" fill="${c.bg}"/>
        <circle cx="780" cy="540" r="330" fill="${c.bg}" opacity="0.55"/>`),
      overlay: svgDoc(`
        ${badge(copy.badge, 120, 130, c.accent)}
        ${textLines(copy.headline, { x: 60, y: 330, size: 66, weight: 800, color: c.text, maxChars: 12 })}
        ${textLines(copy.subheadline, { x: 60, y: 560, size: 32, weight: 500, color: c.text, maxChars: 22, opacity: 0.8 })}
        ${priceText ? textLines(priceText, { x: 60, y: 780, size: 64, weight: 800, color: c.accent, maxChars: 14 }) : ""}
        ${pill(copy.cta, 230, 900, c.accent, "#ffffff", 34)}
        ${textLines(shopName, { x: 60, y: 1040, size: 24, weight: 600, color: c.text, opacity: 0.6, maxChars: 30 })}`),
    },
  }),

  minimal: ({ copy, c, priceText, shopName }) => ({
    box: { x: 240, y: 170, w: 600, h: 600 },
    svg: {
      background: svgDoc(`
        <rect width="${S}" height="${S}" fill="#fafafa"/>
        <circle cx="540" cy="470" r="330" fill="${c.bg}"/>`),
      overlay: svgDoc(`
        ${badge(copy.badge, 860, 170, c.accent)}
        ${textLines(copy.headline, { x: 540, y: 890, size: 60, weight: 800, color: "#1a1a1a", anchor: "middle", maxChars: 26 })}
        ${textLines([copy.subheadline, priceText].filter(Boolean).join("  •  "), { x: 540, y: 960, size: 34, weight: 500, color: "#444444", anchor: "middle", maxChars: 48 })}
        <rect x="0" y="1040" width="${S}" height="40" fill="${c.accent}"/>
        ${textLines(`${shopName}  —  ${copy.cta}`, { x: 540, y: 1068, size: 22, weight: 700, color: "#ffffff", anchor: "middle", maxChars: 80 })}`),
    },
  }),
};

function svgDoc(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${body}</svg>`;
}

function textLines(text, { x, y, size, weight = 400, color, anchor = "start", maxChars = 30, opacity = 1 }) {
  if (!text) return "";
  const lines = wrap(String(text), maxChars).slice(0, 3);
  return lines
    .map(
      (line, i) =>
        `<text x="${x}" y="${y + i * size * 1.18}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" ` +
        `fill="${color}" fill-opacity="${opacity}" text-anchor="${anchor}">${esc(line)}</text>`,
    )
    .join("");
}

function pill(text, cx, cy, fill, color, size) {
  if (!text) return "";
  const w = Math.max(220, Math.round(String(text).length * size * 0.62) + 80);
  const h = Math.round(size * 1.9);
  return (
    `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>` +
    `<text x="${cx}" y="${cy + size * 0.36}" font-family="${FONT}" font-size="${size}" font-weight="700" fill="${color}" text-anchor="middle">${esc(text)}</text>`
  );
}

function badge(text, cx, cy, fill) {
  if (!text) return "";
  return (
    `<circle cx="${cx}" cy="${cy}" r="88" fill="${fill}"/>` +
    textLines(text, { x: cx, y: cy + 10 - (String(text).length > 9 ? 16 : 0), size: 30, weight: 800, color: "#ffffff", anchor: "middle", maxChars: 9 })
  );
}

function wrap(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const esc = (s) => String(s).replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch]);
const safeColor = (v, fallback) => (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v || "") ? v : fallback);
