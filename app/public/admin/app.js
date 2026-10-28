const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]);

let status = {};

// ------------------------------------------------------------------ api

async function api(method, url, body) {
  const init = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast ${isErr ? "err" : ""}`;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), 4000);
}

async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
    throw e;
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// --------------------------------------------------------------- shared

// Local date/time inputs → ISO strings the server understands.
const isoFromLocal = (v) => (v ? new Date(v).toISOString() : null);
const startOfDay = (d) => (d ? new Date(`${d}T00:00`).toISOString() : null);
const endOfDay = (d) => (d ? new Date(`${d}T23:59`).toISOString() : null);
const localDate = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Camera and gallery inputs both feed one list of photos per form.
function photoPicker(form) {
  const files = [];
  const thumbs = $("[data-thumbs]", form);
  for (const input of $$('input[type="file"]', form)) {
    input.addEventListener("change", () => {
      for (const f of input.files) if (files.length < 4) files.push(f);
      input.value = "";
      thumbs.innerHTML = files.map((f) => `<img src="${URL.createObjectURL(f)}" alt="">`).join("");
    });
  }
  return {
    files,
    clear() {
      files.length = 0;
      thumbs.innerHTML = "";
    },
  };
}

function analyzeRequest(files, { price, hint }) {
  const fd = new FormData();
  files.forEach((f) => fd.append("photos", f));
  if (price) fd.append("price", price);
  if (hint) fd.append("hint", hint);
  return api("POST", "/api/products/analyze", fd);
}

function adStartIso(dateStr) {
  // Starting "today" means now, not midnight that has already passed.
  return !dateStr || dateStr === localDate() ? new Date().toISOString() : startOfDay(dateStr);
}

// ------------------------------------------------------------------ tabs

$$(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    $$(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    $$(".tab").forEach((t) => (t.hidden = t.id !== `tab-${b.dataset.tab}`));
    if (b.dataset.tab === "library") loadLibrary();
  }),
);

// ============================================================ AUTOPILOT

const autoForm = $("#autoForm");
const autoPhotos = photoPicker(autoForm);
autoForm.adStart.value = localDate();
autoForm.adEnd.value = localDate(7);
autoForm.runAd.addEventListener("change", () => ($("[data-ad-fields]", autoForm).hidden = !autoForm.runAd.checked));

autoForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = autoForm;
  if (!autoPhotos.files.length) return toast("আগে পণ্যের ছবি দিন", true);
  if (f.runAd.checked) {
    if (!f.audience.value.trim()) return toast("অডিয়েন্স লিখুন", true);
    const money = `$${f.budget.value} ${f.budgetType.value === "daily" ? "প্রতিদিন" : "মোট"}`;
    const real = !status.adsDryRun;
    if (real && !confirm(`এই অ্যাডে ${money} খরচ হবে (${f.adStart.value} → ${f.adEnd.value})। চালিয়ে যাবেন?`)) return;
  }

  const log = $("#autoLog");
  log.innerHTML = "";
  log.hidden = false;
  $("#autoResult").innerHTML = "";
  const btn = $("button[type=submit]", f);
  btn.disabled = true;

  const step = async (label, fn) => {
    const li = document.createElement("li");
    li.className = "run";
    li.textContent = `⏳ ${label}`;
    log.append(li);
    try {
      const out = await fn();
      li.className = "ok";
      li.textContent = `✅ ${label}`;
      return out;
    } catch (err) {
      li.className = "err";
      li.textContent = `❌ ${label}: ${err.message}`;
      throw err;
    }
  };

  try {
    let product = await step("ছবি থেকে ব্যাকগ্রাউন্ড রিমুভ ও পণ্যের তথ্য বের করা", () =>
      analyzeRequest(autoPhotos.files, { price: f.price.value, hint: f.hint.value }),
    );
    product = await step("ওয়েবসাইটে পণ্য প্রকাশ", () => api("POST", `/api/products/${product.id}/publish`));
    const creatives = await step("AI ক্রিয়েটিভ তৈরি", () =>
      api("POST", `/api/products/${product.id}/creatives`, { offer: f.offer.value, templates: [f.template.value] }),
    );
    const caption = await step("ফেসবুক ক্যাপশন লেখা", () =>
      api("POST", `/api/products/${product.id}/caption`, { offer: f.offer.value, language: f.captionLanguage.value }),
    );
    const post = await step(f.publishAt.value ? "ফেসবুক পোস্ট শিডিউল" : "ফেসবুকে পোস্ট", () =>
      api("POST", "/api/posts", {
        productId: product.id,
        creativeUrl: creatives[0].url,
        message: caption.full,
        publishAt: isoFromLocal(f.publishAt.value),
      }),
    );
    let ad = null;
    if (f.runAd.checked) {
      const aud = await step("অডিয়েন্স বোঝা ও টার্গেটিং তৈরি", () =>
        api("POST", "/api/ads/audience", { text: f.audience.value, productId: product.id }),
      );
      ad = await step("অ্যাড চালু", () =>
        api("POST", "/api/ads", {
          postId: post.id,
          budget: f.budget.value,
          budgetType: f.budgetType.value,
          goal: f.goal.value,
          startTime: adStartIso(f.adStart.value),
          endTime: endOfDay(f.adEnd.value),
          audience: aud.audience,
        }),
      );
      if (ad.status === "error") throw new Error(ad.lastError);
    }
    $("#autoResult").innerHTML = resultCard({ product, creative: creatives[0], caption, post, ad });
    autoPhotos.clear();
  } catch {
    // Already shown in the log.
  } finally {
    btn.disabled = false;
  }
});

function resultCard({ product, creative, caption, post, ad }) {
  return `<div class="result">
    <strong>${esc(product.name)}</strong> — ওয়েবসাইটে প্রকাশিত: <a href="${esc(product.url)}" target="_blank">${esc(product.url)}</a>
    <img src="${esc(creative.url)}" alt="">
    <p style="white-space:pre-wrap">${esc(caption.full)}</p>
    <p>পোস্ট: <span class="pill ${post.status}">${post.status}</span> ${post.dryRun ? "(ডেমো মোড)" : ""}
      ${post.status === "scheduled" ? `— ${new Date(post.publishAt).toLocaleString()}` : ""}
      ${post.permalink ? `<a href="${esc(post.permalink)}" target="_blank">দেখুন ↗</a>` : ""}</p>
    ${ad ? `<p>অ্যাড: <span class="pill ${ad.status}">${ad.status}</span> $${ad.budget} ${ad.budgetType === "daily" ? "/দিন" : "মোট"} · ${esc(ad.audience.summary)}
      ${ad.status === "waiting_for_post" ? "<br><small class='muted'>পোস্ট প্রকাশ হলেই অ্যাড নিজে থেকে চালু হবে</small>" : ""}</p>` : ""}
  </div>`;
}

// ========================================================== STEP BY STEP

let current = null; // product being worked on
let chosenCreative = null;
let currentPost = null;
let currentAudience = null;

const analyzeForm = $("#analyzeForm");
const stepPhotos = photoPicker(analyzeForm);

analyzeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!stepPhotos.files.length) return toast("আগে ছবি দিন", true);
  const btn = $("button[type=submit]", analyzeForm);
  current = await busy(btn, "AI কাজ করছে… (৩০-৬০ সেকেন্ড)", () =>
    analyzeRequest(stepPhotos.files, { price: analyzeForm.price.value, hint: analyzeForm.hint.value }),
  );
  stepPhotos.clear();
  showProduct();
});

const FIELDS = [
  ["name", "পণ্যের নাম"],
  ["brand", "ব্র্যান্ড"],
  ["category", "ক্যাটাগরি"],
  ["subCategory", "সাব-ক্যাটাগরি"],
  ["size", "সাইজ / ওজন"],
  ["price", "বিক্রয় মূল্য (৳)", "number"],
  ["mrp", "MRP (৳)", "number"],
  ["stock", "স্টক", "number"],
  ["expiryDate", "মেয়াদ শেষ", "date"],
  ["manufactureDate", "উৎপাদন তারিখ", "date"],
  ["batchNo", "ব্যাচ নং"],
  ["countryOfOrigin", "উৎপত্তি দেশ"],
  ["shortDescription", "ছোট বিবরণ", "textarea"],
  ["description", "বিস্তারিত বিবরণ", "textarea"],
  ["keyBenefits", "মূল সুবিধা (প্রতি লাইনে একটি)", "list"],
  ["keyIngredients", "উপাদান (কমা দিয়ে)", "csv"],
  ["howToUse", "ব্যবহারবিধি", "textarea"],
  ["tags", "ট্যাগ (কমা দিয়ে)", "csv"],
];

// Map AI's snake_case uncertain field names to our form keys.
const UNCERTAIN = {
  product_name: "name", sub_category: "subCategory", expiry_date: "expiryDate", manufacture_date: "manufactureDate",
  batch_no: "batchNo", country_of_origin: "countryOfOrigin", key_ingredients: "keyIngredients", key_benefits: "keyBenefits",
  short_description: "shortDescription", how_to_use: "howToUse",
};

function showProduct() {
  const p = current;
  const uncertain = new Set((p.uncertainFields || []).map((f) => UNCERTAIN[f] || f));
  if (!p.price) uncertain.add("price");
  $("#stepProduct [data-main]").src = `${p.images.main}?t=${Date.now()}`;
  $("#stepProduct [data-cutout]").href = p.images.cutout;
  $("#productForm").innerHTML = FIELDS.map(([key, label, type]) => {
    const v = p[key];
    const cls = uncertain.has(key) ? "warn" : "";
    const hint = uncertain.has(key) ? `<span class="hint">⚠ যাচাই করুন</span>` : "";
    if (type === "textarea" || type === "list") {
      const text = type === "list" ? (v || []).join("\n") : v || "";
      return `<label class="${cls}">${label} ${hint}<textarea name="${key}" rows="${type === "list" ? 4 : 3}">${esc(text)}</textarea></label>`;
    }
    const val = type === "csv" ? (v || []).join(", ") : v ?? "";
    return `<label class="${cls}">${label} ${hint}<input name="${key}" type="${type === "csv" ? "text" : type || "text"}" value="${esc(val)}"></label>`;
  }).join("");
  updateLive();
  $("#stepProduct").hidden = false;
  $("#stepCreative").hidden = false;
  $("#stepCaption").hidden = false;
  $("#stepPost").hidden = true;
  $("#stepAd").hidden = true;
  $("#creatives").innerHTML = "";
  $("#caption").value = "";
  chosenCreative = null;
  $("#stepProduct").scrollIntoView({ behavior: "smooth" });
}

function readProductForm() {
  const out = {};
  for (const [key, , type] of FIELDS) {
    const el = $(`#productForm [name="${key}"]`);
    if (type === "list") out[key] = el.value.split("\n").map((s) => s.trim()).filter(Boolean);
    else if (type === "csv") out[key] = el.value.split(",").map((s) => s.trim()).filter(Boolean);
    else out[key] = el.value.trim() === "" ? null : el.value.trim();
  }
  return out;
}

function updateLive() {
  const a = $("#productLive");
  a.hidden = current.status !== "published";
  a.href = current.url || "#";
}

$("#saveProduct").addEventListener("click", (e) =>
  busy(e.target, "সেভ হচ্ছে…", async () => {
    current = await api("PATCH", `/api/products/${current.id}`, readProductForm());
    toast("সেভ হয়েছে");
  }),
);

$("#publishProduct").addEventListener("click", (e) =>
  busy(e.target, "প্রকাশ হচ্ছে…", async () => {
    await api("PATCH", `/api/products/${current.id}`, readProductForm());
    current = await api("POST", `/api/products/${current.id}/publish`);
    updateLive();
    toast("ওয়েবসাইটে প্রকাশিত হয়েছে");
  }),
);

$("#makeCreatives").addEventListener("click", (e) =>
  busy(e.target, "বানানো হচ্ছে…", async () => {
    await api("PATCH", `/api/products/${current.id}`, readProductForm());
    const list = await api("POST", `/api/products/${current.id}/creatives`, {
      offer: $("#creativeOffer").value,
      language: $("#creativeLang").value,
    });
    $("#creatives").innerHTML = list
      .map(
        (c, i) => `<div class="creative ${i === 0 ? "on" : ""}" data-url="${esc(c.url)}">
        <img src="${esc(c.url)}" alt="">
        <div class="meta"><span>${esc(c.template)}</span><a href="${esc(c.url)}" download>ডাউনলোড</a></div></div>`,
      )
      .join("");
    chosenCreative = list[0]?.url;
    $("#stepPost").hidden = false;
  }),
);

$("#creatives").addEventListener("click", (e) => {
  const card = e.target.closest(".creative");
  if (!card || e.target.tagName === "A") return;
  $$(".creative").forEach((c) => c.classList.toggle("on", c === card));
  chosenCreative = card.dataset.url;
});

$("#makeCaption").addEventListener("click", (e) =>
  busy(e.target, "লেখা হচ্ছে…", async () => {
    const r = await api("POST", `/api/products/${current.id}/caption`, {
      tone: $("#captionTone").value,
      language: $("#captionLang").value,
      offer: $("#creativeOffer").value,
    });
    $("#caption").value = r.full;
    $("#stepPost").hidden = false;
  }),
);

$("#doPost").addEventListener("click", (e) =>
  busy(e.target, "পোস্ট হচ্ছে…", async () => {
    if (!$("#caption").value.trim()) throw new Error("আগে ক্যাপশন লিখুন");
    currentPost = await api("POST", "/api/posts", {
      productId: current.id,
      creativeUrl: chosenCreative,
      message: $("#caption").value,
      publishAt: isoFromLocal($("#postAt").value),
    });
    current = await api("GET", `/api/products/${current.id}`);
    updateLive();
    $("#postResult").innerHTML = `<div class="result">পোস্ট: <span class="pill ${currentPost.status}">${currentPost.status}</span>
      ${currentPost.dryRun ? "(ডেমো মোড — ফেসবুক কানেক্ট করা নেই)" : ""}
      ${currentPost.permalink ? `<a href="${esc(currentPost.permalink)}" target="_blank">দেখুন ↗</a>` : ""}</div>`;
    $("#adStart").value = localDate();
    $("#adEnd").value = localDate(7);
    $("#stepAd").hidden = false;
  }),
);

$("#previewAudience").addEventListener("click", (e) =>
  busy(e.target, "বোঝা হচ্ছে…", async () => {
    const r = await api("POST", "/api/ads/audience", { text: $("#adAudience").value, productId: current?.id });
    currentAudience = r.audience;
    $("#audiencePreview").innerHTML = audienceHtml(r);
    $("#launchAd").disabled = false;
  }),
);

function audienceHtml({ audience: a, resolved }) {
  const g = { all: "সবাই", male: "পুরুষ", female: "নারী" }[a.genders];
  const places = resolved.cities.length ? resolved.cities.map((c) => c.name).join(", ") : a.countries.join(", ");
  return `<div class="result">
    <strong>${esc(a.summary)}</strong><br>
    বয়স ${a.age_min}–${a.age_max} · ${g} · ${esc(places)}<br>
    আগ্রহ: ${esc(resolved.interests.map((i) => i.name).join(", ") || "—")}
  </div>`;
}

$("#launchAd").addEventListener("click", (e) =>
  busy(e.target, "চালু হচ্ছে…", async () => {
    const budget = $("#adBudget").value;
    if (!status.adsDryRun && !confirm(`এই অ্যাডে $${budget} (${$("#adBudgetType").value}) খরচ হবে। নিশ্চিত?`)) return;
    const ad = await api("POST", "/api/ads", {
      postId: currentPost.id,
      budget,
      budgetType: $("#adBudgetType").value,
      goal: $("#adGoal").value,
      startTime: adStartIso($("#adStart").value),
      endTime: endOfDay($("#adEnd").value),
      audience: currentAudience,
    });
    $("#adResult").innerHTML = `<div class="result ${ad.status === "error" ? "err" : ""}">অ্যাড: <span class="pill ${ad.status}">${ad.status}</span>
      ${ad.lastError ? esc(ad.lastError) : ""}
      ${ad.status === "waiting_for_post" ? "পোস্ট প্রকাশ হলেই অ্যাড চালু হবে" : ""}</div>`;
  }),
);

// ============================================================== LIBRARY

async function loadLibrary() {
  const [ps, posts, ads] = await Promise.all([api("GET", "/api/products"), api("GET", "/api/posts"), api("GET", "/api/ads")]);

  $("#adsList").innerHTML =
    ads
      .map((a) => {
        const i = a.insights;
        const stats = i ? ` · খরচ $${i.spend} · রিচ ${i.reach} · ইমপ্রেশন ${i.impressions}` : "";
        const action =
          a.status === "running" ? `<button class="link" data-ad="${a.id}" data-act="pause">Pause</button>`
          : a.status === "paused" ? `<button class="link" data-ad="${a.id}" data-act="resume">Resume</button>`
          : a.status === "error" ? `<button class="link" data-ad="${a.id}" data-act="retry">Retry</button>` : "";
        return `<div class="list-item"><div class="grow">
          <div class="title">${esc(a.productName)} <span class="pill ${a.status}">${a.status}</span> ${a.dryRun ? '<span class="pill">demo</span>' : ""}</div>
          <div class="small muted">$${a.budget} ${a.budgetType === "daily" ? "/দিন" : "মোট"} · ${a.startTime.slice(0, 10)} → ${(a.endTime || "").slice(0, 10)}${stats}</div>
          <div class="small muted">${esc(a.audience?.summary || "")}</div>
          ${a.lastError ? `<div class="small" style="color:var(--err)">${esc(a.lastError)}</div>` : ""}
        </div>${action}</div>`;
      })
      .join("") || `<p class="muted">এখনো কোনো অ্যাড নেই</p>`;

  $("#postsList").innerHTML =
    posts
      .map(
        (p) => `<div class="list-item"><img src="${esc(p.creativeUrl)}" alt=""><div class="grow">
        <div class="title">${esc(p.productName)} <span class="pill ${p.status}">${p.status}</span> ${p.dryRun ? '<span class="pill">demo</span>' : ""}</div>
        <div class="small muted">${new Date(p.publishAt).toLocaleString()}</div></div>
        ${p.permalink ? `<a class="small" href="${esc(p.permalink)}" target="_blank">দেখুন ↗</a>` : ""}</div>`,
      )
      .join("") || `<p class="muted">এখনো কোনো পোস্ট নেই</p>`;

  $("#productsList").innerHTML =
    ps
      .map(
        (p) => `<div class="list-item"><img src="${esc(p.images.main)}" alt=""><div class="grow">
        <div class="title">${esc(p.name)} <span class="pill ${p.status}">${p.status}</span></div>
        <div class="small muted">${esc(p.brand || "")} · ${esc(p.category || "")} · ৳${p.price ?? "—"}${p.expiryDate ? ` · মেয়াদ ${esc(p.expiryDate)}` : ""}</div></div>
        <button class="link" data-edit="${p.id}">এডিট</button>
        <button class="link" data-del="${p.id}">মুছুন</button></div>`,
      )
      .join("") || `<p class="muted">এখনো কোনো পণ্য নেই</p>`;
}

$("#tab-library").addEventListener("click", async (e) => {
  const t = e.target;
  try {
    if (t.dataset.ad) {
      await api("POST", `/api/ads/${t.dataset.ad}/${t.dataset.act}`);
      loadLibrary();
    } else if (t.dataset.del) {
      if (!confirm("এই পণ্যটি মুছে ফেলবেন?")) return;
      await api("DELETE", `/api/products/${t.dataset.del}`);
      loadLibrary();
    } else if (t.dataset.edit) {
      current = await api("GET", `/api/products/${t.dataset.edit}`);
      $('.tabs button[data-tab="steps"]').click();
      showProduct();
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// ================================================================= boot

(async () => {
  status = await api("GET", "/api/status");
  document.documentElement.style.setProperty("--brand", status.shop.brandColor);
  $("#shopName").textContent = `${status.shop.name} · Autopilot`;
  const notes = [];
  if (status.facebookDryRun) notes.push("ডেমো মোড: ফেসবুক কানেক্ট করা নেই — পোস্ট/অ্যাড শুধু সিমুলেট হবে");
  else if (status.adsDryRun) notes.push("অ্যাড ডেমো মোডে (FB_AD_ACCOUNT_ID দেওয়া নেই)");
  if (!status.adsDryRun && status.adAccount?.currency && status.adAccount.currency !== "USD") {
    notes.push(`সতর্কতা: অ্যাড অ্যাকাউন্টের কারেন্সি ${status.adAccount.currency} — বাজেট সেই কারেন্সিতে ধরা হবে`);
  }
  if (status.adAccount?.error) notes.push(`অ্যাড অ্যাকাউন্ট: ${status.adAccount.error}`);
  if (notes.length) {
    $("#modeBanner").textContent = notes.join(" · ");
    $("#modeBanner").hidden = false;
  }
})().catch((e) => toast(e.message, true));
