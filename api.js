const fetch = require("node-fetch");
const crypto = require("crypto");

const GRAPH_HOST = "https://graph.facebook.com";

// The Graph/Marketing API version used when none is set in the plugin
// configuration. Meta releases a new version roughly every three months and
// keeps each one alive for about two years.
const DEFAULT_API_VERSION = "v26.0";

// Meta's Graph API only returns the object id unless you ask for more, so
// every read below has a sensible default set of fields.
const DEFAULT_FIELDS = {
  adaccount: [
    "id",
    "account_id",
    "name",
    "account_status",
    "currency",
    "timezone_name",
    "amount_spent",
    "balance",
    "spend_cap",
    "business_name",
    "created_time",
  ],
  business: ["id", "name", "created_time", "verification_status"],
  campaign: [
    "id",
    "account_id",
    "name",
    "status",
    "effective_status",
    "configured_status",
    "objective",
    "buying_type",
    "bid_strategy",
    "daily_budget",
    "lifetime_budget",
    "budget_remaining",
    "start_time",
    "stop_time",
    "created_time",
    "updated_time",
  ],
  adset: [
    "id",
    "account_id",
    "campaign_id",
    "name",
    "status",
    "effective_status",
    "configured_status",
    "optimization_goal",
    "billing_event",
    "bid_amount",
    "bid_strategy",
    "daily_budget",
    "lifetime_budget",
    "budget_remaining",
    "start_time",
    "end_time",
    "created_time",
    "updated_time",
  ],
  ad: [
    "id",
    "account_id",
    "campaign_id",
    "adset_id",
    "name",
    "status",
    "effective_status",
    "configured_status",
    "bid_amount",
    "preview_shareable_link",
    "creative{id,name,object_type,thumbnail_url,image_url,video_id}",
    "created_time",
    "updated_time",
  ],
  adcreative: [
    "id",
    "account_id",
    "name",
    "status",
    "title",
    "body",
    "image_url",
    "thumbnail_url",
    "link_url",
    "call_to_action_type",
    "effective_object_story_id",
    "object_story_spec",
    "asset_feed_spec",
  ],
};

// Where the wording of an ad can be found: the headline, and the primary text
// that runs above the image. Meta puts both in a different place depending on
// how the ad was built, and nowhere at all on the creative when the ad
// promotes a post that already exists on the page.
const CREATIVE_TEXT_FIELDS = [
  "id",
  "name",
  "title",
  "body",
  "object_story_spec",
  "asset_feed_spec",
  "effective_object_story_id",
];

// Where the picture or the film of an ad can be found. As with the wording,
// Meta keeps this in a different place depending on how the ad was built.
const CREATIVE_MEDIA_FIELDS = [
  "id",
  "name",
  "account_id",
  "object_type",
  "image_url",
  "image_hash",
  "video_id",
  "thumbnail_url",
  "object_story_spec",
  "asset_feed_spec",
  "effective_object_story_id",
];

// Metrics that are valid at every insights level.
const BASE_INSIGHTS_FIELDS = [
  "impressions",
  "reach",
  "frequency",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "spend",
  "actions",
  "action_values",
  "date_start",
  "date_stop",
];

// Naming the level adds the dimension columns that are valid at that level.
const INSIGHTS_LEVEL_FIELDS = {
  account: ["account_id", "account_name"],
  campaign: ["account_id", "account_name", "campaign_id", "campaign_name"],
  adset: [
    "account_id",
    "account_name",
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
  ],
  ad: [
    "account_id",
    "account_name",
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
    "ad_id",
    "ad_name",
  ],
};

// Insights columns that are returned as strings but are really numbers.
const NUMERIC_INSIGHTS_FIELDS = new Set([
  "impressions",
  "reach",
  "frequency",
  "clicks",
  "unique_clicks",
  "inline_link_clicks",
  "ctr",
  "unique_ctr",
  "inline_link_click_ctr",
  "cpc",
  "cpm",
  "cpp",
  "cost_per_inline_link_click",
  "spend",
  "social_spend",
  "objective_results",
]);

const insightsFields = (level) => [
  ...(INSIGHTS_LEVEL_FIELDS[level] || []),
  ...BASE_INSIGHTS_FIELDS,
];

/**
 * Encode one value for the Graph API query string. Arrays of scalars become
 * comma separated lists (fields, breakdowns); anything else structured -
 * time_range, filtering - becomes JSON, which is what Meta expects.
 */
const queryValue = (v) => {
  if (v === null || typeof v === "undefined") return null;
  if (Array.isArray(v))
    return v.every((e) => typeof e === "string" || typeof e === "number")
      ? v.join(",")
      : JSON.stringify(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
};

const toQueryString = (q) =>
  Object.entries(q || {})
    .map(([k, v]) => [k, queryValue(v)])
    .filter(([k, v]) => v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

/** Ad account ids are addressed as act_<id> in the Graph API */
const actId = (accountId) => {
  const s = `${accountId}`.trim();
  return s.startsWith("act_") ? s : `act_${s}`;
};

const appSecretProof = (access_token, app_secret) =>
  crypto.createHmac("sha256", app_secret).update(access_token).digest("hex");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Error codes worth trying again: transient failures and the various
// rate limit / business use case throttling codes.
const TRANSIENT_ERROR_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

const isTransientError = (error) => {
  const code = +error?.code;
  if (TRANSIENT_ERROR_CODES.has(code)) return true;
  return code >= 80000 && code <= 80014;
};

const mkApiError = (error, status) => {
  const bits = [`code ${error?.code}`];
  if (error?.error_subcode) bits.push(`subcode ${error.error_subcode}`);
  if (error?.fbtrace_id) bits.push(`fbtrace_id ${error.fbtrace_id}`);
  const e = new Error(
    `Meta Marketing API error (${bits.join(", ")}): ${
      error?.error_user_msg || error?.message || "unknown error"
    }`,
  );
  e.metaError = error;
  e.status = status;
  return e;
};

const apiUrl = (path, cfg) => {
  if (/^https?:\/\//.test(path)) return path;
  const version = cfg?.api_version || DEFAULT_API_VERSION;
  return `${GRAPH_HOST}/${version}${path.startsWith("/") ? path : `/${path}`}`;
};

/**
 * The single point through which every request to Meta goes.
 *
 * cfg: { access_token, app_id, app_secret, api_version, use_appsecret_proof,
 *        max_retries, log_requests }
 * opts: { method, query, noAuth }
 */
const graphFetch = async (path, opts = {}, cfg = {}) => {
  const { method = "GET", query, noAuth } = opts;
  const url = apiUrl(path, cfg);
  const params = { ...(query || {}) };
  if (
    !noAuth &&
    cfg?.use_appsecret_proof &&
    cfg?.app_secret &&
    cfg?.access_token &&
    !url.includes("appsecret_proof=")
  )
    params.appsecret_proof = appSecretProof(cfg.access_token, cfg.app_secret);

  const qs = toQueryString(params);
  const fullUrl = qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;

  const headers = { Accept: "application/json" };
  if (!noAuth && cfg?.access_token)
    headers.Authorization = `Bearer ${cfg.access_token}`;

  const maxRetries = typeof cfg?.max_retries === "number" ? cfg.max_retries : 3;
  let attempt = 0;

  for (;;) {
    if (cfg?.log_requests) console.log(`Meta ${method} ${fullUrl}`);
    const response = await fetch(fullUrl, { method, headers });
    const body = await response.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch (e) {
      if (response.status >= 500 && attempt < maxRetries) {
        attempt += 1;
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      console.error(
        `Meta Marketing API non-JSON response (HTTP ${response.status})`,
        body,
      );
      throw new Error(
        `Meta Marketing API: not a JSON response (HTTP ${response.status})`,
      );
    }
    if (json && json.error) {
      if (attempt < maxRetries && isTransientError(json.error)) {
        attempt += 1;
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      throw mkApiError(json.error, response.status);
    }
    if (cfg?.log_requests) {
      const usage = response.headers.get("x-business-use-case-usage");
      if (usage) console.log("Meta business use case usage", usage);
    }
    return json;
  }
};

/**
 * Follow the cursor pagination on an edge and return the concatenated rows.
 * Stops after max_pages pages so a misconfigured view cannot walk a whole
 * account's history.
 */
const getAllPages = async (path, query, cfg = {}, opts = {}) => {
  const maxPages = opts.max_pages || cfg?.max_pages || 10;
  let json = await graphFetch(path, { query }, cfg);
  const rows = [...(json?.data || [])];
  let pages = 1;
  while (json?.paging?.next && pages < maxPages) {
    if (cfg?.page_delay)
      await new Promise((resolve) => setTimeout(resolve, cfg?.page_delay));
    json = await graphFetch(json.paging.next, {}, cfg);
    rows.push(...(json?.data || []));
    pages += 1;
  }
  return rows;
};

const withFields = (query, kind) => {
  const q = { ...(query || {}) };
  if (!q.fields && DEFAULT_FIELDS[kind]) q.fields = DEFAULT_FIELDS[kind];
  return q;
};

const withInsightsFields = (query) => {
  const q = { ...(query || {}) };
  if (!q.fields) q.fields = insightsFields(q.level);
  return q;
};

//
// Accounts and businesses
//

const getMe = async (query, cfg) =>
  await graphFetch(
    "/me",
    { query: { fields: "id,name", ...(query || {}) } },
    cfg,
  );

const getAdAccounts = async (query, cfg) =>
  await getAllPages("/me/adaccounts", withFields(query, "adaccount"), cfg);

const getAdAccount = async (accountId, query, cfg) =>
  await graphFetch(
    `/${actId(accountId)}`,
    { query: withFields(query, "adaccount") },
    cfg,
  );

const getBusinesses = async (query, cfg) =>
  await getAllPages("/me/businesses", withFields(query, "business"), cfg);

const getBusinessAdAccounts = async (businessId, query, cfg) =>
  await getAllPages(
    `/${businessId}/owned_ad_accounts`,
    withFields(query, "adaccount"),
    cfg,
  );

//
// Campaigns, ad sets, ads and creatives
//

const getCampaigns = async (accountId, query, cfg) =>
  await getAllPages(
    `/${actId(accountId)}/campaigns`,
    withFields(query, "campaign"),
    cfg,
  );

const getCampaign = async (campaignId, query, cfg) =>
  await graphFetch(
    `/${campaignId}`,
    { query: withFields(query, "campaign") },
    cfg,
  );

const getAdSets = async (accountId, query, cfg) =>
  await getAllPages(
    `/${actId(accountId)}/adsets`,
    withFields(query, "adset"),
    cfg,
  );

const getCampaignAdSets = async (campaignId, query, cfg) =>
  await getAllPages(`/${campaignId}/adsets`, withFields(query, "adset"), cfg);

const getAdSet = async (adSetId, query, cfg) =>
  await graphFetch(`/${adSetId}`, { query: withFields(query, "adset") }, cfg);

const getAds = async (accountId, query, cfg) =>
  await getAllPages(`/${actId(accountId)}/ads`, withFields(query, "ad"), cfg);

const getCampaignAds = async (campaignId, query, cfg) =>
  await getAllPages(`/${campaignId}/ads`, withFields(query, "ad"), cfg);

const getAdSetAds = async (adSetId, query, cfg) =>
  await getAllPages(`/${adSetId}/ads`, withFields(query, "ad"), cfg);

const getAd = async (adId, query, cfg) =>
  await graphFetch(`/${adId}`, { query: withFields(query, "ad") }, cfg);

const getAdCreatives = async (accountId, query, cfg) =>
  await getAllPages(
    `/${actId(accountId)}/adcreatives`,
    withFields(query, "adcreative"),
    cfg,
  );

const getAdCreative = async (creativeId, query, cfg) =>
  await graphFetch(
    `/${creativeId}`,
    { query: withFields(query, "adcreative") },
    cfg,
  );

/** Rendered HTML preview of an ad, as an iframe snippet */
const getAdPreview = async (adId, adFormat, cfg) => {
  const json = await graphFetch(
    `/${adId}/previews`,
    { query: { ad_format: adFormat || "DESKTOP_FEED_STANDARD" } },
    cfg,
  );
  return json?.data?.[0]?.body || "";
};

/**
 * Pull every headline out of a creative, best first. A carousel has one per
 * card and a dynamic creative can carry several for Meta to choose between,
 * so this returns a list rather than a single string.
 */
const creativeHeadlines = (creative) => {
  const spec = creative?.object_story_spec || {};
  const found = [
    creative?.title,
    spec.link_data?.name,
    spec.video_data?.title,
    spec.template_data?.name,
    ...(spec.link_data?.child_attachments || []).map((c) => c.name),
    ...(creative?.asset_feed_spec?.titles || []).map((t) => t.text),
  ];
  return [...new Set(found.filter((h) => h))];
};

/**
 * Pull every primary text out of a creative, best first. This is the longer
 * wording that runs above the image, which Meta calls the primary text in Ads
 * Manager and the body or the message in its API. As with headlines, a
 * dynamic creative can carry several.
 */
const creativeBodies = (creative) => {
  const spec = creative?.object_story_spec || {};
  const found = [
    creative?.body,
    spec.link_data?.message,
    spec.video_data?.message,
    spec.photo_data?.caption,
    spec.text_data?.message,
    spec.template_data?.message,
    ...(creative?.asset_feed_spec?.bodies || []).map((b) => b.text),
  ];
  return [...new Set(found.filter((b) => b))];
};

// A page post is only shown to a token that carries the page's own
// permissions. A token for the page can be asked for, once per page.
const PAGE_TOKEN_TTL_MS = 15 * 60 * 1000;
const pageTokenCache = new Map();

/**
 * A token for one page, from the token in the settings. Comes back null when
 * the settings token has no say over that page, which is the usual reason an
 * ad that boosts a page post has nothing to show.
 */
const getPageAccessToken = async (pageId, cfg) => {
  if (!pageId) return null;
  const key = `${pageId}|${cfg?.access_token || ""}`;
  const hit = pageTokenCache.get(key);
  if (hit && Date.now() - hit.at < PAGE_TOKEN_TTL_MS) return hit.token;
  let token = null;
  try {
    const json = await graphFetch(
      `/${pageId}`,
      { query: { fields: "access_token" } },
      cfg,
    );
    token = json?.access_token || null;
  } catch (e) {
    if (cfg?.log_requests)
      console.log(`Meta: no token for page ${pageId}`, e.message);
  }
  pageTokenCache.set(key, { token, at: Date.now() });
  return token;
};

/**
 * Which tokens to try when reading the post behind an ad, best first: one
 * for the page that owns it, then the one from the settings.
 */
const postTokens = async (creative, storyId, cfg, opts = {}) => {
  const pageId =
    creative?.object_story_spec?.page_id || `${storyId}`.split("_")[0];
  const pageToken =
    opts.page_token === false ? null : await getPageAccessToken(pageId, cfg);
  return {
    pageId,
    pageToken,
    cfgs: pageToken ? [{ ...cfg, access_token: pageToken }, cfg] : [cfg],
  };
};

/**
 * The wording of the page post an ad promotes: the post's own text, and the
 * headline of the link it carries.
 */
const storyText = async (storyId, cfg) => {
  const json = await graphFetch(
    `/${storyId}`,
    { query: { fields: "message,attachments{title,description}" } },
    cfg,
  );
  const attachment = json?.attachments?.data?.[0] || {};
  return {
    headline: attachment.title || "",
    body: json?.message || attachment.description || "",
  };
};

/**
 * The wording of an ad: { headline, body }, where body is the primary text
 * above the image. Takes an ad id, or an ad that has already been read with
 * its creative, in which case nothing is read again.
 *
 * Ads that promote a post which already exists on the page keep their wording
 * on the post, which needs a second read and a token with access to the page.
 * When that read is not allowed the wording comes back empty rather than
 * throwing.
 */
const getAdText = async (ad, cfg, opts = {}) => {
  let creative = typeof ad === "object" ? ad?.creative : null;
  if (!creative?.object_story_spec && !creative?.title && !creative?.body) {
    const fetched = await graphFetch(
      `/${typeof ad === "object" ? ad?.id : ad}`,
      { query: { fields: `creative{${CREATIVE_TEXT_FIELDS.join(",")}}` } },
      cfg,
    );
    creative = fetched?.creative;
  }
  const text = {
    headline: creativeHeadlines(creative)[0] || "",
    body: creativeBodies(creative)[0] || "",
  };
  if ((!text.headline || !text.body) && creative?.effective_object_story_id) {
    const storyId = creative.effective_object_story_id;
    const { cfgs } = await postTokens(creative, storyId, cfg, opts);
    for (const useCfg of cfgs)
      try {
        const story = await storyText(storyId, useCfg);
        return {
          headline: text.headline || story.headline,
          body: text.body || story.body,
        };
      } catch (e) {
        if (cfg?.log_requests)
          console.log("Meta: could not read the post behind the ad", e.message);
      }
  }
  return text;
};

/** The headline of an ad, as getAdText */
const getAdHeadline = async (ad, cfg) => (await getAdText(ad, cfg)).headline;

/** The primary text of an ad, the wording above the image, as getAdText */
const getAdBody = async (ad, cfg) => (await getAdText(ad, cfg)).body;

//
// Media: the picture or the film an ad is built on
//

// What tells two pieces of media apart. The same picture reached by two
// routes - once by hash and once by address - is the same picture.
const MEDIA_IDS = ["video_id", "image_hash", "url"];

/**
 * Add one piece of media to the list, or, when it is already there under
 * another of its names, fill in what that entry was missing.
 */
const addMedia = (out, m) => {
  if (!m || !MEDIA_IDS.some((k) => m[k])) return;
  const same = out.find(
    (o) => o.kind === m.kind && MEDIA_IDS.some((k) => m[k] && o[k] === m[k]),
  );
  if (!same) {
    out.push(m);
    return;
  }
  Object.entries(m).forEach(([k, v]) => {
    if (v && !same[k]) same[k] = v;
  });
};

/** A carousel card, or a plain link ad, which are shaped the same way */
const linkMedia = (data) =>
  data.video_id
    ? {
        kind: "video",
        video_id: data.video_id,
        thumbnail_url: data.picture || data.image_url,
        image_hash: undefined,
        thumbnail_hash: data.image_hash,
        name: data.name,
        link: data.link,
      }
    : {
        kind: "image",
        url: data.picture || data.image_url,
        image_hash: data.image_hash,
        name: data.name,
        link: data.link,
      };

// Where an ad is mostly seen. A platform on its own means every position on it.
const MAIN_PLACEMENTS = ["facebook:feed", "instagram:stream", "facebook", "instagram"];

// The best rule priority of each piece of media on a creative that picks its
// media by placement, kept here rather than in what the caller gets back
const placementPriority = new WeakMap();

/**
 * Where a placement rule shows its asset, as platform:position, or the
 * platform alone when the rule takes every position on it. A rule that names
 * nothing is the catch-all for whatever the other rules leave over.
 */
const rulePlacements = (spec = {}) => {
  const platforms = spec.publisher_platforms?.length
    ? spec.publisher_platforms
    : Object.keys(spec)
        .filter((k) => k.endsWith("_positions"))
        .map((k) => k.replace(/_positions$/, ""));
  return platforms.flatMap((p) => {
    const positions = spec[`${p}_positions`] || [];
    return positions.length ? positions.map((pos) => `${p}:${pos}`) : [p];
  });
};

/**
 * Which placements the rules of a creative give one of its assets to, found
 * through the labels the rules and the asset share. fallback says the asset
 * is only there for the placements no other rule takes.
 */
const placementInfo = (asset, rules) => {
  const labels = asset?.adlabels || [];
  const used = rules.filter((r) =>
    [r.image_label, r.video_label].some(
      (l) => l && labels.some((a) => (l.id && a.id === l.id) || (l.name && a.name === l.name)),
    ),
  );
  if (!used.length) return {};
  const perRule = used.map((r) => rulePlacements(r.customization_spec));
  return {
    placements: [...new Set(perRule.flat())],
    fallback: perRule.every((p) => !p.length),
    priority: Math.min(...used.map((r) => r.priority ?? Number.MAX_SAFE_INTEGER)),
  };
};

const fileName = (url) => {
  try {
    return new URL(url).pathname.split("/").pop();
  } catch (e) {
    return "";
  }
};

/**
 * Put the media of a creative that picks its media by placement in order of
 * how much of the ad it is: what the feed shows, then the picture the ad is
 * known by, then what other placements show in the order Meta checks its
 * rules, then the catch-all, then anything no rule uses. Every other creative
 * keeps the order its media is shown in.
 */
const rankMedia = (media, creative) => {
  if (!media.some((m) => m.placements)) return media;
  const thumb = fileName(creative?.thumbnail_url);
  const rank = (m) => {
    if (!m.placements) return 4;
    if (m.fallback) return 3;
    if (m.placements.some((p) => MAIN_PLACEMENTS.includes(p))) return 0;
    if (thumb && [m.url, m.thumbnail_url].some((u) => u && fileName(u) === thumb))
      return 1;
    return 2;
  };
  const priority = (m) => placementPriority.get(m) ?? Number.MAX_SAFE_INTEGER;
  return media.sort((a, b) => rank(a) - rank(b) || priority(a) - priority(b));
};

/**
 * Every piece of media on a creative, without reading anything further. A
 * video carries its own still as a thumbnail rather than as a picture of its
 * own, so a film never counts as a picture too.
 */
const creativeMedia = (creative) => {
  const spec = creative?.object_story_spec || {};
  const feed = creative?.asset_feed_spec || {};
  const out = [];

  if (spec.video_data)
    addMedia(out, {
      kind: "video",
      video_id: spec.video_data.video_id,
      thumbnail_url: spec.video_data.image_url,
      thumbnail_hash: spec.video_data.image_hash,
      name: spec.video_data.title,
    });
  if (spec.photo_data)
    addMedia(out, {
      kind: "image",
      url: spec.photo_data.url,
      image_hash: spec.photo_data.image_hash,
    });
  [spec.link_data, spec.template_data].forEach((data) => {
    if (!data) return;
    const children = data.child_attachments || [];
    if (children.length) children.forEach((c) => addMedia(out, linkMedia(c)));
    else addMedia(out, linkMedia(data));
  });

  // Flexible and dynamic creatives keep a pool of assets for Meta to choose
  // between, rather than one story. A creative customised by placement has
  // rules saying which asset each placement shows.
  const rules = feed.asset_customization_rules || [];
  const addAsset = (asset, m) => {
    if (rules.length) {
      const { priority, ...info } = placementInfo(asset, rules);
      Object.assign(m, info);
      if (priority !== undefined) placementPriority.set(m, priority);
    }
    addMedia(out, m);
  };
  (feed.videos || []).forEach((v) =>
    addAsset(v, {
      kind: "video",
      video_id: v.video_id,
      thumbnail_url: v.thumbnail_url,
      thumbnail_hash: v.thumbnail_hash,
    }),
  );
  (feed.images || []).forEach((i) =>
    addAsset(i, { kind: "image", url: i.url, image_hash: i.hash }),
  );

  // Last, what the creative says about itself. On many ads this is the same
  // media again, which the key above discards.
  if (creative?.video_id)
    addMedia(out, {
      kind: "video",
      video_id: creative.video_id,
      thumbnail_url: creative.thumbnail_url,
    });
  else if (creative?.image_url || creative?.image_hash)
    addMedia(out, {
      kind: "image",
      url: creative.image_url,
      image_hash: creative.image_hash,
    });

  return rankMedia(out, creative);
};

/**
 * The media on a page post an ad promotes, for ads that carry no creative of
 * their own. An album post holds its pictures one level further down.
 */
const storyMedia = async (storyId, cfg) => {
  const json = await graphFetch(
    `/${storyId}`,
    {
      query: {
        fields:
          "permalink_url,full_picture," +
          "attachments{media_type,media,target,url,subattachments{media_type,media,target}}",
      },
    },
    cfg,
  );
  const out = [];
  let album = false;
  const fromAttachment = (att) => {
    if (!att) return;
    const type = `${att.media_type || ""}`.toLowerCase();
    const still = att.media?.image?.src;
    if (type.includes("video"))
      addMedia(out, {
        kind: "video",
        video_id: att.target?.id,
        thumbnail_url: still,
      });
    else if (still) addMedia(out, { kind: "image", url: still });
  };
  (json?.attachments?.data || []).forEach((att) => {
    const subs = att.subattachments?.data || [];
    if (subs.length > 1) album = true;
    if (subs.length) subs.forEach(fromAttachment);
    else fromAttachment(att);
  });
  // full_picture is whatever the post shows in a feed. For a film that is a
  // still rather than the film, so it is offered as a thumbnail and never as
  // a picture in its own right.
  return {
    media: out,
    album,
    thumbnail_url: json?.full_picture,
    permalink_url: json?.permalink_url,
  };
};

/**
 * The media on the post an ad boosts, tried first with a token for the page
 * that owns the post and then with the token from the settings. Never
 * throws: what went wrong comes back as the reason, to be reported on the ad
 * rather than stopping a run over a whole ad set.
 */
const postMedia = async (creative, cfg, opts = {}) => {
  const storyId = creative?.effective_object_story_id;
  if (!storyId) return { media: [] };
  const { pageId, pageToken, cfgs } = await postTokens(
    creative,
    storyId,
    cfg,
    opts,
  );
  let reason;
  for (const useCfg of cfgs) {
    try {
      const post = await storyMedia(storyId, useCfg);
      if (post.media.length) return { ...post, story_id: storyId };
      reason = `the post ${storyId} behind this ad carries no picture or film`;
    } catch (e) {
      reason = `could not read the post ${storyId} behind this ad: ${e.message}`;
      if (cfg?.log_requests) console.log(`Meta: ${reason}`);
    }
  }
  if (!pageToken)
    reason = `${reason}. The access token has no say over page ${pageId}: to see what an ad that boosts a page post is made of, use a token that can also read that page, with the pages_read_engagement permission`;
  return { media: [], story_id: storyId, error: reason };
};

/**
 * Turn the ids and hashes collected above into addresses a file can be
 * downloaded from. Videos are read one at a time, pictures all in one go.
 *
 * The address of a video is only given out to a token that owns it, and it is
 * signed and short lived, so download it now rather than storing it. When it
 * cannot be read the entry keeps its id and its thumbnail.
 */
const resolveMediaUrls = async (media, accountId, cfg) => {
  const videos = media.filter((m) => m.kind === "video" && m.video_id);
  for (const m of videos) {
    try {
      const v = await graphFetch(
        `/${m.video_id}`,
        {
          query: {
            fields: "id,source,picture,permalink_url,length,created_time",
          },
        },
        cfg,
      );
      m.url = v?.source || m.url;
      m.thumbnail_url = m.thumbnail_url || v?.picture;
      m.permalink_url = v?.permalink_url;
      if (typeof v?.length === "number") m.length = v.length;
    } catch (e) {
      m.error = e.message;
      if (cfg?.log_requests)
        console.log(`Meta: could not read video ${m.video_id}`, e.message);
    }
  }

  const needHash = media.filter((m) => !m.url && m.image_hash);
  if (!needHash.length) return media;
  if (!accountId) {
    needHash.forEach((m) => {
      m.error =
        "the address of this picture is held by the ad account, which is not known here: pass the ad account id, or set a default one in the settings";
    });
    return media;
  }

  // The picture library only answers about so many at a time
  const hashes = [...new Set(needHash.map((m) => m.image_hash))];
  const byHash = {};
  let reason;
  for (let i = 0; i < hashes.length; i += 50) {
    try {
      const json = await graphFetch(
        `/${actId(accountId)}/adimages`,
        {
          query: {
            // a list of its own, not the comma separated kind Meta takes
            // elsewhere
            hashes: JSON.stringify(hashes.slice(i, i + 50)),
            fields: "hash,url,permalink_url,width,height",
          },
        },
        cfg,
      );
      // Depending on the API version this comes back as a list or as an
      // object keyed by hash
      const images = Array.isArray(json?.data)
        ? json.data
        : Object.values(json?.images || {});
      images.forEach((img) => {
        if (img?.hash) byHash[img.hash] = img;
      });
    } catch (e) {
      reason = `could not read the pictures of ad account ${actId(
        accountId,
      )}: ${e.message}`;
      if (cfg?.log_requests) console.log(`Meta: ${reason}`);
    }
  }
  needHash.forEach((m) => {
    const img = byHash[m.image_hash];
    if (!img) {
      m.error =
        reason ||
        `the ad account has no picture with the hash ${m.image_hash}. It may belong to another ad account, or to the page rather than to the ad`;
      return;
    }
    m.url = img.url;
    m.permalink_url = img.permalink_url;
    m.width = img.width;
    m.height = img.height;
  });

  return media;
};

/**
 * Why some of what an ad is made of has no address to download it from,
 * said once rather than once per picture.
 */
const mediaErrors = (media) => {
  // A catch-all that cannot be reached does not matter while what the ad
  // shows can be
  const shownReached = media.some((m) => m.url && !m.fallback);
  const stuck = media.filter(
    (m) => m.error && !m.url && !(m.fallback && shownReached),
  );
  if (!stuck.length) return undefined;
  const reasons = [...new Set(stuck.map((m) => m.error))];
  return `${stuck.length} of ${media.length} could not be reached: ${reasons.join(
    "; ",
  )}`;
};

/** What kind of ad this is, from the media it was built on */
const mediaType = (media) => {
  // The catch-all of a creative customised by placement only fills the
  // placements its other rules leave over, which is not what the ad is
  const shown = media.filter((m) => !m.fallback);
  const pool = shown.length ? shown : media;
  const hasVideo = pool.some((m) => m.kind === "video");
  const hasImage = pool.some((m) => m.kind === "image");
  if (hasVideo && hasImage) return "mixed";
  if (hasVideo) return "video";
  if (hasImage) return "image";
  return "unknown";
};

/**
 * What an ad is made of and where to download it from:
 *
 *   { type, carousel, media: [{ kind, url, thumbnail_url, ... }],
 *     creative_id, object_type, thumbnail_url, from_post, story_id, error }
 *
 * type is image, video, mixed - a dynamic creative offering Meta both - or
 * unknown when nothing could be found. carousel says whether the ad holds
 * more than one card; the cards are the media list, in the order they are
 * shown. thumbnail_url is a picture of the ad as it appears, which is there
 * even when the media itself cannot be reached, and error says why it could
 * not.
 *
 * Takes an ad id, or an ad row that already has its creative. A creative
 * that carries no media is read again in full, since the caller may have
 * asked Meta for only some of the places media can hide, so an ad read with
 * the media fields of its own saves a read here.
 *
 * Options: resolve_urls false skips turning video ids and image hashes into
 * addresses, which saves a read per video when all you want is the type;
 * page_token false stops it asking for a token for the page behind a boosted
 * post.
 */
const getAdMedia = async (ad, cfg, opts = {}) => {
  const adId = typeof ad === "object" ? ad?.id : ad;
  let creative = typeof ad === "object" ? ad?.creative : null;
  let accountId =
    opts.account_id ||
    (typeof ad === "object" ? ad?.account_id : null) ||
    creative?.account_id;
  let media = creativeMedia(creative);

  // Nothing on what we were handed. Ask for every field media can arrive in
  // before giving up on the creative, and for a thumbnail big enough to be
  // worth looking at.
  if (!media.length && adId) {
    const fetched = await graphFetch(
      `/${adId}`,
      {
        query: {
          fields: `account_id,creative{${CREATIVE_MEDIA_FIELDS.join(",")}}`,
          thumbnail_width: opts.thumbnail_width || 1200,
          thumbnail_height: opts.thumbnail_height || 1200,
        },
      },
      cfg,
    );
    creative = fetched?.creative || creative;
    accountId = accountId || fetched?.account_id || creative?.account_id;
    media = creativeMedia(creative);
  }
  accountId = accountId || cfg?.ad_account_id;

  // Still nothing: an ad that boosts a post keeps its media on the post
  let post = {};
  if (!media.length) {
    post = await postMedia(creative, cfg, opts);
    media = post.media;
  }

  if (opts.resolve_urls !== false) {
    await resolveMediaUrls(media, accountId, cfg);
    // Found something, but none of it can be downloaded: a creative can name
    // pictures the ad account does not hold. The post an ad boosts carries
    // addresses that work, so it is worth asking after all.
    if (
      media.length &&
      !media.some((m) => m.url) &&
      !post.media &&
      creative?.effective_object_story_id
    ) {
      const fallback = await postMedia(creative, cfg, opts);
      await resolveMediaUrls(fallback.media, accountId, cfg);
      if (fallback.media.some((m) => m.url)) {
        post = fallback;
        media = fallback.media;
      }
    }
    // With addresses known, the picture the ad is known by can be told apart
    rankMedia(media, creative);
  }

  const children =
    creative?.object_story_spec?.link_data?.child_attachments ||
    creative?.object_story_spec?.template_data?.child_attachments ||
    [];
  return {
    type: mediaType(media),
    carousel: children.length > 1 || !!post.album,
    media,
    creative_id: creative?.id,
    object_type: creative?.object_type,
    thumbnail_url: creative?.thumbnail_url || post.thumbnail_url,
    from_post: !!post.media?.length,
    story_id: post.story_id,
    permalink_url: post.permalink_url,
    error: post.error || mediaErrors(media),
  };
};

/** Whether an ad is an image, a video, mixed or unknown, as getAdMedia */
const getAdMediaType = async (ad, cfg) =>
  (await getAdMedia(ad, cfg, { resolve_urls: false })).type;

/**
 * The address of the first picture or film in an ad, ready to download, or
 * the empty string when there is none
 */
const getAdMediaUrl = async (ad, cfg) => {
  const { media } = await getAdMedia(ad, cfg);
  return media.find((m) => m.url)?.url || "";
};

//
// Insights
//

const getInsights = async (objectId, query, cfg, opts) =>
  await getAllPages(
    `/${objectId}/insights`,
    withInsightsFields(query),
    cfg,
    opts,
  );

/** Kick off an asynchronous insights job, returns { report_run_id } */
const startInsightsReport = async (objectId, query, cfg) =>
  await graphFetch(
    `/${objectId}/insights`,
    { method: "POST", query: withInsightsFields(query) },
    cfg,
  );

const getReportRun = async (reportRunId, cfg) =>
  await graphFetch(
    `/${reportRunId}`,
    {
      query: {
        fields: "id,async_status,async_percent_completion,date_start,date_stop",
      },
    },
    cfg,
  );

const getReportRunInsights = async (reportRunId, query, cfg, opts) =>
  await getAllPages(`/${reportRunId}/insights`, query, cfg, opts);

/**
 * The full asynchronous insights flow: submit the job, poll it to completion
 * and read the results. Use this for large reports that time out when read
 * synchronously.
 */
const getInsightsAsync = async (objectId, query, cfg, opts = {}) => {
  const pollInterval = opts.poll_interval_ms || 5000;
  const timeout = opts.timeout_ms || 10 * 60 * 1000;
  const { report_run_id } = await startInsightsReport(objectId, query, cfg);
  if (!report_run_id)
    throw new Error("Meta Marketing API: no report_run_id returned");
  const startedAt = Date.now();
  for (;;) {
    const run = await getReportRun(report_run_id, cfg);
    if (run?.async_status === "Job Completed") break;
    if (["Job Failed", "Job Skipped"].includes(run?.async_status))
      throw new Error(
        `Meta Marketing API: insights job ${run.async_status} (${report_run_id})`,
      );
    if (Date.now() - startedAt > timeout)
      throw new Error(
        `Meta Marketing API: insights job timed out (${report_run_id})`,
      );
    await sleep(pollInterval);
  }
  return await getReportRunInsights(report_run_id, {}, cfg, opts);
};

//
// Tokens
//

/** Exchange a short lived (or expiring) user token for a long lived one */
const exchangeLongLivedToken = async (app_id, app_secret, access_token, cfg) =>
  await graphFetch(
    "/oauth/access_token",
    {
      noAuth: true,
      query: {
        grant_type: "fb_exchange_token",
        client_id: app_id,
        client_secret: app_secret,
        fb_exchange_token: access_token,
      },
    },
    cfg,
  );

/** Inspect a token: which app it belongs to, when it expires, its scopes */
const debugToken = async (token, app_id, app_secret, cfg) => {
  const json = await graphFetch(
    "/debug_token",
    {
      noAuth: true,
      query: {
        input_token: token,
        access_token: `${app_id}|${app_secret}`,
      },
    },
    cfg,
  );
  return json?.data || json;
};

module.exports = {
  GRAPH_HOST,
  DEFAULT_API_VERSION,
  DEFAULT_FIELDS,
  CREATIVE_TEXT_FIELDS,
  CREATIVE_MEDIA_FIELDS,
  BASE_INSIGHTS_FIELDS,
  INSIGHTS_LEVEL_FIELDS,
  NUMERIC_INSIGHTS_FIELDS,
  insightsFields,
  queryValue,
  toQueryString,
  actId,
  appSecretProof,
  isTransientError,
  graphFetch,
  getAllPages,
  getMe,
  getAdAccounts,
  getAdAccount,
  getBusinesses,
  getBusinessAdAccounts,
  getCampaigns,
  getCampaign,
  getAdSets,
  getCampaignAdSets,
  getAdSet,
  getAds,
  getCampaignAds,
  getAdSetAds,
  getAd,
  getAdCreatives,
  getAdCreative,
  getAdPreview,
  creativeHeadlines,
  creativeBodies,
  storyText,
  getAdText,
  getAdHeadline,
  getAdBody,
  creativeMedia,
  storyMedia,
  postMedia,
  postTokens,
  getPageAccessToken,
  mediaErrors,
  mediaType,
  getAdMedia,
  getAdMediaType,
  getAdMediaUrl,
  getInsights,
  startInsightsReport,
  getReportRun,
  getReportRunInsights,
  getInsightsAsync,
  exchangeLongLivedToken,
  debugToken,
};
