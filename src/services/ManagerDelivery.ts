import * as Schema from "effect/Schema";

export const LAST_MANAGER_DELIVERY_CACHE_KEY = "manager-briefing:delivery:last:v1";

export class ManagerDeliveryChannelResult extends Schema.Class<ManagerDeliveryChannelResult>(
  "ManagerDeliveryChannelResult",
)({
  channel: Schema.Union([Schema.Literal("telegram"), Schema.Literal("discord")]),
  ok: Schema.Boolean,
  completedAt: Schema.String,
  error: Schema.optional(Schema.String),
}) {}

export class ManagerDeliveryReport extends Schema.Class<ManagerDeliveryReport>(
  "ManagerDeliveryReport",
)({
  generatedAt: Schema.String,
  deliveredAt: Schema.String,
  channels: Schema.Array(ManagerDeliveryChannelResult),
}) {}

export const deliverySucceeded = (report: ManagerDeliveryReport | undefined) =>
  report != null && report.channels.some((channel) => channel.ok);
