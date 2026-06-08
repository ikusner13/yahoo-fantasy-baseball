import * as Schema from "effect/Schema";

export const LAST_MANAGER_WRITE_STATUS_CACHE_KEY = "manager-write-status:last:v1";

export class ManagerWriteStatus extends Schema.Class<ManagerWriteStatus>("ManagerWriteStatus")({
  checkedAt: Schema.String,
  capability: Schema.Union([
    Schema.Literal("authorized"),
    Schema.Literal("unauthorized"),
    Schema.Literal("dry-run-only"),
    Schema.Literal("unknown"),
  ]),
  action: Schema.String,
  ok: Schema.Boolean,
  date: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
}) {}
