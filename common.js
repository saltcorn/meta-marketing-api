const crypto = require("crypto");
const {
  DEFAULT_FIELDS,
  NUMERIC_INSIGHTS_FIELDS,
  insightsFields,
  actId,
  getAdAccounts,
  getCampaigns,
  getAdSets,
  getCampaignAdSets,
  getAds,
  getCampaignAds,
  getAdSetAds,
  getAdCreatives,
  getInsights,
  getInsightsAsync,
} = require("./api");

/**
 * The kinds of Meta object that can be read into a Saltcorn table, either
 * live (table provider) or copied (sync action). Each knows how to fetch
 * itself and which parent ids can be pushed down to a narrower endpoint.
 */
const objectTypes = {
  "Ad accounts": {
    kind: "adaccount",
    fields: DEFAULT_FIELDS.adaccount,
    needs_account: false,
    fetch: async ({ cfg, query, opts }) => await getAdAccounts(query, cfg),
  },
  Campaigns: {
    kind: "campaign",
    fields: DEFAULT_FIELDS.campaign,
    needs_account: true,
    fetch: async ({ cfg, account_id, query }) =>
      await getCampaigns(account_id, query, cfg),
  },
  "Ad sets": {
    kind: "adset",
    fields: DEFAULT_FIELDS.adset,
    needs_account: true,
    pushdown: ["campaign_id"],
    fetch: async ({ cfg, account_id, query, parents }) =>
      parents?.campaign_id
        ? await getCampaignAdSets(parents.campaign_id, query, cfg)
        : await getAdSets(account_id, query, cfg),
  },
  Ads: {
    kind: "ad",
    fields: DEFAULT_FIELDS.ad,
    needs_account: true,
    pushdown: ["adset_id", "campaign_id"],
    fetch: async ({ cfg, account_id, query, parents }) =>
      parents?.adset_id
        ? await getAdSetAds(parents.adset_id, query, cfg)
        : parents?.campaign_id
          ? await getCampaignAds(parents.campaign_id, query, cfg)
          : await getAds(account_id, query, cfg),
  },
  "Ad creatives": {
    kind: "adcreative",
    fields: DEFAULT_FIELDS.adcreative,
    needs_account: true,
    fetch: async ({ cfg, account_id, query }) =>
      await getAdCreatives(account_id, query, cfg),
  },
  Insights: {
    kind: "insights",
    needs_account: true,
    synthetic_id: true,
    fetch: async ({ cfg, account_id, query, config, opts }) => {
      const objectId = config?.object_id || actId(account_id);
      return config?.asynchronous
        ? await getInsightsAsync(objectId, query, cfg, opts)
        : await getInsights(objectId, query, cfg, opts);
    },
  },
};

const objectTypeNames = Object.keys(objectTypes);

const INSIGHTS_LEVELS = ["account", "campaign", "adset", "ad"];

const DATE_PRESETS = [
  "today",
  "yesterday",
  "this_week_mon_today",
  "this_week_sun_today",
  "last_week_mon_sun",
  "last_week_sun_sat",
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
  "last_3d",
  "last_7d",
  "last_14d",
  "last_28d",
  "last_30d",
  "last_90d",
  "maximum",
];

const EFFECTIVE_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "DELETED",
  "PENDING_REVIEW",
  "DISAPPROVED",
  "PREAPPROVED",
  "PENDING_BILLING_INFO",
  "CAMPAIGN_PAUSED",
  "ARCHIVED",
  "ADSET_PAUSED",
  "IN_PROCESS",
  "WITH_ISSUES",
];

const splitList = (s) =>
  typeof s === "string"
    ? s
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : Array.isArray(s)
      ? s
      : [];

const parseJSONish = (s) => {
  if (!s) return undefined;
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error(`Meta Marketing API: not valid JSON: ${s}`);
  }
};

/** Which fields the API will be asked for, given the object type and config */
const fieldsFor = (typeName, config) => {
  const chosen = splitList(config?.fields);
  if (chosen.length) return chosen;
  if (typeName === "Insights") return insightsFields(config?.level);
  return objectTypes[typeName]?.fields || ["id", "name"];
};

/** Turn the plugin/table/action configuration into Graph API query parameters */
const buildQuery = (typeName, config = {}) => {
  const query = { fields: fieldsFor(typeName, config) };
  if (config.limit) query.limit = config.limit;

  if (typeName === "Insights") {
    if (config.level) query.level = config.level;
    if (config.since && config.until)
      query.time_range = { since: config.since, until: config.until };
    else if (config.date_preset) query.date_preset = config.date_preset;
    if (config.time_increment) query.time_increment = config.time_increment;
    const breakdowns = splitList(config.breakdowns);
    if (breakdowns.length) query.breakdowns = breakdowns;
    const actionBreakdowns = splitList(config.action_breakdowns);
    if (actionBreakdowns.length) query.action_breakdowns = actionBreakdowns;
    if (config.use_account_attribution_setting)
      query.use_account_attribution_setting = true;
  } else {
    const statuses = splitList(config.effective_status);
    // Meta expects this one as a JSON array, not a comma separated list
    if (statuses.length) query.effective_status = JSON.stringify(statuses);
  }
  if (config.filtering) query.filtering = parseJSONish(config.filtering);
  if (config.extra_params)
    Object.assign(query, parseJSONish(config.extra_params) || {});
  return query;
};

/**
 * Read rows of one Meta object type. `where` is used only to pick a narrower
 * endpoint (the ads of one campaign rather than of the whole account).
 */
const pushdownParents = (typeName, where) => {
  const parents = {};
  (objectTypes[typeName]?.pushdown || []).forEach((k) => {
    const v = where?.[k];
    if (typeof v === "string" || typeof v === "number") parents[k] = v;
  });
  return parents;
};

const fetchObjects = async ({ cfg, config = {}, where, opts }) => {
  const typeName = config.object_type || "Campaigns";
  const objectType = objectTypes[typeName];
  if (!objectType)
    throw new Error(`Meta Marketing API: unknown object type ${typeName}`);
  const account_id = config.ad_account_id || cfg?.ad_account_id;
  if (objectType.needs_account && !account_id && !config.object_id)
    throw new Error(
      "Meta Marketing API: no ad account set, in the table or in the plugin configuration"
    );
  const parents = pushdownParents(typeName, where);
  // a page limit set on the table or action overrides the plugin-wide one
  const useCfg = config.max_pages
    ? { ...cfg, max_pages: config.max_pages }
    : cfg;
  const rows = await objectType.fetch({
    cfg: useCfg,
    account_id,
    query: buildQuery(typeName, config),
    config,
    parents,
    opts: { max_pages: config.max_pages, ...(opts || {}) },
  });
  return (rows || []).map((row) => prepareRow(row, typeName, config));
};

/**
 * Graph API rows nest sub-objects (creative, targeting). Flatten the shallow
 * ones into creative_id, creative_name and so on; leave arrays and deeper
 * objects as JSON.
 */
const flattenRow = (row, prefix = "", out = {}, depth = 0) => {
  Object.entries(row || {}).forEach(([k, v]) => {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && depth < 2)
      flattenRow(v, key, out, depth + 1);
    else out[key] = v;
  });
  return out;
};

// Insights rows have no id of their own, so one is made from the dimensions
const INSIGHTS_ID_FIELDS = [
  "date_start",
  "date_stop",
  "account_id",
  "campaign_id",
  "adset_id",
  "ad_id",
];

const insightsRowId = (row, breakdowns = []) => {
  const key = [...INSIGHTS_ID_FIELDS, ...breakdowns]
    .map((f) => (typeof row[f] === "undefined" ? "" : row[f]))
    .join("|");
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 20);
};

const prepareRow = (row, typeName, config = {}) => {
  const flat = flattenRow(row);
  if (objectTypes[typeName]?.synthetic_id && !flat.id)
    flat.id = insightsRowId(flat, splitList(config.breakdowns));
  return flat;
};

const INTEGER_FIELDS = new Set([
  "impressions",
  "reach",
  "clicks",
  "unique_clicks",
  "inline_link_clicks",
  "account_status",
  "timezone_id",
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

// Budgets and spend come back as strings in the account's minor currency unit
const MONEY_FIELD_RE =
  /(^|_)(daily_budget|lifetime_budget|budget_remaining|bid_amount|amount_spent|balance|spend_cap|min_daily_budget)$/;

const guessType = (name, value) => {
  if (INTEGER_FIELDS.has(name) || MONEY_FIELD_RE.test(name)) return "Integer";
  if (NUMERIC_INSIGHTS_FIELDS.has(name)) return "Float";
  if (value === null || typeof value === "undefined") return "String";
  if (Array.isArray(value) || typeof value === "object") return "JSON";
  if (typeof value === "boolean") return "Bool";
  if (typeof value === "number")
    return Number.isInteger(value) ? "Integer" : "Float";
  if (ISO_DATE_RE.test(value)) return "Date";
  return "String";
};

const coerceValue = (value, type) => {
  if (value === null || typeof value === "undefined") return null;
  switch (type) {
    case "Integer": {
      const n = parseInt(value, 10);
      return Number.isNaN(n) ? null : n;
    }
    case "Float": {
      const n = parseFloat(value);
      return Number.isNaN(n) ? null : n;
    }
    case "Bool":
      return typeof value === "boolean"
        ? value
        : ["true", "1", "yes"].includes(`${value}`.toLowerCase());
    case "Date": {
      const d = value instanceof Date ? value : new Date(value);
      return isNaN(d.getTime()) ? null : d;
    }
    case "JSON":
      return value;
    case "String":
      return typeof value === "object" ? JSON.stringify(value) : `${value}`;
    default:
      return value;
  }
};

/** Apply the configured column types to a fetched row */
const coerceRow = (row, columns) => {
  const out = {};
  (columns || []).forEach((col) => {
    out[col.name] = coerceValue(row[col.name], col.type);
  });
  return out;
};

//
// In memory query support. The Graph API cannot filter or sort the way
// Saltcorn views expect, so the where clause is applied to the fetched rows.
//

const SPECIAL_WHERE_KEYS = new Set([
  "limit",
  "offset",
  "orderBy",
  "orderDesc",
  "forUser",
  "forPublic",
]);

const asComparable = (v) =>
  v instanceof Date ? v.getTime() : typeof v === "string" ? v : v;

const valueMatches = (value, cond) => {
  if (cond === null) return value === null || typeof value === "undefined";
  if (Array.isArray(cond)) return cond.every((c) => valueMatches(value, c));
  if (cond instanceof Date)
    return (
      value instanceof Date && value.getTime() === cond.getTime()
    );
  if (cond && typeof cond === "object") {
    if ("in" in cond)
      return (cond.in || []).map((x) => `${x}`).includes(`${value}`);
    if ("ilike" in cond)
      return `${value === null || typeof value === "undefined" ? "" : value}`
        .toLowerCase()
        .includes(`${cond.ilike}`.toLowerCase());
    if ("gt" in cond) {
      const a = asComparable(value);
      const b = asComparable(cond.gt);
      return cond.equal ? a >= b : a > b;
    }
    if ("lt" in cond) {
      const a = asComparable(value);
      const b = asComparable(cond.lt);
      return cond.equal ? a <= b : a < b;
    }
    if ("not" in cond) return !valueMatches(value, cond.not);
    // an operator we do not implement: do not silently hide rows
    return true;
  }
  if (value instanceof Date) return value.getTime() === new Date(cond).getTime();
  return `${value}` === `${cond}`;
};

const ftsMatches = (row, fts) => {
  const term = `${fts?.searchTerm || ""}`.toLowerCase();
  if (!term) return true;
  const fields = (fts.fields || []).map((f) => (f.name ? f.name : f));
  const inFields = fields.length ? fields : Object.keys(row);
  return inFields.some((f) => {
    const v = row[f];
    if (v === null || typeof v === "undefined") return false;
    const s = typeof v === "object" ? JSON.stringify(v) : `${v}`;
    return s.toLowerCase().includes(term);
  });
};

const rowMatches = (row, where) => {
  for (const [k, cond] of Object.entries(where || {})) {
    if (SPECIAL_WHERE_KEYS.has(k)) continue;
    if (k === "_fts") {
      if (!ftsMatches(row, cond)) return false;
      continue;
    }
    if (k === "or") {
      if (!(cond || []).some((w) => rowMatches(row, w))) return false;
      continue;
    }
    if (k === "not") {
      if (rowMatches(row, cond)) return false;
      continue;
    }
    if (!valueMatches(row[k], cond)) return false;
  }
  return true;
};

const compareValues = (a, b) => {
  const x = asComparable(a);
  const y = asComparable(b);
  if (x === y) return 0;
  if (x === null || typeof x === "undefined") return -1;
  if (y === null || typeof y === "undefined") return 1;
  return x < y ? -1 : 1;
};

/** filter, sort and paginate fetched rows the way the view asked for */
const applyWhere = (rows, where = {}, opts = {}) => {
  let result = rows.filter((r) => rowMatches(r, where));
  const orderBy = where.orderBy || opts.orderBy;
  const orderDesc = where.orderDesc || opts.orderDesc;
  if (orderBy && typeof orderBy === "string") {
    result = [...result].sort((a, b) => compareValues(a[orderBy], b[orderBy]));
    if (orderDesc) result.reverse();
  }
  const offset = where.offset || opts.offset;
  const limit = where.limit || opts.limit;
  if (offset) result = result.slice(offset);
  if (limit) result = result.slice(0, limit);
  return result;
};

module.exports = {
  objectTypes,
  objectTypeNames,
  INSIGHTS_LEVELS,
  DATE_PRESETS,
  EFFECTIVE_STATUSES,
  INSIGHTS_ID_FIELDS,
  splitList,
  parseJSONish,
  fieldsFor,
  buildQuery,
  pushdownParents,
  fetchObjects,
  flattenRow,
  insightsRowId,
  prepareRow,
  guessType,
  coerceValue,
  coerceRow,
  valueMatches,
  rowMatches,
  applyWhere,
};
