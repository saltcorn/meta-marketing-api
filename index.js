const db = require("@saltcorn/data/db");
const Form = require("@saltcorn/data/models/form");
const Workflow = require("@saltcorn/data/models/workflow");
const Plugin = require("@saltcorn/data/models/plugin");
const { getState } = require("@saltcorn/data/db/state");
const { div, p } = require("@saltcorn/markup/tags");
const {
  DEFAULT_API_VERSION,
  graphFetch,
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
  getInsights,
  getInsightsAsync,
  exchangeLongLivedToken,
  debugToken,
} = require("./api");

const PLUGIN_NAME = "meta-marketing-api";

const configuration_workflow = () =>
  new Workflow({
    onDone: async (ctx) => {
      // A user token that expires can be swapped for one that lasts ~60 days
      if (ctx.exchange_token && ctx.app_id && ctx.app_secret) {
        const res = await exchangeLongLivedToken(
          ctx.app_id,
          ctx.app_secret,
          ctx.access_token,
          ctx
        );
        if (res?.access_token)
          return {
            ...ctx,
            access_token: res.access_token,
            token_expires: res.expires_in
              ? new Date(Date.now() + res.expires_in * 1000).toISOString()
              : undefined,
          };
      }
      return ctx;
    },
    steps: [
      {
        name: "Credentials",
        form: async () =>
          new Form({
            blurb: p(
              "Read the ads in your Meta ad accounts. You need an access token with the ",
              "ads_read",
              " permission, from a Meta app that has access to the ad account. A system user token from Meta Business Manager does not expire and is the easiest to use."
            ),
            fields: [
              {
                name: "access_token",
                label: "Access token",
                sublabel: "System user token, or a long lived user token",
                type: "String",
                fieldview: "textarea",
                required: true,
              },
              {
                name: "app_id",
                label: "App ID",
                sublabel:
                  "Optional. Needed to refresh the token or to check when it expires.",
                type: "String",
              },
              {
                name: "app_secret",
                label: "App secret",
                sublabel: "Optional, as above",
                type: "String",
              },
              {
                name: "exchange_token",
                label: "Exchange for a long lived token",
                sublabel:
                  "When saving, swap the token above for one that lasts about 60 days. Leave off for system user tokens.",
                type: "Bool",
              },
              {
                name: "use_appsecret_proof",
                label: "Send app secret proof",
                sublabel:
                  "Switch on if your Meta app requires proof of the app secret on API calls",
                type: "Bool",
              },
              {
                name: "api_version",
                label: "API version",
                sublabel: `Graph API version to call. Default ${DEFAULT_API_VERSION}.`,
                type: "String",
                default: DEFAULT_API_VERSION,
              },
              {
                name: "max_pages",
                label: "Maximum pages",
                sublabel:
                  "How many pages of results to read before stopping, when not set elsewhere",
                type: "Integer",
                default: 10,
              },
              {
                name: "max_retries",
                label: "Retries",
                sublabel:
                  "How often to try again when Meta reports a temporary error or rate limit",
                type: "Integer",
                default: 3,
              },
              {
                name: "log_requests",
                label: "Log requests",
                sublabel: "Write every call to Meta to the server log",
                type: "Bool",
              },
            ],
          }),
      },
      {
        name: "Ad account",
        form: async (context) => {
          let options = [];
          let error;
          try {
            const accounts = await getAdAccounts({ limit: 200 }, context);
            options = accounts.map((acc) => ({
              label: `${acc.name || acc.id} (${acc.id})`,
              name: acc.id,
            }));
          } catch (e) {
            error = e.message;
          }
          return new Form({
            blurb: error
              ? div(
                  { class: "alert alert-warning" },
                  "Could not read your ad accounts: ",
                  error,
                  p(
                    "You can still type an ad account id below, or go back and correct the token."
                  )
                )
              : undefined,
            fields: [
              {
                name: "ad_account_id",
                label: "Default ad account",
                sublabel:
                  "Used whenever a table or action does not name an ad account of its own",
                type: "String",
                attributes: options.length ? { options } : {},
              },
            ],
          });
        },
      },
    ],
  });

/** Every function takes an optional final argument overriding the plugin configuration */
module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: PLUGIN_NAME,
  configuration_workflow,
  table_providers: (cfg) => require("./table-provider.js")(cfg),
  functions: (cfg) => ({
    meta_auth_fetch: {
      async run(path, query, cfgOverRide) {
        return await graphFetch(path, { query }, { ...cfg, ...cfgOverRide });
      },
      isAsync: true,
      description:
        "Authenticated read from any Meta Graph API endpoint, for example /me/adaccounts",
      arguments: [
        { name: "path", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_me: {
      async run(query, cfgOverRide) {
        return await getMe(query, { ...cfg, ...cfgOverRide });
      },
      isAsync: true,
      description: "Get the user or system user the token belongs to",
      arguments: [],
    },
    get_meta_ad_accounts: {
      async run(query, cfgOverRide) {
        return await getAdAccounts(query, { ...cfg, ...cfgOverRide });
      },
      isAsync: true,
      description: "Get the Meta ad accounts this token can read",
      arguments: [{ name: "query", type: "JSON" }],
    },
    get_meta_ad_account: {
      async run(accountId, query, cfgOverRide) {
        return await getAdAccount(accountId, query, {
          ...cfg,
          ...cfgOverRide,
        });
      },
      isAsync: true,
      description: "Get one Meta ad account",
      arguments: [
        { name: "accountId", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_businesses: {
      async run(query, cfgOverRide) {
        return await getBusinesses(query, { ...cfg, ...cfgOverRide });
      },
      isAsync: true,
      description: "Get the Meta businesses this token can read",
      arguments: [{ name: "query", type: "JSON" }],
    },
    get_meta_business_ad_accounts: {
      async run(businessId, query, cfgOverRide) {
        return await getBusinessAdAccounts(businessId, query, {
          ...cfg,
          ...cfgOverRide,
        });
      },
      isAsync: true,
      description: "Get the ad accounts owned by a Meta business",
      arguments: [
        { name: "businessId", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_campaigns: {
      async run(accountId, query, cfgOverRide) {
        return await getCampaigns(accountId || cfg?.ad_account_id, query, {
          ...cfg,
          ...cfgOverRide,
        });
      },
      isAsync: true,
      description: "Get the campaigns in a Meta ad account",
      arguments: [
        { name: "accountId", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_campaign: {
      async run(campaignId, query, cfgOverRide) {
        return await getCampaign(campaignId, query, {
          ...cfg,
          ...cfgOverRide,
        });
      },
      isAsync: true,
      description: "Get one Meta campaign",
      arguments: [
        { name: "campaignId", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_adsets: {
      async run(accountId, query, cfgOverRide) {
        return await getAdSets(accountId || cfg?.ad_account_id, query, {
          ...cfg,
          ...cfgOverRide,
        });
      },
      isAsync: true,
      description: "Get the ad sets in a Meta ad account",
      arguments: [
        { name: "accountId", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_campaign_adsets: {
      async run(campaignId, query, cfgOverRide) {
        return await getCampaignAdSets(campaignId, query, {
          ...cfg,
          ...cfgOverRide,
        });
      },
      isAsync: true,
      description: "Get the ad sets in a Meta campaign",
      arguments: [
        { name: "campaignId", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_adset: {
      async run(adSetId, query, cfgOverRide) {
        return await getAdSet(adSetId, query, { ...cfg, ...cfgOverRide });
      },
      isAsync: true,
      description: "Get one Meta ad set",
      arguments: [
        { name: "adSetId", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_ads: {
      async run(accountId, query, cfgOverRide) {
        return await getAds(accountId || cfg?.ad_account_id, query, {
          ...cfg,
          ...cfgOverRide,
        });
      },
      isAsync: true,
      description: "Get the ads in a Meta ad account",
      arguments: [
        { name: "accountId", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_campaign_ads: {
      async run(campaignId, query, cfgOverRide) {
        return await getCampaignAds(campaignId, query, {
          ...cfg,
          ...cfgOverRide,
        });
      },
      isAsync: true,
      description: "Get the ads in a Meta campaign",
      arguments: [
        { name: "campaignId", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_adset_ads: {
      async run(adSetId, query, cfgOverRide) {
        return await getAdSetAds(adSetId, query, { ...cfg, ...cfgOverRide });
      },
      isAsync: true,
      description: "Get the ads in a Meta ad set",
      arguments: [
        { name: "adSetId", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_ad: {
      async run(adId, query, cfgOverRide) {
        return await getAd(adId, query, { ...cfg, ...cfgOverRide });
      },
      isAsync: true,
      description: "Get one Meta ad",
      arguments: [
        { name: "adId", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_ad_creatives: {
      async run(accountId, query, cfgOverRide) {
        return await getAdCreatives(accountId || cfg?.ad_account_id, query, {
          ...cfg,
          ...cfgOverRide,
        });
      },
      isAsync: true,
      description: "Get the ad creatives in a Meta ad account",
      arguments: [
        { name: "accountId", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_ad_creative: {
      async run(creativeId, query, cfgOverRide) {
        return await getAdCreative(creativeId, query, {
          ...cfg,
          ...cfgOverRide,
        });
      },
      isAsync: true,
      description: "Get one Meta ad creative",
      arguments: [
        { name: "creativeId", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_ad_preview: {
      async run(adId, adFormat, cfgOverRide) {
        return await getAdPreview(adId, adFormat, {
          ...cfg,
          ...cfgOverRide,
        });
      },
      isAsync: true,
      description:
        "Get the HTML preview of an ad, for example in format MOBILE_FEED_STANDARD",
      arguments: [
        { name: "adId", type: "String" },
        { name: "adFormat", type: "String" },
      ],
    },
    get_meta_insights: {
      async run(objectId, query, cfgOverRide) {
        /* Query example:
        {
          level: "campaign",
          date_preset: "last_30d",
          time_increment: 1,
          breakdowns: "age,gender",
          fields: "campaign_name,impressions,clicks,spend",
        };
        */
        return await getInsights(objectId || cfg?.ad_account_id, query, {
          ...cfg,
          ...cfgOverRide,
        });
      },
      isAsync: true,
      description:
        "Get performance figures for an ad account, campaign, ad set or ad",
      arguments: [
        { name: "objectId", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_insights_async: {
      async run(objectId, query, cfgOverRide) {
        return await getInsightsAsync(
          objectId || cfg?.ad_account_id,
          query,
          { ...cfg, ...cfgOverRide },
          {}
        );
      },
      isAsync: true,
      description:
        "Get performance figures as a background report. Slower to start, for large date ranges.",
      arguments: [
        { name: "objectId", type: "String" },
        { name: "query", type: "JSON" },
      ],
    },
    get_meta_long_lived_token: {
      async run(app_id, app_secret, access_token, cfgOverRide) {
        return await exchangeLongLivedToken(
          app_id || cfg?.app_id,
          app_secret || cfg?.app_secret,
          access_token || cfg?.access_token,
          { ...cfg, ...cfgOverRide }
        );
      },
      isAsync: true,
      description: "Exchange an access token for a long lived one",
      arguments: [
        { name: "app_id", type: "String" },
        { name: "app_secret", type: "String" },
        { name: "access_token", type: "String" },
      ],
    },
    debug_meta_token: {
      async run(access_token, cfgOverRide) {
        const useCfg = { ...cfg, ...cfgOverRide };
        return await debugToken(
          access_token || useCfg.access_token,
          useCfg.app_id,
          useCfg.app_secret,
          useCfg
        );
      },
      isAsync: true,
      description:
        "Check an access token: which app it belongs to, its permissions and when it expires",
      arguments: [{ name: "access_token", type: "String" }],
    },
  }),
  actions: (cfg) => ({
    refresh_meta_token: {
      description:
        "Exchange the stored Meta access token for a fresh long lived one and save it",
      run: async () => {
        if (!cfg?.app_id || !cfg?.app_secret)
          throw new Error(
            "Set the App ID and App secret in the Meta Marketing API settings to refresh the token"
          );
        const { access_token, expires_in } = await exchangeLongLivedToken(
          cfg.app_id,
          cfg.app_secret,
          cfg.access_token,
          cfg
        );
        if (!access_token)
          throw new Error("Meta did not return a new access token");
        let plugin = await Plugin.findOne({ name: PLUGIN_NAME });
        if (!plugin)
          plugin = await Plugin.findOne({
            name: `@saltcorn/${PLUGIN_NAME}`,
          });
        if (!plugin) throw new Error("Meta Marketing API plugin not found");
        plugin.configuration = {
          ...(plugin.configuration || {}),
          access_token,
          token_expires: expires_in
            ? new Date(Date.now() + expires_in * 1000).toISOString()
            : undefined,
        };
        await plugin.upsert();
        getState().processSend({
          refresh_plugin_cfg: plugin.name,
          tenant: db.getTenantSchema(),
        });
        console.log("updated Meta access token");
        return { success: "Meta access token refreshed" };
      },
    },
    meta_sync: require("./sync-action.js")(cfg),
  }),
};
