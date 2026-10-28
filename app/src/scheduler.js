import { posts, ads, products } from "./db.js";
import { postStatus, createPostAd, buildTargeting } from "./facebook.js";

// Facebook publishes scheduled posts itself; this loop notices when that has
// happened and then launches any ad waiting on the post.
export function startScheduler(intervalMs = 60_000) {
  const tick = () => runOnce().catch((e) => console.error("[scheduler]", e));
  setTimeout(tick, 5_000);
  return setInterval(tick, intervalMs);
}

export async function runOnce() {
  for (const post of posts.where((p) => p.status === "scheduled")) {
    if (new Date(post.publishAt).getTime() > Date.now()) continue;
    try {
      const s = await postStatus(post.fb.postId);
      if (s.is_published) posts.update(post.id, { status: "published", permalink: s.permalink_url || post.permalink });
    } catch (e) {
      posts.update(post.id, { lastError: e.message });
    }
  }

  for (const ad of ads.where((a) => a.status === "waiting_for_post")) {
    const post = posts.get(ad.postId);
    if (post?.status === "published") await launchAd(ad.id);
  }
}

export async function launchAd(adId) {
  const ad = ads.get(adId);
  const post = posts.get(ad.postId);
  const product = products.get(post.productId);
  ads.update(ad.id, { status: "launching", lastError: null });
  try {
    const { targeting, resolved } = await buildTargeting(ad.audience);
    const start = Math.max(new Date(ad.startTime).getTime(), Date.now() + 60_000);
    const fbIds = await createPostAd({
      name: `${product?.name || "Product"} — ${new Date().toISOString().slice(0, 10)}`,
      postId: post.fb.postId,
      budget: ad.budget,
      budgetType: ad.budgetType,
      startTime: start,
      endTime: ad.endTime,
      targeting,
      goal: ad.goal,
    });
    return ads.update(ad.id, { status: "running", fb: fbIds, targeting, resolvedAudience: resolved });
  } catch (e) {
    console.error("[ads] launch failed", e);
    return ads.update(ad.id, { status: "error", lastError: e.message });
  }
}
