const Form = require("@saltcorn/data/models/form");
const Field = require("@saltcorn/data/models/field");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const Workflow = require("@saltcorn/data/models/workflow");
const { getState } = require("@saltcorn/data/db/state");
const { mkTable } = require("@saltcorn/markup");
const { div, p, pre, code } = require("@saltcorn/markup/tags");
const {
  objectTypeNames,
  INSIGHTS_LEVELS,
  DATE_PRESETS,
  EFFECTIVE_STATUSES,
  fetchObjects,
  pushdownParents,
  guessType,
  coerceRow,
  applyWhere,
  rowMatches,
} = require("./common");

const INSIGHTS_ONLY = { object_type: "Insights" };
const HAS_STATUS = { object_type: ["Campaigns", "Ad sets", "Ads"] };
const NEEDS_ACCOUNT = {
  object_type: ["Campaigns", "Ad sets", "Ads", "Ad creatives", "Insights"],
};

// Rows are held briefly so that opening a list view does not hit the
// Marketing API once for every column filter and page click.
const rowCache = new Map();

const pruneCache = () => {
  if (rowCache.size < 50) return;
  const entries = [...rowCache.entries()].sort((a, b) => a[1].at - b[1].at);
  entries.slice(0, entries.length - 25).forEach(([k]) => rowCache.delete(k));
};

const getRowsCached = async (pluginCfg, config, where) => {
  const parents = pushdownParents(config?.object_type, where);
  const seconds =
    typeof config?.cache_seconds === "number" ? config.cache_seconds : 60;
  const key = JSON.stringify({ config, parents });
  const hit = rowCache.get(key);
  if (hit && seconds > 0 && Date.now() - hit.at < seconds * 1000)
    return hit.rows;
  const rows = await fetchObjects({ cfg: pluginCfg, config, where });
  if (seconds > 0) {
    rowCache.set(key, { rows, at: Date.now() });
    pruneCache();
  }
  return rows;
};

const typeOptions = () => {
  const names = getState()?.type_names || [];
  const basic = ["String", "Integer", "Float", "Bool", "Date", "JSON"];
  return names.length ? names : basic;
};

const configuration_workflow = (pluginCfg) => (req) =>
  new Workflow({
    steps: [
      {
        name: "Meta object",
        form: async () =>
          new Form({
            fields: [
              {
                name: "object_type",
                label: "Object type",
                sublabel: "What this table should show",
                type: "String",
                required: true,
                attributes: { options: objectTypeNames },
              },
              {
                name: "ad_account_id",
                label: "Ad account",
                sublabel:
                  "Ad account id, with or without the act_ prefix. Leave blank to use the default ad account from the plugin settings.",
                type: "String",
                showIf: NEEDS_ACCOUNT,
              },
              {
                name: "object_id",
                label: "Report on",
                sublabel:
                  "Id of the campaign, ad set or ad to report on. Leave blank to report on the whole ad account.",
                type: "String",
                showIf: INSIGHTS_ONLY,
              },
              {
                name: "level",
                label: "Level",
                sublabel: "One row per what",
                type: "String",
                attributes: { options: INSIGHTS_LEVELS },
                showIf: INSIGHTS_ONLY,
              },
              {
                name: "date_preset",
                label: "Date range",
                type: "String",
                attributes: { options: DATE_PRESETS },
                showIf: INSIGHTS_ONLY,
              },
              {
                name: "since",
                label: "From date",
                sublabel:
                  "YYYY-MM-DD. Overrides the date range above when both this and the To date are set.",
                type: "String",
                showIf: INSIGHTS_ONLY,
              },
              {
                name: "until",
                label: "To date",
                sublabel: "YYYY-MM-DD",
                type: "String",
                showIf: INSIGHTS_ONLY,
              },
              {
                name: "time_increment",
                label: "Time increment",
                sublabel:
                  "Number of days per row, or monthly or all_days. Blank gives one row for the whole period.",
                type: "String",
                showIf: INSIGHTS_ONLY,
              },
              {
                name: "breakdowns",
                label: "Breakdowns",
                sublabel:
                  "Comma separated, for example age,gender or publisher_platform",
                type: "String",
                showIf: INSIGHTS_ONLY,
              },
              {
                name: "action_breakdowns",
                label: "Action breakdowns",
                sublabel: "Comma separated, for example action_type",
                type: "String",
                showIf: INSIGHTS_ONLY,
              },
              {
                name: "asynchronous",
                label: "Asynchronous report",
                sublabel:
                  "Submit the report as a job and wait for it. Slower to start, but needed for large date ranges.",
                type: "Bool",
                showIf: INSIGHTS_ONLY,
              },
              {
                name: "effective_status",
                label: "Statuses",
                sublabel: `Comma separated. Leave blank for all. One or more of: ${EFFECTIVE_STATUSES.join(
                  ", "
                )}`,
                type: "String",
                showIf: HAS_STATUS,
              },
              {
                name: "fields",
                label: "Fields",
                sublabel:
                  "Comma separated list of Meta API fields. Leave blank for a sensible default set.",
                type: "String",
                fieldview: "textarea",
              },
              {
                name: "filtering",
                label: "Filtering",
                sublabel:
                  'Advanced: a Marketing API filtering clause, for example [{"field":"campaign.name","operator":"CONTAIN","value":"Summer"}]',
                type: "String",
                fieldview: "textarea",
              },
              {
                name: "extra_params",
                label: "Extra parameters",
                sublabel:
                  'Advanced: further query parameters as JSON, for example {"time_zone":"UTC"}',
                type: "String",
                fieldview: "textarea",
              },
              {
                name: "limit",
                label: "Rows per request",
                sublabel: "How many rows to ask Meta for at a time",
                type: "Integer",
                default: 200,
              },
              {
                name: "max_pages",
                label: "Maximum pages",
                sublabel: "Stop after this many requests",
                type: "Integer",
                default: 10,
              },
              {
                name: "cache_seconds",
                label: "Cache for (seconds)",
                sublabel:
                  "How long to reuse rows already read from Meta. 0 disables caching.",
                type: "Integer",
                default: 60,
              },
            ],
          }),
      },
      {
        name: "Columns",
        form: async (context) => {
          let rows = [];
          let error;
          try {
            rows = await fetchObjects({ cfg: pluginCfg, config: context });
          } catch (e) {
            error = e.message;
          }
          const names = [];
          rows.slice(0, 50).forEach((r) =>
            Object.keys(r).forEach((k) => {
              if (!names.includes(k)) names.push(k);
            })
          );
          const sample = mkTable(
            names.map((n) => ({ label: n, key: n })),
            rows.slice(0, 5).map((r) => {
              const shown = {};
              names.forEach((n) => {
                shown[n] =
                  r[n] && typeof r[n] === "object"
                    ? JSON.stringify(r[n]).slice(0, 60)
                    : r[n];
              });
              return shown;
            })
          );
          const form = new Form({
            blurb: error
              ? div(
                  { class: "alert alert-danger" },
                  "Could not read from Meta: ",
                  error
                )
              : div(
                  p(`${rows.length} rows read, showing the first few:`),
                  sample
                ),
            fields: [
              {
                input_type: "section_header",
                label: "Column types",
              },
              new FieldRepeat({
                name: "columns",
                fields: [
                  {
                    name: "name",
                    label: "Field",
                    type: "String",
                    required: true,
                  },
                  {
                    name: "label",
                    label: "Label",
                    type: "String",
                    required: true,
                  },
                  {
                    name: "type",
                    label: "Type",
                    type: "String",
                    required: true,
                    attributes: { options: typeOptions() },
                  },
                  {
                    name: "primary_key",
                    label: "Primary key",
                    type: "Bool",
                  },
                ],
              }),
            ],
          });
          if (!context.columns || !context.columns.length) {
            if (!form.values) form.values = {};
            form.values.columns = names.map((name) => ({
              name,
              label: Field.nameToLabel(name),
              type: guessType(
                name,
                rows.find((r) => typeof r[name] !== "undefined")?.[name]
              ),
              primary_key: name === "id",
            }));
          }
          return form;
        },
      },
    ],
  });

/** The columns of the table, with a primary key guaranteed */
const providerFields = (cfg) => {
  const columns = (cfg?.columns || []).map((c) => ({ ...c }));
  if (!columns.length) return columns;
  if (!columns.some((c) => c.primary_key)) {
    const idCol = columns.find((c) => c.name === "id") || columns[0];
    idCol.primary_key = true;
  }
  return columns;
};

const get_table = (pluginCfg) => (cfg) => {
  const columns = providerFields(cfg);
  return {
    getRows: async (where = {}, opts = {}) => {
      const rows = await getRowsCached(pluginCfg, cfg, where);
      return applyWhere(
        rows.map((r) => coerceRow(r, columns)),
        where,
        opts
      );
    },
    countRows: async (where = {}) => {
      const rows = await getRowsCached(pluginCfg, cfg, where);
      return rows
        .map((r) => coerceRow(r, columns))
        .filter((r) => rowMatches(r, where)).length;
    },
    distinctValues: async (fieldNm) => {
      const rows = await getRowsCached(pluginCfg, cfg, {});
      const seen = new Set();
      rows.map((r) => coerceRow(r, columns)).forEach((r) => {
        const v = r[fieldNm];
        if (v !== null && typeof v !== "undefined" && typeof v !== "object")
          seen.add(v);
      });
      return [...seen].sort();
    },
  };
};

module.exports = (pluginCfg) => ({
  "Meta ads": {
    configuration_workflow: configuration_workflow(pluginCfg),
    fields: (cfg) => providerFields(cfg),
    get_table: get_table(pluginCfg),
  },
});
