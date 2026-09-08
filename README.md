# meta-marketing-api

Read your Facebook and Instagram advertising into Saltcorn, using the Meta
Marketing API.

This module is read only: it never creates, changes, pauses or deletes
anything in your Meta ad accounts. It brings your campaigns, ad sets, ads,
creatives and their performance figures into Saltcorn, where you can build
your own views, dashboards and reports on top of them.

## Before you start

You need an access token that is allowed to read your ads. The most reliable
kind is a **system user token** from Meta Business Manager, because it does
not expire:

1. In [Meta Business Manager](https://business.facebook.com/), go to
   **Business settings → Users → System users** and add a system user.
2. Give that system user access to the ad account you want to read, with the
   *View performance* (analyst) role or better.
3. Choose **Generate new token**, pick your Meta app, and tick the
   `ads_read` permission.
4. Copy the token. This is the only time it is shown.

A personal access token from the [Graph API
Explorer](https://developers.facebook.com/tools/explorer/) also works, but
those expire within hours unless they are exchanged for a long lived token
(see *Keeping the token alive* below).

## Setting up the module

Install the module, then open its configuration.

**Credentials**

| Setting | What it is for |
| --- | --- |
| Access token | The token from the steps above. Required. |
| App ID and App secret | Only needed if you want to refresh the token or check when it expires |
| Exchange for a long lived token | Swaps the token you pasted for one that lasts about 60 days. Leave this off for system user tokens, which already last forever. |
| Send app secret proof | Switch on if your Meta app is set to require proof of the app secret |
| API version | Which version of the Meta API to call. The default is current; change it only if Meta asks you to. |
| Maximum pages | A safety limit on how much data one request will read |
| Retries | How often to try again when Meta reports a temporary problem or a rate limit |
| Log requests | Writes every call to Meta into the server log, for troubleshooting |

**Ad account**

The second page lists the ad accounts your token can see. Pick the one you
work with most; it is used everywhere you do not name a different account.

## Tables

The module adds a table provider called **Meta ads**. Create a table, choose
*Meta ads* as the provider, and the table will show live data from Meta: no
copying, no synchronising, the rows are fetched when a view is opened.

First choose what the table should show:

- **Ad accounts** — the accounts your token can read
- **Campaigns**, **Ad sets**, **Ads**, **Ad creatives** — the contents of one
  ad account
- **Insights** — performance figures: impressions, clicks, spend and so on

For insights you also choose the date range (either one of Meta's ready made
ranges such as *last_30d*, or your own From and To dates), the **level**
(one row per account, campaign, ad set or ad), and optionally a **time
increment** (`1` for a row per day, or `monthly`) and **breakdowns** such as
`age,gender` or `publisher_platform`.

On the second page the module shows you the rows it just read from Meta and
suggests a column for each field, with a sensible type. Remove any columns
you do not need, correct any types, and save. Those columns are what your
views will see.

Two settings are worth knowing about:

- **Cache for (seconds)** — how long rows already read from Meta are reused.
  The default of 60 seconds keeps a busy list view from calling Meta on every
  click. Set it to 0 to always read fresh data.
- **Maximum pages** — how many requests will be made before the table stops
  asking for more. Raise it for large accounts, but expect views to be slower.

Tables of ad sets and ads are clever about relationships: when a view filters
on a campaign or ad set, only that campaign's or ad set's rows are fetched
from Meta rather than the whole account.

## Actions

**Meta sync** copies Meta objects into an ordinary Saltcorn table, rather
than reading them live. Use it when you want to keep history — Meta only
keeps performance figures for a limited time — or when you want data
available without waiting for Meta.

Choose the same things as for a table (object type, ad account, date range
for insights), then the destination table and which of its text fields holds
the Meta id. Rows are matched on that field, so running the action again
updates the rows it already created rather than duplicating them. Table
fields whose names match a Meta field are filled in automatically; anything
named differently can be mapped by hand. You can also store the whole
untouched object in a JSON field.

Tick *Delete missing rows* if the table should be an exact mirror, and
rows deleted at Meta should disappear from Saltcorn too. Point it at a
scheduled trigger — hourly or daily — to keep the copy up to date.

**Refresh Meta token** exchanges the stored access token for a fresh long
lived one and saves it. It needs the App ID and App secret to be set. If you
use an expiring token, run this from a monthly scheduled trigger so the
connection never goes stale. System user tokens do not need it.

## Functions

These can be used in code actions, calculated fields and formulas. Each one
returns exactly what Meta returned, and each takes an optional last argument
that overrides the module settings, so you can read a second ad account with
a different token.

| Function | What it returns |
| --- | --- |
| `get_meta_ad_accounts(query)` | The ad accounts your token can read |
| `get_meta_ad_account(accountId, query)` | One ad account |
| `get_meta_businesses(query)` | The businesses your token can read |
| `get_meta_business_ad_accounts(businessId, query)` | The ad accounts a business owns |
| `get_meta_campaigns(accountId, query)` | The campaigns in an ad account |
| `get_meta_campaign(campaignId, query)` | One campaign |
| `get_meta_adsets(accountId, query)` | The ad sets in an ad account |
| `get_meta_campaign_adsets(campaignId, query)` | The ad sets in a campaign |
| `get_meta_adset(adSetId, query)` | One ad set |
| `get_meta_ads(accountId, query)` | The ads in an ad account |
| `get_meta_campaign_ads(campaignId, query)` | The ads in a campaign |
| `get_meta_adset_ads(adSetId, query)` | The ads in an ad set |
| `get_meta_ad(adId, query)` | One ad |
| `get_meta_ad_creatives(accountId, query)` | The creatives in an ad account |
| `get_meta_ad_creative(creativeId, query)` | One creative |
| `get_meta_ad_headline(ad)` | The headline of an ad, from an ad id or an ad you have already read |
| `get_meta_ad_body(ad)` | The primary text of an ad: the longer wording above the image |
| `get_meta_ad_text(ad)` | Both of the above together, as `{ headline, body }`, in one read |
| `get_meta_ad_preview(adId, adFormat)` | A ready made HTML preview of an ad |
| `get_meta_insights(objectId, query)` | Performance figures for an account, campaign, ad set or ad |
| `get_meta_insights_async(objectId, query)` | The same, run as a background report, for large date ranges |
| `get_meta_me(query)` | Who the token belongs to |
| `debug_meta_token(access_token)` | What a token is allowed to do and when it expires |
| `get_meta_long_lived_token(app_id, app_secret, access_token)` | A longer lasting version of a token |
| `meta_auth_fetch(path, query)` | Anything else: reads any Meta API address directly |

Leaving `accountId` or `objectId` empty uses the default ad account from the
module settings.

The `query` argument is optional and lets you say exactly what you want. For
example, the spend of every campaign over the last week:

```
get_meta_insights("", {
  level: "campaign",
  date_preset: "last_7d",
  fields: "campaign_name,impressions,clicks,spend"
})
```

Or only the running ads, with their thumbnails:

```
get_meta_ads("", {
  effective_status: '["ACTIVE"]',
  fields: "id,name,creative{thumbnail_url}"
})
```

The wording of an ad is not in the ad itself, it sits on the creative, and
Meta keeps it in a different place for each kind of ad. `get_meta_ad_text`
finds it for you, wherever it is:

```
get_meta_ad_text(ad_id)
```

which gives you `{ headline: "...", body: "..." }`, where the body is the
longer text above the image. For an ad that is boosting a post already on
your page, the wording belongs to the post rather than to the ad, and reading
it needs a token that can also read the page. When it cannot be read you get
empty text back rather than an error; `get_meta_ad_preview` will still show
you the ad as it appears.

## Things to know

- **Money is in cents.** Budgets, bids and amounts spent come from Meta as
  whole numbers in the smallest unit of the account's currency: a daily
  budget of `5000` means 50.00. Spend in performance figures is a decimal
  number in the account's currency.
- **Meta limits how much you can read.** If you ask for a lot at once you may
  see rate limit messages; the module waits and tries again a few times by
  itself. Reading a large account is better done with the sync action on a
  schedule than with a live table.
- **Deleted campaigns are hidden by default.** Set the *Statuses* option to
  include `ARCHIVED` or `DELETED` if you need to see them.
- **Performance figures are not kept forever.** Meta only serves recent
  history. Use the sync action if you want a permanent record.
