import fs from "node:fs";
import { config, facebookDryRun, adsDryRun } from "./config.js";
import { newId } from "./db.js";

const fb = config.facebook;
const GRAPH = `https://graph.facebook.com/${fb.graphVersion}`;

export class FacebookError extends Error {}

async function graph(method, path, params = {}, token) {
  const url = new URL(`${GRAPH}/${path.replace(/^\//, "")}`);
  const init = { method };
  if (params instanceof FormData) {
    params.append("access_token", token);
    init.body = params;
  } else {
    const body = new URLSearchParams({ access_token: token });
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      body.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    if (method === "GET") url.search = body.toString();
    else init.body = body;
  }
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new FacebookError(e.error_user_msg || e.message || `Facebook API error ${res.status}`);
  }
  return json;
}

function dry(kind, payload) {
  const id = `dry_${kind}_${newId()}`;
  console.log(`[facebook dry-run] ${kind}`, JSON.stringify(payload, null, 2).slice(0, 2000));
  return id;
}

// ---------------------------------------------------------------- page posts

const MIN_SCHEDULE_MS = 10 * 60 * 1000; // Facebook rejects schedules < 10 min ahead
const MAX_SCHEDULE_MS = 29 * 24 * 60 * 60 * 1000;

export function checkSchedule(publishAt) {
  if (!publishAt) return null;
  const t = new Date(publishAt).getTime();
  if (Number.isNaN(t)) throw new FacebookError("Invalid post date/time");
  const ahead = t - Date.now();
  if (ahead < MIN_SCHEDULE_MS) throw new FacebookError("Schedule must be at least 10 minutes in the future (or leave it empty to post now)");
  if (ahead > MAX_SCHEDULE_MS) throw new FacebookError("Facebook only allows scheduling up to ~30 days ahead");
  return new Date(t);
}

// Photo post with the creative; scheduled natively on Facebook when publishAt is given.
export async function publishPhotoPost({ imagePath, message, publishAt }) {
  const when = checkSchedule(publishAt);
  if (facebookDryRun) {
    const id = dry("post", { pageId: fb.pageId || "(not set)", imagePath, message, publishAt: when });
    return { photoId: id, postId: `${fb.pageId || "page"}_${id}`, scheduled: Boolean(when) };
  }
  const form = new FormData();
  form.append("source", new Blob([fs.readFileSync(imagePath)], { type: "image/jpeg" }), "creative.jpg");
  form.append("message", message);
  if (when) {
    form.append("published", "false");
    form.append("scheduled_publish_time", String(Math.floor(when.getTime() / 1000)));
  }
  const res = await graph("POST", `${fb.pageId}/photos`, form, fb.pageAccessToken);
  return { photoId: res.id, postId: res.post_id || `${fb.pageId}_${res.id}`, scheduled: Boolean(when) };
}

export async function postStatus(postId) {
  if (facebookDryRun) return { is_published: true, permalink_url: null };
  return graph("GET", postId, { fields: "is_published,permalink_url,scheduled_publish_time" }, fb.pageAccessToken);
}

// ---------------------------------------------------------------------- ads

const GOALS = {
  engagement: { objective: "OUTCOME_ENGAGEMENT", optimization_goal: "POST_ENGAGEMENT" },
  reach: { objective: "OUTCOME_AWARENESS", optimization_goal: "REACH" },
};

export async function adAccountInfo() {
  if (adsDryRun) return { currency: "USD", name: "(dry run)", dryRun: true };
  const a = await graph("GET", `act_${fb.adAccountId}`, { fields: "name,currency,account_status" }, fb.adsAccessToken);
  return { ...a, dryRun: false };
}

// Turns the AI-parsed audience into a Facebook targeting spec, resolving
// city and interest names to Facebook IDs.
export async function buildTargeting(audience) {
  const targeting = {
    age_min: audience.age_min,
    age_max: audience.age_max,
    geo_locations: { countries: audience.countries },
    targeting_automation: { advantage_audience: 0 },
  };
  if (audience.genders === "male") targeting.genders = [1];
  if (audience.genders === "female") targeting.genders = [2];

  const resolved = { cities: [], interests: [] };
  if (adsDryRun) {
    resolved.cities = audience.cities.map((name) => ({ name, key: "dry" }));
    resolved.interests = audience.interests.map((name) => ({ name, id: "dry" }));
  } else {
    for (const q of audience.cities) {
      const { data = [] } = await graph(
        "GET",
        "search",
        { type: "adgeolocation", location_types: ["city"], q, country_code: audience.countries[0] },
        fb.adsAccessToken,
      );
      if (data[0]) resolved.cities.push({ key: data[0].key, name: data[0].name });
    }
    for (const q of audience.interests) {
      const { data = [] } = await graph("GET", "search", { type: "adinterest", q, limit: 1 }, fb.adsAccessToken);
      if (data[0]) resolved.interests.push({ id: data[0].id, name: data[0].name });
    }
  }
  if (resolved.cities.length) {
    // Cities replace the country-wide target; 25 km covers the metro area.
    targeting.geo_locations = {
      cities: resolved.cities.map((c) => ({ key: c.key, radius: 25, distance_unit: "kilometer" })),
    };
  }
  if (resolved.interests.length) {
    targeting.flexible_spec = [{ interests: resolved.interests }];
  }
  return { targeting, resolved };
}

// Campaign → ad set → creative (the existing page post) → ad.
export async function createPostAd({ name, postId, budget, budgetType, startTime, endTime, targeting, goal = "engagement", activate = true }) {
  const g = GOALS[goal] || GOALS.engagement;
  const status = activate ? "ACTIVE" : "PAUSED";
  const minor = Math.round(Number(budget) * 100); // USD/most currencies: cents
  const budgetField = budgetType === "daily" ? { daily_budget: minor } : { lifetime_budget: minor };

  const adset = {
    name: `${name} — ad set`,
    ...budgetField,
    start_time: new Date(startTime).toISOString(),
    end_time: endTime ? new Date(endTime).toISOString() : undefined,
    billing_event: "IMPRESSIONS",
    optimization_goal: g.optimization_goal,
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    targeting,
    status,
  };

  if (adsDryRun) {
    const campaignId = dry("campaign", { name, objective: g.objective });
    const adsetId = dry("adset", adset);
    const creativeId = dry("creative", { object_story_id: postId });
    const adId = dry("ad", { adsetId, creativeId, status });
    return { campaignId, adsetId, creativeId, adId, status };
  }

  const act = `act_${fb.adAccountId}`;
  const token = fb.adsAccessToken;
  const campaign = await graph(
    "POST",
    `${act}/campaigns`,
    { name, objective: g.objective, status, special_ad_categories: [], is_adset_budget_sharing_enabled: false },
    token,
  );
  const set = await graph("POST", `${act}/adsets`, { ...adset, campaign_id: campaign.id }, token);
  const creative = await graph("POST", `${act}/adcreatives`, { name: `${name} — creative`, object_story_id: postId }, token);
  const ad = await graph("POST", `${act}/ads`, { name: `${name} — ad`, adset_id: set.id, creative: { creative_id: creative.id }, status }, token);
  return { campaignId: campaign.id, adsetId: set.id, creativeId: creative.id, adId: ad.id, status };
}

export async function setAdStatus(ad, status) {
  if (adsDryRun || String(ad.fb?.campaignId || "").startsWith("dry_")) return { success: true };
  return graph("POST", ad.fb.campaignId, { status }, fb.adsAccessToken);
}

export async function adInsights(ad) {
  if (adsDryRun || !ad.fb?.adId || ad.fb.adId.startsWith("dry_")) return null;
  const { data = [] } = await graph(
    "GET",
    `${ad.fb.adId}/insights`,
    { fields: "spend,impressions,reach,clicks,actions", date_preset: "maximum" },
    fb.adsAccessToken,
  );
  return data[0] || { spend: "0", impressions: "0", reach: "0" };
}
