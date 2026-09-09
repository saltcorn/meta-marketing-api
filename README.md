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
| `get_meta_ad_media(ad, options)` | What an ad is made of and where to download it |
| `get_meta_ad_media_type(ad)` | Whether an ad is an `image`, a `video`, `mixed` or `unknown` |
| `get_meta_ad_media_url(ad)` | The address of the picture or the film in an ad |
| `get_meta_page_access_token(pageId)` | A token for one of your pages, or nothing when you have no access to it |
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
your page, the wording belongs to the post rather than to the ad; the module
asks Meta for a token for that page and reads it with that, which needs the
access token in the settings to have a say over the page, as described under
*Ads that boost a post on your page* below. When it cannot be read you get
empty text back rather than an error; `get_meta_ad_preview` will still show
you the ad as it appears.

### The picture or the film in an ad

`get_meta_ad_media` tells you what kind of ad you are looking at and where to
download the file it is built on:

```
get_meta_ad_media(ad_id)
```

gives you

```
{
  type: "video",
  carousel: false,
  media: [
    {
      kind: "video",
      video_id: "1234",
      url: "https://video.xx.fbcdn.net/...",
      thumbnail_url: "https://scontent.xx.fbcdn.net/...",
      permalink_url: "...",
      length: 15
    }
  ],
  creative_id: "5678",
  object_type: "VIDEO",
  thumbnail_url: "https://scontent.xx.fbcdn.net/...",
  from_post: false,
  error: undefined
}
```

- **type** is `image`, `video`, `mixed` or `unknown`. `mixed` means the ad
  offers Meta both to choose between, which is what a flexible or dynamic
  creative does, or a carousel with both in it. `unknown` means there is no
  picture or film to be found, as on a text only ad.
- **carousel** says whether the ad holds more than one card. The cards are
  the entries in `media`, in the order they are shown.
- **media** has one entry per picture or film, each with a `url` you can
  download. The still that a film shows before it plays is on that film's
  entry as `thumbnail_url`, and does not count as a picture of its own. An
  entry that could not be reached has no `url` and carries an `error` saying
  why instead.
- **thumbnail_url** is a picture of the ad as it appears. It is there even
  when nothing else is, so it is worth keeping as a fallback: for a film it
  is a still rather than the film itself, which is why it is not in `media`.
- **from_post** says the ad is boosting a post that was already on your page,
  so the media was read from the post rather than from the ad.
- **error** is there only when something could not be read, and says what.
  An ad never stops a run over an ad set because of it: you get `unknown`
  and the reason.

### Ads that boost a post on your page

Much of what is advertised on Facebook and Instagram is a post that already
exists on a page. Such an ad keeps nothing on the creative but the id of the
page and of the post:

```
{
  "object_type": "SHARE",
  "object_story_spec": { "page_id": "1067...", "instagram_user_id": "1784..." },
  "effective_object_story_id": "1067..._1334..."
}
```

The picture or the film is on the post, and Meta only shows a post to a token
that carries that page's own permissions. `get_meta_ad_media` asks for a
token for the page by itself and reads the post with it, so these ads work
like any other, as long as the access token in the settings has a say over
the page. That means:

- the token must have the **pages_read_engagement** permission, and
- the person or system user it belongs to must have a role on that page. In
  Business Manager, add the page to the same business as the ad account and
  give the system user access to it.

When that is missing you get `type: "unknown"` and an `error` saying so,
rather than silence. To check one page on its own:

```
get_meta_page_access_token("106755536029753")
```

Nothing back means the token has no say over that page. `thumbnail_url` is
still filled in for these ads, so you have a picture of the ad to look at
even when the post itself cannot be read.

A few things are worth knowing before you download:

- **Video addresses are signed and short lived.** Fetch the file as soon as
  you have the address rather than storing the address for later. Meta only
  gives the address out to a token that owns the video: with a read only
  token you may get the video's id and its thumbnail but no `url`, and the
  entry then carries an `error` saying why. `permalink_url` is a stable
  address for watching it, not for downloading it.
- **Working out the type is cheaper than finding the addresses.** Every film
  costs one extra read to look up. If all you want is image against video,
  use `get_meta_ad_media_type`, or pass the options `{ resolve_urls: false }`.
- **Pictures are often named by a hash rather than by an address.** The
  address is then held by the ad account's own picture library, which is
  looked up for you, so reading ads of a second ad account works better when
  you pass that account's id: `get_meta_ad_media(ad, { account_id: "..." })`,
  or read the ads with `account_id` among the fields. When the library does
  not hold the picture and the ad boosts a post, the post is read instead.
- **An ad whose creative shows no media is read again in full.** You may have
  asked Meta for only some of the places media can hide, so rather than
  answer `unknown` too readily it asks for all of them. Handing it an ad you
  read with the creative fields below saves that second read.

To go through a whole ad set:

```
const ads = await get_meta_adset_ads(adset_id, {
  fields:
    "id,name,account_id,creative{id,name,object_type,image_url,image_hash," +
    "video_id,thumbnail_url,object_story_spec,asset_feed_spec," +
    "effective_object_story_id}"
});
for (const ad of ads) {
  const { type, media } = await get_meta_ad_media(ad);
  console.log(ad.name, type, media.map((m) => m.url));
}
```

Asking for those creative fields is worth doing on a loop like this: given an
ad that already carries them, `get_meta_ad_media` works from what you have
instead of reading each ad again. Given only an ad id, it asks for them
itself.

Ads read as a table row, or by `get_meta_ads` without a `fields` of your own,
carry `creative_object_type`. That is a rough answer on its own: most ads
that link somewhere are reported as `SHARE` whether the media is a picture or
a film, so use `get_meta_ad_media` when it matters.

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
