const Table = require("@saltcorn/data/models/table");
const Trigger = require("@saltcorn/data/models/trigger");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const {
  objectTypeNames,
  INSIGHTS_LEVELS,
  DATE_PRESETS,
  EFFECTIVE_STATUSES,
  fetchObjects,
  coerceValue,
} = require("./common");

const INSIGHTS_ONLY = { object_type: "Insights" };
const HAS_STATUS = { object_type: ["Campaigns", "Ad sets", "Ads"] };
const NEEDS_ACCOUNT = {
  object_type: ["Campaigns", "Ad sets", "Ads", "Ad creatives", "Insights"],
};

const objMap = (obj, f) => {
  const result = {};
  Object.keys(obj).forEach((k) => {
    result[k] = f(obj[k]);
  });
  return result;
};

const typeName = (field) =>
  typeof field.type === "string" ? field.type : field.type?.name;

/**
 * Copy Meta objects into a Saltcorn table. Unlike the table provider, which
 * shows what Meta has right now, this keeps a permanent copy: useful because
 * Meta only keeps insights for a limited period.
 */
module.exports = (cfg) => ({
  description:
    "Copy campaigns, ad sets, ads or insights from Meta into a Saltcorn table",
  configFields: async () => {
    const tables = await Table.find({});
    const tableMap = {};
    tables.forEach((t) => (tableMap[t.name] = t));

    const namedFields = (pred) =>
      objMap(tableMap, (table) =>
        table.fields.filter(pred).map((f) => f.name)
      );
    const strFields = namedFields((f) => typeName(f) === "String");
    const jsonFields = objMap(tableMap, (table) => [
      "",
      ...table.fields
        .filter((f) => typeName(f) === "JSON")
        .map((f) => f.name),
    ]);
    const allFields = objMap(tableMap, (table) =>
      table.fields.filter((f) => !f.primary_key).map((f) => f.name)
    );
    const triggers = await Trigger.find({});

    return [
      {
        name: "object_type",
        label: "Object type",
        sublabel: "What to read from Meta",
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
        sublabel: "Comma separated, for example age,gender",
        type: "String",
        showIf: INSIGHTS_ONLY,
      },
      {
        name: "asynchronous",
        label: "Asynchronous report",
        sublabel:
          "Submit the report as a job and wait for it. Needed for large date ranges.",
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
        sublabel: "Advanced: a Marketing API filtering clause, as JSON",
        type: "String",
        fieldview: "textarea",
      },
      {
        name: "limit",
        label: "Rows per request",
        type: "Integer",
        default: 200,
      },
      {
        name: "max_pages",
        label: "Maximum pages",
        sublabel: "Stop after this many requests",
        type: "Integer",
        default: 50,
      },
      {
        input_type: "section_header",
        label: "Destination",
      },
      {
        name: "table_dest",
        label: "Destination table",
        sublabel: "The Saltcorn table to write to",
        input_type: "select",
        required: true,
        options: tables.map((t) => t.name),
      },
      {
        name: "id_field",
        label: "Meta id field",
        sublabel:
          "Text field holding the Meta object id. Rows are matched on this, so each object is stored once.",
        type: "String",
        required: true,
        attributes: { calcOptions: ["table_dest", strFields] },
      },
      {
        name: "data_field",
        label: "Raw data field",
        sublabel:
          "Optional JSON field in which to store the whole object as it came from Meta",
        type: "String",
        attributes: { calcOptions: ["table_dest", jsonFields] },
      },
      {
        input_type: "section_header",
        label: "Field mapping",
        sublabel:
          "Table fields whose name matches a Meta field are filled in automatically. Add a row below for any field that needs a different name.",
      },
      new FieldRepeat({
        name: "field_map",
        fields: [
          {
            name: "table_field",
            label: "Table field",
            type: "String",
            required: true,
            attributes: { calcOptions: ["table_dest", allFields] },
          },
          {
            name: "meta_field",
            label: "Meta field",
            sublabel:
              "Name as returned by Meta. Nested values are joined with an underscore, for example creative_thumbnail_url.",
            type: "String",
            required: true,
          },
        ],
      }),
      {
        input_type: "section_header",
        label: "Options",
      },
      {
        name: "delete_missing",
        label: "Delete missing rows",
        sublabel:
          "Delete rows in the destination table that Meta no longer returns",
        type: "Bool",
      },
      {
        name: "error_action",
        label: "Error action",
        sublabel: "Run this action if the synchronisation fails",
        type: "String",
        attributes: { options: triggers.map((tr) => tr.name) },
      },
    ];
  },
  requireRow: false,

  run: async ({ configuration, user, req }) => {
    const {
      table_dest,
      id_field,
      data_field,
      field_map,
      delete_missing,
      error_action,
    } = configuration;
    try {
      const table = Table.findOne({ name: table_dest });
      if (!table) throw new Error(`Table not found: ${table_dest}`);

      const metaRows = await fetchObjects({ cfg, config: configuration });

      // explicit mappings win over matching by name
      const explicit = {};
      (field_map || []).forEach((m) => {
        if (m?.table_field && m?.meta_field)
          explicit[m.table_field] = m.meta_field;
      });

      const seen = new Set();
      let inserted = 0;
      let updated = 0;
      let deleted = 0;

      for (const metaRow of metaRows) {
        const key = `${metaRow.id}`;
        if (!metaRow.id) continue;
        seen.add(key);
        const dbRow = {};
        for (const field of table.fields) {
          if (field.primary_key) continue;
          if (field.name === id_field) continue;
          if (data_field && field.name === data_field) {
            dbRow[field.name] = metaRow;
            continue;
          }
          const source = explicit[field.name] || field.name;
          if (typeof metaRow[source] === "undefined") continue;
          dbRow[field.name] = coerceValue(metaRow[source], typeName(field));
        }
        dbRow[id_field] = key;
        const existing = await table.getRow({ [id_field]: key });
        if (existing) {
          await table.updateRow(dbRow, existing[table.pk_name], user);
          updated += 1;
        } else {
          await table.insertRow(dbRow, user);
          inserted += 1;
        }
      }

      if (delete_missing) {
        const existingRows = await table.getRows({});
        for (const row of existingRows) {
          if (seen.has(`${row[id_field]}`)) continue;
          await table.deleteRows({ [table.pk_name]: row[table.pk_name] }, user);
          deleted += 1;
        }
      }

      return {
        inserted,
        updated,
        deleted,
        notify: `Meta sync: ${inserted} new, ${updated} updated${
          delete_missing ? `, ${deleted} deleted` : ""
        }`,
      };
    } catch (e) {
      console.error("Meta sync error", e);
      if (error_action) {
        const trigger = Trigger.findOne({ name: error_action });
        if (trigger)
          await trigger.runWithoutRow({
            user,
            req,
            row: { error: e.message },
          });
        return { error: e.message };
      }
      throw e;
    }
  },
});
