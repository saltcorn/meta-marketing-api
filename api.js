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
    "creative{id,name,thumbnail_url}",
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
    }`
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

  const maxRetries =
    typeof cfg?.max_retries === "number" ? cfg.max_retries : 3;
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
        body
      );
      throw new Error(
        `Meta Marketing API: not a JSON response (HTTP ${response.status})`
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
  await graphFetch("/me", { query: { fields: "id,name", ...(query || {}) } }, cfg);

const getAdAccounts = async (query, cfg) =>
  await getAllPages("/me/adaccounts", withFields(query, "adaccount"), cfg);

const getAdAccount = async (accountId, query, cfg) =>
  await graphFetch(
    `/${actId(accountId)}`,
    { query: withFields(query, "adaccount") },
    cfg
  );

const getBusinesses = async (query, cfg) =>
  await getAllPages("/me/businesses", withFields(query, "business"), cfg);

const getBusinessAdAccounts = async (businessId, query, cfg) =>
  await getAllPages(
    `/${businessId}/owned_ad_accounts`,
    withFields(query, "adaccount"),
    cfg
  );

//
// Campaigns, ad sets, ads and creatives
//

const getCampaigns = async (accountId, query, cfg) =>
  await getAllPages(
    `/${actId(accountId)}/campaigns`,
    withFields(query, "campaign"),
    cfg
  );

const getCampaign = async (campaignId, query, cfg) =>
  await graphFetch(
    `/${campaignId}`,
    { query: withFields(query, "campaign") },
    cfg
  );

const getAdSets = async (accountId, query, cfg) =>
  await getAllPages(
    `/${actId(accountId)}/adsets`,
    withFields(query, "adset"),
    cfg
  );

const getCampaignAdSets = async (campaignId, query, cfg) =>
  await getAllPages(
    `/${campaignId}/adsets`,
    withFields(query, "adset"),
    cfg
  );

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
    cfg
  );

const getAdCreative = async (creativeId, query, cfg) =>
  await graphFetch(
    `/${creativeId}`,
    { query: withFields(query, "adcreative") },
    cfg
  );

/** Rendered HTML preview of an ad, as an iframe snippet */
const getAdPreview = async (adId, adFormat, cfg) => {
  const json = await graphFetch(
    `/${adId}/previews`,
    { query: { ad_format: adFormat || "DESKTOP_FEED_STANDARD" } },
    cfg
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

/**
 * The wording of the page post an ad promotes: the post's own text, and the
 * headline of the link it carries.
 */
const storyText = async (storyId, cfg) => {
  const json = await graphFetch(
    `/${storyId}`,
    { query: { fields: "message,attachments{title,description}" } },
    cfg
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
const getAdText = async (ad, cfg) => {
  let creative = typeof ad === "object" ? ad?.creative : null;
  if (!creative?.object_story_spec && !creative?.title && !creative?.body) {
    const fetched = await graphFetch(
      `/${typeof ad === "object" ? ad?.id : ad}`,
      { query: { fields: `creative{${CREATIVE_TEXT_FIELDS.join(",")}}` } },
      cfg
    );
    creative = fetched?.creative;
  }
  const text = {
    headline: creativeHeadlines(creative)[0] || "",
    body: creativeBodies(creative)[0] || "",
  };
  if ((!text.headline || !text.body) && creative?.effective_object_story_id)
    try {
      const story = await storyText(creative.effective_object_story_id, cfg);
      return {
        headline: text.headline || story.headline,
        body: text.body || story.body,
      };
    } catch (e) {
      if (cfg?.log_requests)
        console.log("Meta: could not read the post behind the ad", e.message);
    }
  return text;
};

/** The headline of an ad, as getAdText */
const getAdHeadline = async (ad, cfg) => (await getAdText(ad, cfg)).headline;

/** The primary text of an ad, the wording above the image, as getAdText */
const getAdBody = async (ad, cfg) => (await getAdText(ad, cfg)).body;

//
// Insights
//

const getInsights = async (objectId, query, cfg, opts) =>
  await getAllPages(
    `/${objectId}/insights`,
    withInsightsFields(query),
    cfg,
    opts
  );

/** Kick off an asynchronous insights job, returns { report_run_id } */
const startInsightsReport = async (objectId, query, cfg) =>
  await graphFetch(
    `/${objectId}/insights`,
    { method: "POST", query: withInsightsFields(query) },
    cfg
  );

const getReportRun = async (reportRunId, cfg) =>
  await graphFetch(
    `/${reportRunId}`,
    {
      query: {
        fields:
          "id,async_status,async_percent_completion,date_start,date_stop",
      },
    },
    cfg
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
        `Meta Marketing API: insights job ${run.async_status} (${report_run_id})`
      );
    if (Date.now() - startedAt > timeout)
      throw new Error(
        `Meta Marketing API: insights job timed out (${report_run_id})`
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
    cfg
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
    cfg
  );
  return json?.data || json;
};

module.exports = {
  GRAPH_HOST,
  DEFAULT_API_VERSION,
  DEFAULT_FIELDS,
  CREATIVE_TEXT_FIELDS,
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
  getInsights,
  startInsightsReport,
  getReportRun,
  getReportRunInsights,
  getInsightsAsync,
  exchangeLongLivedToken,
  debugToken,
};
