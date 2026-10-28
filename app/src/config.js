import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, "..");
export const DATA_DIR = path.join(ROOT, "data");
export const PUBLIC_DIR = path.join(ROOT, "public");
export const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  // Public URL of this server. Product links in Facebook posts point here.
  publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ""),
  adminPassword: env.ADMIN_PASSWORD || "",

  shop: {
    name: env.SHOP_NAME || "My Shop",
    phone: env.SHOP_PHONE || "",
    currency: env.SHOP_CURRENCY || "৳",
    brandColor: env.BRAND_COLOR || "#e91e63",
  },

  anthropic: {
    model: env.CLAUDE_MODEL || "claude-opus-5-5",
  },

  removeBgApiKey: env.REMOVE_BG_API_KEY || "",

  facebook: {
    graphVersion: env.FB_GRAPH_VERSION || "v23.0",
    pageId: env.FB_PAGE_ID || "",
    pageAccessToken: env.FB_PAGE_ACCESS_TOKEN || "",
    // Ads need a user/system-user token with ads_management on the ad account.
    adsAccessToken: env.FB_ADS_ACCESS_TOKEN || env.FB_PAGE_ACCESS_TOKEN || "",
    adAccountId: (env.FB_AD_ACCOUNT_ID || "").replace(/^act_/, ""),
    defaultCountry: env.FB_DEFAULT_COUNTRY || "BD",
  },
};

// Without Facebook credentials every Graph call is simulated and logged,
// so the whole pipeline can be tried end to end before connecting a page.
export const facebookDryRun =
  env.FB_DRY_RUN === "true" || !config.facebook.pageId || !config.facebook.pageAccessToken;

export const adsDryRun =
  facebookDryRun || env.FB_ADS_DRY_RUN === "true" || !config.facebook.adAccountId;
