export type ManagerSchedulerStatus = {
  readonly date: string;
  readonly tasks: ReadonlyArray<{
    readonly task: string;
    readonly completedAt?: string;
    readonly runCountToday: number;
    readonly canRunToday: boolean;
  }>;
};

export type ManagerHealthBriefing = {
  readonly generatedAt: string;
};

export type ManagerHealthDelivery = {
  readonly generatedAt: string;
  readonly deliveredAt: string;
  readonly channels: ReadonlyArray<{
    readonly channel: string;
    readonly ok: boolean;
    readonly completedAt: string;
    readonly error?: string;
  }>;
};

export type ManagerHealthWriteStatus = {
  readonly checkedAt: string;
  readonly capability: "authorized" | "unauthorized" | "dry-run-only" | "unknown";
  readonly action: string;
  readonly ok: boolean;
  readonly date?: string;
  readonly error?: string;
};

export type ManagerHealthOptions = {
  readonly maxBriefingAgeMinutes: number;
  readonly requireSentToday: boolean;
  readonly requireDelivery: boolean;
  readonly requireDeliveredToday?: boolean;
  readonly requireYahooWrites?: boolean;
  readonly now?: Date;
};

export type ManagerHealthReport = {
  readonly ok: boolean;
  readonly failures: ReadonlyArray<string>;
  readonly briefingAgeMinutes?: number;
  readonly sendBriefingCompletedAt?: string;
  readonly deliveryDeliveredAt?: string;
  readonly deliverySucceeded?: boolean;
};

export const managerHealthDefaults = {
  maxBriefingAgeMinutes: 180,
  requireSentToday: false,
  requireDelivery: false,
  requireDeliveredToday: false,
  requireYahooWrites: false,
} as const;

export const easternDateKey = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

export const ageMinutes = (isoTime: string | undefined, now = new Date()) => {
  if (isoTime == null) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(isoTime);
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((now.getTime() - timestamp) / 60_000));
};

export const evaluateManagerHealth = (
  scheduler: ManagerSchedulerStatus,
  briefing: ManagerHealthBriefing | undefined,
  delivery: ManagerHealthDelivery | undefined,
  writeStatusOrOptions: ManagerHealthWriteStatus | undefined | ManagerHealthOptions,
  maybeOptions?: ManagerHealthOptions,
): ManagerHealthReport => {
  const writeStatus =
    maybeOptions == null
      ? undefined
      : (writeStatusOrOptions as ManagerHealthWriteStatus | undefined);
  const options = maybeOptions ?? (writeStatusOrOptions as ManagerHealthOptions);
  const now = options.now ?? new Date();
  const failures: Array<string> = [];
  const sendBriefing = scheduler.tasks.find((task) => task.task === "send-briefing");
  const briefingAgeMinutes = ageMinutes(briefing?.generatedAt, now);
  if (briefing == null) {
    failures.push("cached briefing is missing");
  } else if (!Number.isFinite(briefingAgeMinutes)) {
    failures.push("cached briefing generatedAt is missing or invalid");
  } else if (briefingAgeMinutes > options.maxBriefingAgeMinutes) {
    failures.push(
      `cached briefing is ${briefingAgeMinutes}m old, above ${options.maxBriefingAgeMinutes}m`,
    );
  }
  if (sendBriefing == null) {
    failures.push("scheduler has no send-briefing task state");
  } else if (options.requireSentToday) {
    const completedDate =
      sendBriefing.completedAt == null
        ? undefined
        : easternDateKey(new Date(sendBriefing.completedAt));
    if (completedDate !== scheduler.date) {
      failures.push(
        `send-briefing last completed on ${completedDate ?? "never"}, not ${scheduler.date}`,
      );
    }
  }
  const deliverySucceeded = delivery?.channels.some((channel) => channel.ok) ?? false;
  if (options.requireDelivery && delivery == null) {
    failures.push("delivery report is missing");
  }
  if (options.requireDeliveredToday === true) {
    if (delivery == null) {
      failures.push("delivery report is missing");
    } else {
      const deliveredDate = easternDateKey(new Date(delivery.deliveredAt));
      if (deliveredDate !== scheduler.date) {
        failures.push(`latest delivery completed on ${deliveredDate}, not ${scheduler.date}`);
      }
      const successfulToday = delivery.channels.some(
        (channel) => channel.ok && easternDateKey(new Date(channel.completedAt)) === scheduler.date,
      );
      if (!successfulToday) {
        failures.push(`latest delivery has no successful channel on ${scheduler.date}`);
      }
    }
  }
  if (briefing != null && delivery != null && delivery.generatedAt !== briefing.generatedAt) {
    failures.push("latest delivery report does not match the cached briefing generation time");
  }
  if (delivery != null && !deliverySucceeded) {
    failures.push("latest delivery report has no successful channel");
  }
  if (options.requireYahooWrites === true) {
    if (writeStatus == null) {
      failures.push("Yahoo write status is missing; safe lineup auto-apply has not been checked");
    } else if (writeStatus.capability !== "authorized" || !writeStatus.ok) {
      failures.push(
        `Yahoo writes are ${writeStatus.capability}; safe lineup auto-apply is not authorized`,
      );
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    briefingAgeMinutes: Number.isFinite(briefingAgeMinutes) ? briefingAgeMinutes : undefined,
    sendBriefingCompletedAt: sendBriefing?.completedAt,
    deliveryDeliveredAt: delivery?.deliveredAt,
    deliverySucceeded: delivery == null ? undefined : deliverySucceeded,
  };
};
