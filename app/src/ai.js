import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.js";

const client = new Anthropic();

export class AIError extends Error {}

// One structured-output call with Anthropic's server-side refusal fallback.
async function ask({ schema, system, content, effort = "medium", maxTokens = 8000 }) {
  let response;
  try {
    response = await client.beta.messages.parse({
      model: config.anthropic.model,
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort, format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content }],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw new AIError("Claude API key missing or invalid — set ANTHROPIC_API_KEY in .env");
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new AIError("Claude rate limit hit — try again in a minute");
    }
    if (error instanceof Anthropic.APIConnectionError) {
      throw new AIError("Could not reach the Claude API — check the internet connection");
    }
    if (error instanceof Anthropic.APIError) {
      throw new AIError(`Claude API error ${error.status}: ${error.message}`);
    }
    throw error;
  }
  if (response.stop_reason === "refusal") {
    throw new AIError(`Claude declined this request (${response.stop_details?.category ?? "unknown"})`);
  }
  if (!response.parsed_output) {
    throw new AIError(`Claude returned no usable output (stop_reason: ${response.stop_reason})`);
  }
  return response.parsed_output;
}

const languageName = (lang) => (lang === "en" ? "English" : "Bangla (বাংলা)");

// ---------------------------------------------------------------- extraction

const ProductSchema = z.object({
  product_name: z.string().describe("Full product name as printed, including variant"),
  brand: z.string().nullable(),
  category: z.string().describe("Shop category, e.g. Skin Care, Hair Care, Makeup, Grocery, Baby Care"),
  sub_category: z.string().nullable(),
  size: z.string().nullable().describe("Net weight / volume / pack size, e.g. 100 ml"),
  mrp: z.number().nullable().describe("Printed maximum retail price, numbers only"),
  expiry_date: z.string().nullable().describe("YYYY-MM-DD; use the last day of the month if only month/year is printed"),
  manufacture_date: z.string().nullable().describe("YYYY-MM-DD"),
  batch_no: z.string().nullable(),
  country_of_origin: z.string().nullable(),
  key_ingredients: z.array(z.string()),
  key_benefits: z.array(z.string()).describe("3–6 short benefit bullets"),
  short_description: z.string().describe("One or two sentences for product cards"),
  description: z.string().describe("Website product description, 80–150 words, plain paragraphs"),
  how_to_use: z.string().nullable(),
  tags: z.array(z.string()).describe("5–10 search tags"),
  uncertain_fields: z.array(z.string()).describe("Field names that were guessed rather than read from the pack"),
});

export async function extractProduct(images, { language = "bn", hint = "" } = {}) {
  const content = [
    ...images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.buffer.toString("base64") },
    })),
    {
      type: "text",
      text:
        `These are photos of one product a shop wants to sell online.\n` +
        `Read every printed label and fill in the product record.\n` +
        `Write short_description, description, key_benefits and how_to_use in ${languageName(language)}; ` +
        `keep product_name and brand exactly as printed.\n` +
        `Only fill a field from what you can read or reliably know about this exact product; ` +
        `otherwise use null and list the field in uncertain_fields. Never invent an expiry date or price.` +
        (hint ? `\nShop owner's note: ${hint}` : ""),
    },
  ];
  return ask({
    schema: ProductSchema,
    system: "You catalogue retail products for a Bangladeshi e-commerce shop.",
    content,
    effort: "medium",
  });
}

// ----------------------------------------------------------- creative copy

const CreativeCopySchema = z.object({
  headline: z.string().describe("At most 5 words"),
  subheadline: z.string().describe("At most 10 words"),
  badge: z.string().describe("1–3 words for a corner badge, e.g. NEW, 20% OFF, ORIGINAL"),
  cta: z.string().describe("Call to action button text, at most 3 words"),
  background: z.string().describe("Hex colour for the background, matching the pack"),
  accent: z.string().describe("Hex colour for badge and button, contrasting with background"),
  text_color: z.string().describe("Hex colour readable on the background"),
});

export async function creativeCopy(product, { offer = "", language = "en" } = {}) {
  return ask({
    schema: CreativeCopySchema,
    system: "You write ad creative copy for social media product posts.",
    content: [
      { type: "text", text: `Product:\n${productBrief(product)}` },
      {
        type: "text",
        text:
          `Write copy for a square Facebook creative in ${languageName(language)}. ` +
          `Choose colours that suit the product pack.` +
          (offer ? `\nCurrent offer to feature: ${offer}` : ""),
      },
    ],
    effort: "low",
  });
}

// ---------------------------------------------------------------- caption

const CaptionSchema = z.object({
  caption: z.string().describe("Post text without hashtags; may use line breaks and a few emoji"),
  hashtags: z.array(z.string()).describe("5–8 hashtags without the # sign"),
});

export async function writeCaption(product, { link, offer = "", tone = "friendly", language = "bn" } = {}) {
  const result = await ask({
    schema: CaptionSchema,
    system: "You write Facebook page posts for a Bangladeshi online shop.",
    content: [
      { type: "text", text: `Product:\n${productBrief(product)}` },
      {
        type: "text",
        text:
          `Write a ${tone} Facebook caption in ${languageName(language)} (60–120 words) that ends with how to order.\n` +
          `Order link: ${link}\n` +
          (config.shop.phone ? `Phone / WhatsApp: ${config.shop.phone}\n` : "") +
          `Shop name: ${config.shop.name}\n` +
          (offer ? `Offer: ${offer}\n` : "") +
          `Do not make medical or guaranteed-result claims.`,
      },
    ],
    effort: "low",
  });
  const tags = result.hashtags.map((t) => `#${t.replace(/^#/, "").replace(/\s+/g, "")}`).join(" ");
  return { caption: result.caption, hashtags: result.hashtags, full: `${result.caption}\n\n${tags}` };
}

// ---------------------------------------------------------------- audience

const AudienceSchema = z.object({
  countries: z.array(z.string()).describe("ISO 3166-1 alpha-2 codes"),
  cities: z.array(z.string()).describe("City names exactly as people write them, e.g. Dhaka, Chattogram"),
  age_min: z.number().int(),
  age_max: z.number().int(),
  genders: z.enum(["all", "male", "female"]),
  interests: z.array(z.string()).describe("Up to 6 Facebook interest keywords in English"),
  summary: z.string().describe("One line describing the audience back to the shop owner"),
});

export async function parseAudience(text, product) {
  const a = await ask({
    schema: AudienceSchema,
    system: "You turn a shop owner's audience description into Facebook ad targeting.",
    content: [
      {
        type: "text",
        text:
          `Audience description (may be Bangla, Banglish or English): "${text}"\n` +
          `Product being advertised:\n${productBrief(product)}\n` +
          `Default country if none is named: ${config.facebook.defaultCountry}. ` +
          `Ages must be between 18 and 65.`,
      },
    ],
    effort: "low",
  });
  a.age_min = Math.max(18, Math.min(65, a.age_min));
  a.age_max = Math.max(a.age_min, Math.min(65, a.age_max));
  if (!a.countries.length) a.countries = [config.facebook.defaultCountry];
  return a;
}

function productBrief(p) {
  return [
    `Name: ${p.name}`,
    p.brand && `Brand: ${p.brand}`,
    p.category && `Category: ${p.category}`,
    p.size && `Size: ${p.size}`,
    p.price && `Price: ${config.shop.currency}${p.price}`,
    p.keyBenefits?.length && `Benefits: ${p.keyBenefits.join("; ")}`,
    p.shortDescription && `Summary: ${p.shortDescription}`,
  ]
    .filter(Boolean)
    .join("\n");
}
