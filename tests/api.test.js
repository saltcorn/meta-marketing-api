const {
  queryValue,
  toQueryString,
  actId,
  appSecretProof,
  isTransientError,
  insightsFields,
  DEFAULT_FIELDS,
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
