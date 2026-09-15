jest.mock("node-fetch");
const fetch = require("node-fetch");
const { getAdMedia, getAdMediaType, getAdText } = require("../api");

const cfg = { access_token: "USERTOKEN", max_retries: 0 };

// Answer each call from a list of [what the address must contain, the reply],
// and keep what was asked so a test can check which token was used
let calls;
const serve = (routes) => {
  calls = [];
  fetch.mockImplementation(async (url, opts) => {
    calls.push({ url, auth: opts?.headers?.Authorization });
    const auth = opts?.headers?.Authorization;
    const hit = routes.find(([match]) =>
      typeof match === "function" ? match(url, auth) : url.includes(match),
    );
    const reply = hit ? hit[1] : { error: { code: 100, message: `no route for ${url}` } };
    return {
      status: 200,
      headers: { get: () => null },
      // a page, such as a preview, comes back as it is
      text: async () => (typeof reply === "string" ? reply : JSON.stringify(reply)),
    };
  });
};

// An ad that boosts a post already on the page: the creative names the page
// and the post, and carries no media of its own
const boostedAd = {
  id: "120242825926110547",
  name: "Version AI Remake",
  creative: {
    id: "782942930901202",
    object_type: "SHARE",
    object_story_spec: { page_id: "106755536029753", instagram_user_id: "17841401937168196" },
    effective_object_story_id: "106755536029753_1333493868811467",
  },
};

const videoPost = {
  permalink_url: "https://facebook.com/post",
  full_picture: "https://example.com/full.jpg",
  attachments: {
    data: [
      {
        media_type: "video",
        media: { image: { src: "https://example.com/still.jpg" } },
        target: { id: "999" },
      },
    ],
  },
};

describe("an ad that boosts a page post", () => {
  it("reads the post with a token for the page", async () => {
    serve([
      ["/120242825926110547", { account_id: "1", creative: { ...boostedAd.creative, thumbnail_url: "https://example.com/thumb.jpg" } }],
      ["/106755536029753?", { access_token: "PAGETOKEN" }],
      ["/106755536029753_1333493868811467", videoPost],
      ["/999", { id: "999", source: "https://video.fb/film.mp4", picture: "https://example.com/still.jpg", length: 15 }],
    ]);
    const res = await getAdMedia(boostedAd, cfg);
    expect(res.type).toBe("video");
    expect(res.from_post).toBe(true);
    expect(res.story_id).toBe("106755536029753_1333493868811467");
    expect(res.media).toHaveLength(1);
    expect(res.media[0].url).toBe("https://video.fb/film.mp4");
    expect(res.media[0].thumbnail_url).toBe("https://example.com/still.jpg");
    expect(res.error).toBeUndefined();
    // the post is read as the page, not as the user
    const post = calls.find((c) => c.url.includes("106755536029753_1333"));
    expect(post.auth).toBe("Bearer PAGETOKEN");
  });

  it("says why when the token has no say over the page", async () => {
    const ad = {
      ...boostedAd,
      creative: {
        ...boostedAd.creative,
        object_story_spec: { page_id: "222" },
        effective_object_story_id: "222_333",
      },
    };
    serve([
      ["/120242825926110547", { account_id: "1", creative: { ...ad.creative, thumbnail_url: "https://example.com/thumb.jpg" } }],
      ["/222?", { error: { code: 190, message: "no page access" } }],
      ["/222_333", { error: { code: 100, message: "Unsupported get request" } }],
    ]);
    const res = await getAdMedia(ad, cfg);
    expect(res.type).toBe("unknown");
    expect(res.media).toEqual([]);
    // not silence: the reason, and something to look at
    expect(res.error).toMatch(/could not read the post 222_333/);
    expect(res.error).toMatch(/pages_read_engagement/);
    expect(res.thumbnail_url).toBe("https://example.com/thumb.jpg");
  });
});

describe("reading the ad again", () => {
  it("asks for every media field when handed a creative with none", async () => {
    serve([
      ["/120242825926110547", { account_id: "1", creative: { id: "782942930901202", video_id: "555", thumbnail_url: "https://example.com/t.jpg" } }],
      ["/555", { id: "555", source: "https://video.fb/film.mp4" }],
    ]);
    // the caller asked Meta for a narrow set of fields, so image_hash,
    // video_id and asset_feed_spec were never in the ad we were given
    const res = await getAdMedia(boostedAd, cfg);
    expect(res.type).toBe("video");
    expect(res.media[0].url).toBe("https://video.fb/film.mp4");
    const asked = calls[0].url;
    expect(asked).toContain("video_id");
    expect(asked).toContain("asset_feed_spec");
    expect(asked).toContain("image_hash");
  });

  it("does not read the ad again when the creative already has media", async () => {
    serve([["/act_", { data: [] }]]);
    const ad = {
      id: "1",
      account_id: "9",
      creative: {
        id: "2",
        object_story_spec: {
          link_data: { image_hash: "h", picture: "https://example.com/p.jpg" },
        },
      },
    };
    const res = await getAdMedia(ad, cfg, { resolve_urls: false });
    expect(res.type).toBe("image");
    expect(calls).toHaveLength(0);
  });

  it("works out the type without looking up every address", async () => {
    serve([
      ["/1?", { account_id: "9", creative: { id: "2", video_id: "555" } }],
    ]);
    expect(await getAdMediaType({ id: "1" }, cfg)).toBe("video");
    // one read for the ad, and no read of the video
    expect(calls).toHaveLength(1);
  });
});

describe("what counts as a carousel", () => {
  it("a post with several pictures in it does", async () => {
    serve([
      ["/1?", { account_id: "9", creative: { id: "2", object_story_spec: { page_id: "444" }, effective_object_story_id: "444_555" } }],
      ["/444?", { access_token: "PAGETOKEN" }],
      ["/444_555", {
        attachments: {
          data: [
            {
              media_type: "album",
              subattachments: {
                data: [
                  { media_type: "photo", media: { image: { src: "https://example.com/1.jpg" } } },
                  { media_type: "photo", media: { image: { src: "https://example.com/2.jpg" } } },
                ],
              },
            },
          ],
        },
      }],
    ]);
    const res = await getAdMedia({ id: "1" }, cfg);
    expect(res.type).toBe("image");
    expect(res.carousel).toBe(true);
    expect(res.media).toHaveLength(2);
  });

  it("a dynamic creative offering Meta a choice does not", async () => {
    serve([["/act_", { data: [] }]]);
    const ad = {
      id: "1",
      account_id: "9",
      creative: {
        id: "2",
        asset_feed_spec: {
          images: [
            { hash: "h1", url: "https://example.com/1.jpg" },
            { hash: "h2", url: "https://example.com/2.jpg" },
          ],
          videos: [{ video_id: "v1" }],
        },
      },
    };
    const res = await getAdMedia(ad, cfg, { resolve_urls: false });
    expect(res.carousel).toBe(false);
    expect(res.type).toBe("mixed");
    expect(res.media).toHaveLength(3);
  });
});

// A creative that shows a different asset per placement, with a film left
// over as the catch-all for placements the other rules do not take
const label = (id) => [{ id, name: `placement_asset_${id}` }];
const placementAd = {
  id: "1",
  account_id: "9",
  creative: {
    id: "2",
    object_type: "SHARE",
    thumbnail_url: "https://example.com/v/feed_n.jpg?stp=p64x64",
    asset_feed_spec: {
      optimization_type: "PLACEMENT",
      images: [
        { hash: "feed", adlabels: label("L-feed") },
        { hash: "story", adlabels: label("L-story") },
        { hash: "column", adlabels: label("L-column") },
      ],
      videos: [{ video_id: "777", adlabels: label("L-video") }],
      asset_customization_rules: [
        {
          customization_spec: {
            publisher_platforms: ["facebook", "instagram"],
            facebook_positions: ["story", "facebook_reels"],
            instagram_positions: ["story", "reels"],
          },
          image_label: label("L-story")[0],
          priority: 1,
        },
        {
          customization_spec: {
            publisher_platforms: ["facebook", "instagram"],
            facebook_positions: ["feed", "marketplace"],
            instagram_positions: ["stream"],
          },
          image_label: label("L-feed")[0],
          priority: 2,
        },
        {
          customization_spec: {
            publisher_platforms: ["facebook"],
            facebook_positions: ["right_hand_column", "search"],
          },
          image_label: label("L-column")[0],
          priority: 3,
        },
        {
          customization_spec: { age_min: 18, age_max: 65 },
          video_label: label("L-video")[0],
          priority: 4,
        },
      ],
    },
  },
};

describe("a creative customised by placement", () => {
  it("puts what the feed shows first and the catch-all last", async () => {
    serve([]);
    const res = await getAdMedia(placementAd, cfg, { resolve_urls: false });
    expect(res.media.map((m) => m.image_hash || m.video_id)).toEqual([
      "feed",
      "story",
      "column",
      "777",
    ]);
    expect(res.media[0].placements).toContain("facebook:feed");
    expect(res.media[0].fallback).toBe(false);
    expect(res.media[0].feed).toBe(true);
    expect(res.media[3].fallback).toBe(true);
    expect(res.media[3].feed).toBe(false);
  });

  it("is the kind of what it shows, not of its catch-all", async () => {
    serve([]);
    const res = await getAdMedia(placementAd, cfg, { resolve_urls: false });
    expect(res.type).toBe("image");
    expect(res.carousel).toBe(false);
  });

  it("does not report a catch-all that cannot be reached", async () => {
    serve([
      ["/777", { error: { code: 10, message: "(#10) Application does not have permission for this action" } }],
      [
        "/act_9/adimages",
        {
          data: ["feed", "story", "column"].map((h) => ({
            hash: h,
            url: `https://example.com/v/${h}_n.jpg`,
          })),
        },
      ],
    ]);
    const res = await getAdMedia(placementAd, cfg);
    expect(res.media[0].url).toBe("https://example.com/v/feed_n.jpg");
    expect(res.media[3].error).toMatch(/permission/);
    expect(res.error).toBeUndefined();
  });

  it("without a feed rule, puts the catch-all first, then the picture the ad is known by", async () => {
    serve([]);
    const creative = JSON.parse(JSON.stringify(placementAd.creative));
    const feed = creative.asset_feed_spec;
    feed.images.forEach((i) => (i.url = `https://example.com/v/${i.hash}_n.jpg`));
    feed.asset_customization_rules = feed.asset_customization_rules.filter(
      (r) => r.priority !== 2,
    );
    creative.thumbnail_url = "https://example.com/other/column_n.jpg?stp=p64x64";
    const res = await getAdMedia({ ...placementAd, creative }, cfg, {
      resolve_urls: false,
    });
    // the catch-all is what the feed shows now that no rule names the feed
    expect(res.media.map((m) => m.image_hash || m.video_id)).toEqual([
      "777",
      "column",
      "story",
      "feed",
    ]);
    expect(res.media[0].feed).toBe(true);
  });
});

// Two films uploaded to the page: one for stories and reels, and a catch-all
// which, with no rule naming the feed, is what the feed shows
const pageVideoAd = (pageId) => ({
  id: "50",
  account_id: "9",
  creative: {
    id: "51",
    object_type: "SHARE",
    object_story_spec: { page_id: pageId },
    asset_feed_spec: {
      optimization_type: "PLACEMENT",
      videos: [
        { video_id: "801", thumbnail_url: "https://example.com/t/story_n.jpg?stp=s160", adlabels: label("L-story") },
        { video_id: "802", thumbnail_url: "https://example.com/t/feed_n.jpg?stp=s160", adlabels: label("L-rest") },
      ],
      asset_customization_rules: [
        {
          customization_spec: {
            publisher_platforms: ["facebook", "instagram"],
            facebook_positions: ["story"],
            instagram_positions: ["story", "reels"],
          },
          video_label: label("L-story")[0],
          priority: 1,
        },
        { customization_spec: { age_min: 18 }, video_label: label("L-rest")[0], priority: 2 },
      ],
    },
  },
});

const noPermission = { error: { code: 10, message: "(#10) Application does not have permission for this action" } };

// A preview as Meta draws it: the film's still, and its files with escaped
// addresses whose efg says what each file is
const mp4 = (name, asset, tag) => {
  const efg = Buffer.from(JSON.stringify({ vencode_tag: tag, xpv_asset_id: asset, duration_s: 52 })).toString("base64url");
  return `https:\\/\\/video.fbcdn.net\\/v\\/${name}.mp4?efg=${efg}\\u0026oh=sig\\u0026oe=6AA`;
};
const previewHtml = (still, files) =>
  `<html><img src="https://example.com/t/${still}_n.jpg"><script>{"videos":[${files.map((f) => `"${f}"`).join(",")}]}</script></html>`;
const previewRoute = (format, name) => [
  `ad_format=${format}`,
  { data: [{ body: `<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=${name}&amp;t=1"></iframe>` }] },
];
const SD = "xpv_progressive.FACEBOOK..C3.360.sve_sd";
const HD = "xpv_progressive.FACEBOOK..C3.720.dash_h264-basic-gen2_720p";

describe("films uploaded to the page", () => {
  it("puts the catch-all first when it is what the feed shows", async () => {
    serve([]);
    const res = await getAdMedia(pageVideoAd("4000"), cfg, { resolve_urls: false });
    expect(res.media.map((m) => m.video_id)).toEqual(["802", "801"]);
    expect(res.media[0]).toMatchObject({ fallback: true, feed: true });
    expect(res.media[1]).toMatchObject({ fallback: false, feed: false });
    expect(res.type).toBe("video");
  });

  it("reads them with a token for the page", async () => {
    const asPage = (match) => (url, auth) => url.includes(match) && auth === "Bearer PAGE4242";
    serve([
      ["/4242?", { access_token: "PAGE4242" }],
      [asPage("/801?"), { id: "801", source: "https://video.fb/story.mp4" }],
      [asPage("/802?"), { id: "802", source: "https://video.fb/feed.mp4" }],
      ["/80", noPermission],
    ]);
    const res = await getAdMedia(pageVideoAd("4242"), cfg);
    expect(res.media.map((m) => m.url)).toEqual(["https://video.fb/feed.mp4", "https://video.fb/story.mp4"]);
    expect(res.error).toBeUndefined();
    expect(calls.some((c) => c.url.includes("/previews"))).toBe(false);
  });

  it("finds them in the preview when no token will give them out", async () => {
    serve([
      ["/4343?", { error: { code: 190, message: "no page access" } }],
      ["/80", noPermission],
      previewRoute("MOBILE_FEED_STANDARD", "feed"),
      previewRoute("FACEBOOK_STORY_MOBILE", "story"),
      ["preview_iframe.php?d=feed", previewHtml("feed", [mp4("sd", 7, SD), mp4("hd", 7, HD)])],
      ["preview_iframe.php?d=story", previewHtml("story", [mp4("story", 8, HD)])],
    ]);
    const res = await getAdMedia(pageVideoAd("4343"), cfg);
    const [feed, story] = res.media;
    expect(feed.url).toMatch(/^https:\/\/video\.fbcdn\.net\/v\/hd\.mp4\?efg=.*&oh=sig&oe=6AA$/);
    expect(feed).toMatchObject({ url_from: "preview", preview_format: "MOBILE_FEED_STANDARD", length: 52 });
    expect(feed.error).toBeUndefined();
    expect(story.url).toContain("/story.mp4");
    expect(story.preview_format).toBe("FACEBOOK_STORY_MOBILE");
    expect(res.error).toBeUndefined();
    // the preview page is not sent the access token
    expect(calls.find((c) => c.url.includes("preview_iframe")).auth).toBeUndefined();
  });

  it("does not take a film from a preview that shows another one", async () => {
    serve([
      ["/4343?", { error: { code: 190, message: "no page access" } }],
      ["/80", noPermission],
      previewRoute("MOBILE_FEED_STANDARD", "feed"),
      ["ad_format=", { data: [{ body: `<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=other&amp;t=1"></iframe>` }] }],
      ["preview_iframe.php?d=feed", previewHtml("feed", [mp4("hd", 7, HD)])],
      ["preview_iframe.php?d=other", previewHtml("feed", [mp4("hd", 7, HD)])],
    ]);
    const res = await getAdMedia(pageVideoAd("4343"), cfg);
    expect(res.media[0].url).toContain("/hd.mp4");
    expect(res.media[1].url).toBeUndefined();
    expect(res.media[1].error).toMatch(/pages_read_engagement/);
    expect(res.error).toMatch(/1 of 2 could not be reached/);
  });

  it("leaves the preview alone when asked to", async () => {
    serve([
      ["/4343?", { error: { code: 190, message: "no page access" } }],
      ["/80", noPermission],
    ]);
    const res = await getAdMedia(pageVideoAd("4343"), cfg, { preview_video_urls: false });
    expect(res.media.every((m) => !m.url)).toBe(true);
    expect(res.media[0].error).toMatch(/page 4343.*pages_read_engagement/);
    expect(calls.some((c) => c.url.includes("/previews"))).toBe(false);
  });
});

describe("the wording of an ad that boosts a post", () => {
  it("reads the post with a token for the page", async () => {
    serve([
      ["/7?", { creative: { id: "2", object_story_spec: { page_id: "888" }, effective_object_story_id: "888_999" } }],
      ["/888?", { access_token: "PAGETOKEN" }],
      ["/888_999", { message: "The primary text", attachments: { data: [{ title: "The headline" }] } }],
    ]);
    expect(await getAdText("7", cfg)).toEqual({
      headline: "The headline",
      body: "The primary text",
    });
    const post = calls.find((c) => c.url.includes("888_999"));
    expect(post.auth).toBe("Bearer PAGETOKEN");
  });
});

// A flexible creative names its pictures by hash only. The address of each
// one is held by the ad account's picture library.
const hashAd = {
  id: "120254266274370547",
  name: "3_STJ16890_FB_Dental",
  creative: {
    id: "1700780627695097",
    object_type: "SHARE",
    object_story_spec: { page_id: "106755536029753" },
    effective_object_story_id: "106755536029753_1515321970628655",
  },
};

const hashCreative = {
  ...hashAd.creative,
  asset_feed_spec: {
    images: [{ hash: "aaa" }, { hash: "bbb" }],
  },
};

describe("pictures named by hash", () => {
  it("asks the picture library as a list, which is how Meta wants hashes", async () => {
    serve([
      ["/120254266274370547", { account_id: "998", creative: hashCreative }],
      ["/adimages", {
        data: [
          { hash: "aaa", url: "https://example.com/a.jpg", width: 1080, height: 1080 },
          { hash: "bbb", url: "https://example.com/b.jpg", width: 1080, height: 1080 },
        ],
      }],
    ]);
    const res = await getAdMedia(hashAd, cfg);
    expect(res.type).toBe("image");
    expect(res.media.map((m) => m.url)).toEqual([
      "https://example.com/a.jpg",
      "https://example.com/b.jpg",
    ]);
    expect(res.media[0].width).toBe(1080);
    expect(res.error).toBeUndefined();
    const lookup = calls.find((c) => c.url.includes("adimages"));
    expect(lookup.url).toContain("act_998");
    // a JSON list, not the comma separated kind Meta takes for fields
    expect(decodeURIComponent(lookup.url)).toContain('hashes=["aaa","bbb"]');
  });

  it("falls back to the post when the ad account does not hold them", async () => {
    serve([
      ["/120254266274370547", { account_id: "998", creative: hashCreative }],
      ["/adimages", { data: [] }],
      ["/106755536029753?", { access_token: "PAGETOKEN" }],
      ["/106755536029753_1515321970628655", {
        attachments: {
          data: [{ media_type: "photo", media: { image: { src: "https://example.com/post.jpg" } } }],
        },
      }],
    ]);
    const res = await getAdMedia(hashAd, cfg);
    expect(res.type).toBe("image");
    expect(res.from_post).toBe(true);
    expect(res.media).toEqual([{ kind: "image", url: "https://example.com/post.jpg" }]);
    expect(res.error).toBeUndefined();
  });

  it("says why when neither the library nor the post has them", async () => {
    serve([
      ["/120254266274370547", { account_id: "998", creative: hashCreative }],
      ["/adimages", { error: { code: 100, message: "Invalid hashes" } }],
      ["/106755536029753?", { error: { code: 190, message: "no page access" } }],
      ["/106755536029753_1515321970628655", { error: { code: 100, message: "Unsupported get request" } }],
    ]);
    const res = await getAdMedia(hashAd, cfg);
    expect(res.type).toBe("image");
    expect(res.media.every((m) => !m.url)).toBe(true);
    expect(res.error).toMatch(/2 of 2 could not be reached/);
    expect(res.error).toMatch(/could not read the pictures of ad account act_998/);
  });

  it("says so when there is no ad account to ask", async () => {
    serve([]);
    const ad = {
      id: "1",
      creative: { id: "2", asset_feed_spec: { images: [{ hash: "aaa" }] } },
    };
    const res = await getAdMedia(ad, {});
    expect(res.error).toMatch(/held by the ad account/);
  });
});
