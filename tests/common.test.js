const {
  flattenRow,
  guessType,
  coerceValue,
  coerceRow,
  buildQuery,
  insightsRowId,
  rowMatches,
  applyWhere,
  pushdownParents,
  fieldsFor,
} = require("../common");

describe("flattening Graph API rows", () => {
  it("flattens nested objects into underscored names", () => {
    const flat = flattenRow({
      id: "1",
      name: "An ad",
      creative: { id: "2", thumbnail_url: "http://x/y.png" },
    });
    expect(flat).toEqual({
      id: "1",
      name: "An ad",
      creative_id: "2",
      creative_thumbnail_url: "http://x/y.png",
    });
  });
  it("keeps arrays whole", () => {
    const flat = flattenRow({
      id: "1",
      actions: [{ action_type: "link_click", value: "5" }],
    });
    expect(flat.actions).toEqual([{ action_type: "link_click", value: "5" }]);
  });
});

describe("column type guessing", () => {
  it("treats budgets and spend as whole numbers of cents", () => {
    expect(guessType("daily_budget", "5000")).toBe("Integer");
    expect(guessType("budget_remaining", "120")).toBe("Integer");
    expect(guessType("amount_spent", "9")).toBe("Integer");
  });
  it("treats insights metrics as numbers", () => {
    expect(guessType("spend", "12.34")).toBe("Float");
    expect(guessType("ctr", "0.9")).toBe("Float");
    expect(guessType("impressions", "1000")).toBe("Integer");
  });
  it("recognises dates, objects and plain text", () => {
    expect(guessType("created_time", "2026-01-01T09:00:00+0000")).toBe("Date");
    expect(guessType("date_start", "2026-01-01")).toBe("Date");
    expect(guessType("actions", [])).toBe("JSON");
    expect(guessType("name", "Summer sale")).toBe("String");
  });
});

describe("coercion to column types", () => {
  it("converts the strings Meta returns", () => {
    expect(coerceValue("1000", "Integer")).toBe(1000);
    expect(coerceValue("12.34", "Float")).toBe(12.34);
    expect(coerceValue("true", "Bool")).toBe(true);
    expect(coerceValue("2026-01-01", "Date")).toEqual(new Date("2026-01-01"));
  });
  it("returns null rather than NaN for missing numbers", () => {
    expect(coerceValue(undefined, "Integer")).toBe(null);
    expect(coerceValue("", "Float")).toBe(null);
  });
  it("keeps only the configured columns", () => {
    const row = coerceRow(
      { id: "1", spend: "3.5", extra: "ignore me" },
      [
        { name: "id", type: "String" },
        { name: "spend", type: "Float" },
      ]
    );
    expect(row).toEqual({ id: "1", spend: 3.5 });
  });
});

describe("building the API query", () => {
  it("uses the default fields of the object type", () => {
    const q = buildQuery("Campaigns", {});
    expect(q.fields).toContain("objective");
  });
  it("sends statuses as a JSON array", () => {
    const q = buildQuery("Ads", { effective_status: "ACTIVE, PAUSED" });
    expect(q.effective_status).toBe('["ACTIVE","PAUSED"]');
  });
  it("prefers an explicit date range over the preset", () => {
    const q = buildQuery("Insights", {
      date_preset: "last_7d",
      since: "2026-01-01",
      until: "2026-01-31",
    });
    expect(q.time_range).toEqual({
      since: "2026-01-01",
      until: "2026-01-31",
    });
    expect(q.date_preset).toBeUndefined();
  });
  it("takes the level into account when choosing fields", () => {
    expect(buildQuery("Insights", { level: "adset" }).fields).toContain(
      "adset_name"
    );
  });
  it("splits comma separated settings", () => {
    const q = buildQuery("Insights", { breakdowns: "age, gender" });
    expect(q.breakdowns).toEqual(["age", "gender"]);
  });
  it("accepts explicit fields", () => {
    expect(fieldsFor("Campaigns", { fields: "id,name" })).toEqual([
      "id",
      "name",
    ]);
  });
});

describe("insights row ids", () => {
  it("is stable for the same dimensions", () => {
    const row = { date_start: "2026-01-01", campaign_id: "7" };
    expect(insightsRowId(row)).toBe(insightsRowId({ ...row }));
  });
  it("differs when a dimension differs", () => {
    expect(insightsRowId({ campaign_id: "7" })).not.toBe(
      insightsRowId({ campaign_id: "8" })
    );
  });
  it("takes breakdowns into account", () => {
    const a = { campaign_id: "7", gender: "male" };
    const b = { campaign_id: "7", gender: "female" };
    expect(insightsRowId(a, ["gender"])).not.toBe(insightsRowId(b, ["gender"]));
  });
});

describe("in memory filtering", () => {
  const rows = [
    { id: "1", name: "Summer", spend: 10, status: "ACTIVE" },
    { id: "2", name: "Winter", spend: 30, status: "PAUSED" },
    { id: "3", name: "Spring sale", spend: 20, status: "ACTIVE" },
  ];
  it("matches on equality, whatever the type", () => {
    expect(rowMatches(rows[0], { status: "ACTIVE" })).toBe(true);
    expect(rowMatches(rows[0], { id: 1 })).toBe(true);
    expect(rowMatches(rows[0], { status: "PAUSED" })).toBe(false);
  });
  it("supports the search and comparison operators views use", () => {
    expect(rowMatches(rows[2], { name: { ilike: "sale" } })).toBe(true);
    expect(rowMatches(rows[0], { spend: { gt: 5 } })).toBe(true);
    expect(rowMatches(rows[0], { spend: { lt: 10, equal: true } })).toBe(true);
    expect(rowMatches(rows[0], { id: { in: ["1", "2"] } })).toBe(true);
    expect(rowMatches(rows[0], { or: [{ id: "9" }, { id: "1" }] })).toBe(true);
  });
  it("does not hide rows on operators it cannot apply", () => {
    expect(rowMatches(rows[0], { spend: { inSelect: {} } })).toBe(true);
  });
  it("sorts, offsets and limits", () => {
    expect(
      applyWhere(rows, {}, { orderBy: "spend", orderDesc: true }).map(
        (r) => r.id
      )
    ).toEqual(["2", "3", "1"]);
    expect(applyWhere(rows, { limit: 2 }).map((r) => r.id)).toEqual(["1", "2"]);
    expect(applyWhere(rows, { offset: 2 }).map((r) => r.id)).toEqual(["3"]);
    expect(applyWhere(rows, { status: "ACTIVE" }).map((r) => r.id)).toEqual([
      "1",
      "3",
    ]);
  });
  it("ignores the paging keys when matching", () => {
    expect(rowMatches(rows[0], { limit: 10, offset: 0 })).toBe(true);
  });
});

describe("pushing filters down to a narrower endpoint", () => {
  it("uses the campaign or ad set edge when the id is known", () => {
    expect(pushdownParents("Ads", { campaign_id: "7" })).toEqual({
      campaign_id: "7",
    });
    expect(pushdownParents("Ad sets", { campaign_id: "7" })).toEqual({
      campaign_id: "7",
    });
  });
  it("ignores ids that are not a plain value", () => {
    expect(pushdownParents("Ads", { campaign_id: { ilike: "7" } })).toEqual({});
    expect(pushdownParents("Campaigns", { campaign_id: "7" })).toEqual({});
  });
});
