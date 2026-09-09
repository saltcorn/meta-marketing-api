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
    const hit = routes.find(([match]) => url.includes(match));
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(hit ? hit[1] : { error: { code: 100, message: `no route for ${url}` } }),
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
