const {
  queryValue,
  toQueryString,
  actId,
  appSecretProof,
  isTransientError,
  insightsFields,
  DEFAULT_FIELDS,
  creativeHeadlines,
  creativeBodies,
  creativeMedia,
  mediaType,
} = require("../api");

describe("query string encoding", () => {
  it("joins lists of scalars with commas", () => {
    expect(queryValue(["id", "name"])).toBe("id,name");
    expect(queryValue([1, 2])).toBe("1,2");
  });
  it("sends structured values as JSON", () => {
    expect(queryValue({ since: "2026-01-01", until: "2026-01-31" })).toBe(
      '{"since":"2026-01-01","until":"2026-01-31"}'
    );
    expect(queryValue([{ field: "spend", operator: "GREATER_THAN" }])).toBe(
      '[{"field":"spend","operator":"GREATER_THAN"}]'
    );
  });
  it("encodes booleans the way Meta expects", () => {
    expect(queryValue(true)).toBe("true");
    expect(queryValue(false)).toBe("false");
  });
  it("drops empty values", () => {
    expect(toQueryString({ a: 1, b: null, c: undefined, d: "" })).toBe("a=1");
  });
  it("url encodes keys and values", () => {
    expect(toQueryString({ fields: ["id", "creative{id,name}"] })).toBe(
      "fields=id%2Ccreative%7Bid%2Cname%7D"
    );
  });
});

describe("ad account ids", () => {
  it("adds the act_ prefix when missing", () => {
    expect(actId("12345")).toBe("act_12345");
    expect(actId(12345)).toBe("act_12345");
  });
  it("leaves an already prefixed id alone", () => {
    expect(actId("act_12345")).toBe("act_12345");
    expect(actId(" act_12345 ")).toBe("act_12345");
  });
});

describe("app secret proof", () => {
  it("is the hex hmac of the token with the app secret", () => {
    // computed with: echo -n TOKEN | openssl dgst -sha256 -hmac SECRET
    expect(appSecretProof("TOKEN", "SECRET")).toBe(
      require("crypto")
        .createHmac("sha256", "SECRET")
        .update("TOKEN")
        .digest("hex")
    );
    expect(appSecretProof("TOKEN", "SECRET")).toHaveLength(64);
  });
});

describe("transient errors", () => {
  it("retries rate limits and temporary failures", () => {
    expect(isTransientError({ code: 17 })).toBe(true);
    expect(isTransientError({ code: 4 })).toBe(true);
    expect(isTransientError({ code: 80004 })).toBe(true);
  });
  it("does not retry permission or request errors", () => {
    expect(isTransientError({ code: 100 })).toBe(false);
    expect(isTransientError({ code: 190 })).toBe(false);
    expect(isTransientError({ code: 200 })).toBe(false);
  });
});

describe("insights fields", () => {
  it("adds the dimensions of the requested level", () => {
    expect(insightsFields("campaign")).toContain("campaign_name");
    expect(insightsFields("campaign")).toContain("spend");
    expect(insightsFields("campaign")).not.toContain("ad_name");
    expect(insightsFields("ad")).toContain("ad_name");
  });
  it("returns only level independent metrics with no level", () => {
    expect(insightsFields()).not.toContain("campaign_name");
    expect(insightsFields()).toContain("impressions");
  });
});

describe("default fields", () => {
  it("always asks for the object id", () => {
    Object.values(DEFAULT_FIELDS).forEach((fields) => {
      expect(fields).toContain("id");
    });
  });
});

describe("finding the headline on a creative", () => {
  it("reads the headline of a link ad", () => {
    expect(
      creativeHeadlines({
        object_story_spec: {
          link_data: { name: "Half price today", message: "Primary text" },
        },
      })
    ).toEqual(["Half price today"]);
  });
  it("reads the headline of a video ad", () => {
    expect(
      creativeHeadlines({ object_story_spec: { video_data: { title: "Watch" } } })
    ).toEqual(["Watch"]);
  });
  it("reads the old style title field", () => {
    expect(creativeHeadlines({ title: "Legacy headline" })).toEqual([
      "Legacy headline",
    ]);
  });
  it("returns one headline per carousel card", () => {
    expect(
      creativeHeadlines({
        object_story_spec: {
          link_data: {
            name: "Our shop",
            child_attachments: [{ name: "Shoes" }, { name: "Hats" }],
          },
        },
      })
    ).toEqual(["Our shop", "Shoes", "Hats"]);
  });
  it("returns every headline of a dynamic creative, without repeats", () => {
    expect(
      creativeHeadlines({
        title: "Half price",
        asset_feed_spec: {
          titles: [{ text: "Half price" }, { text: "50% off" }],
        },
      })
    ).toEqual(["Half price", "50% off"]);
  });
  it("comes back empty when there is no headline to find", () => {
    expect(creativeHeadlines({ effective_object_story_id: "1_2" })).toEqual([]);
    expect(creativeHeadlines(null)).toEqual([]);
  });
});

describe("finding the primary text on a creative", () => {
  it("reads the text above the image of a link ad", () => {
    expect(
      creativeBodies({
        object_story_spec: {
          link_data: { name: "A headline", message: "The longer wording" },
        },
      })
    ).toEqual(["The longer wording"]);
  });
  it("reads the text of video, photo and text only ads", () => {
    expect(
      creativeBodies({ object_story_spec: { video_data: { message: "Video" } } })
    ).toEqual(["Video"]);
    expect(
      creativeBodies({ object_story_spec: { photo_data: { caption: "Photo" } } })
    ).toEqual(["Photo"]);
    expect(
      creativeBodies({ object_story_spec: { text_data: { message: "Text" } } })
    ).toEqual(["Text"]);
  });
  it("reads the old style body field", () => {
    expect(creativeBodies({ body: "Legacy body" })).toEqual(["Legacy body"]);
  });
  it("returns every primary text of a dynamic creative, without repeats", () => {
    expect(
      creativeBodies({
        body: "Shop the sale",
        asset_feed_spec: {
          bodies: [{ text: "Shop the sale" }, { text: "Everything reduced" }],
        },
      })
    ).toEqual(["Shop the sale", "Everything reduced"]);
  });
  it("does not mistake the headline for the primary text", () => {
    const creative = {
      title: "A headline",
      object_story_spec: { link_data: { name: "A headline" } },
    };
    expect(creativeBodies(creative)).toEqual([]);
    expect(creativeHeadlines(creative)).toEqual(["A headline"]);
  });
  it("comes back empty when there is no text to find", () => {
    expect(creativeBodies({ effective_object_story_id: "1_2" })).toEqual([]);
    expect(creativeBodies(null)).toEqual([]);
  });
});

describe("default fields", () => {
  it("asks for the dynamic creative assets", () => {
    expect(DEFAULT_FIELDS.adcreative).toContain("asset_feed_spec");
    expect(DEFAULT_FIELDS.adcreative).toContain("effective_object_story_id");
  });
  it("asks for both the headline and the primary text", () => {
    expect(DEFAULT_FIELDS.adcreative).toContain("title");
    expect(DEFAULT_FIELDS.adcreative).toContain("body");
  });
});

describe("finding the media on a creative", () => {
  it("reads the film of a video ad, with its still as the thumbnail", () => {
    const media = creativeMedia({
      video_id: "77",
      object_story_spec: {
        video_data: {
          video_id: "77",
          title: "Watch",
          image_url: "https://example.com/still.jpg",
          image_hash: "abc",
        },
      },
    });
    expect(media).toEqual([
      {
        kind: "video",
        video_id: "77",
        thumbnail_url: "https://example.com/still.jpg",
        thumbnail_hash: "abc",
        name: "Watch",
      },
    ]);
    // the still of a film is not a picture of its own
    expect(mediaType(media)).toBe("video");
  });
  it("reads the picture of a link ad", () => {
    const media = creativeMedia({
      object_story_spec: {
        link_data: {
          name: "Half price",
          image_hash: "hash1",
          picture: "https://example.com/pic.jpg",
          link: "https://example.com",
        },
      },
    });
    expect(media).toEqual([
      {
        kind: "image",
        url: "https://example.com/pic.jpg",
        image_hash: "hash1",
        name: "Half price",
        link: "https://example.com",
      },
    ]);
    expect(mediaType(media)).toBe("image");
  });
  it("reads a photo ad", () => {
    expect(
      creativeMedia({
        object_story_spec: {
          photo_data: { url: "https://example.com/photo.jpg", image_hash: "h" },
        },
      })
    ).toEqual([
      { kind: "image", url: "https://example.com/photo.jpg", image_hash: "h" },
    ]);
  });
  it("returns one entry per carousel card, in order", () => {
    const media = creativeMedia({
      object_story_spec: {
        link_data: {
          image_hash: "cover",
          child_attachments: [
            { image_hash: "h1", name: "Shoes" },
            { video_id: "v2", name: "Hats", picture: "https://x/2.jpg" },
          ],
        },
      },
    });
    expect(media.map((m) => m.kind)).toEqual(["image", "video"]);
    expect(media.map((m) => m.name)).toEqual(["Shoes", "Hats"]);
    // a carousel with a film in it counts as a mixed ad
    expect(mediaType(media)).toBe("mixed");
  });
  it("reads the assets of a dynamic creative, without repeats", () => {
    const media = creativeMedia({
      image_url: "https://example.com/a.jpg",
      asset_feed_spec: {
        images: [{ hash: "h1", url: "https://example.com/a.jpg" }],
        videos: [{ video_id: "v1", thumbnail_url: "https://example.com/t.jpg" }],
      },
    });
    expect(media).toHaveLength(2);
    expect(mediaType(media)).toBe("mixed");
  });
  it("does not repeat the same picture reached by two routes", () => {
    const media = creativeMedia({
      image_hash: "h1",
      image_url: "https://example.com/a.jpg",
      object_story_spec: {
        link_data: { image_hash: "h1", picture: "https://example.com/a.jpg" },
      },
    });
    expect(media).toHaveLength(1);
  });
  it("comes back empty for an ad that promotes an existing post", () => {
    expect(creativeMedia({ effective_object_story_id: "1_2" })).toEqual([]);
    expect(creativeMedia(null)).toEqual([]);
    expect(mediaType([])).toBe("unknown");
  });
});

describe("default fields", () => {
  it("asks what kind of ad each ad is", () => {
    const creative = DEFAULT_FIELDS.ad.find((f) => f.startsWith("creative{"));
    expect(creative).toContain("object_type");
    expect(creative).toContain("video_id");
    expect(creative).toContain("image_url");
  });
});
