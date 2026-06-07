import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

export const DecisionLogDb = Cloudflare.D1Database("DB", {
  migrationsDir: "./db/migrations",
  migrationsTable: "d1_migrations",
});

export const LeagueStateCache = Cloudflare.KVNamespace("LEAGUE_STATE", {
  title: "fantasy-gm-league-state",
});

export const ProjectionArtifacts = Cloudflare.R2Bucket("PROJECTION_ARTIFACTS", {
  name: "fantasy-gm-projection-artifacts",
});

export const SecretStore = Cloudflare.SecretsStore("SecretStore");

const appSecret = (logicalId: string, envName: string) =>
  Effect.gen(function* () {
    const store = yield* SecretStore;
    const value = yield* Config.string(envName).pipe(Effect.map(Redacted.make));

    return yield* Cloudflare.Secret(logicalId, {
      store,
      name: envName,
      value,
    });
  });

const optionalAppSecret = (logicalId: string, envName: string) =>
  Config.string(envName).pipe(
    Config.option,
    Effect.flatMap((value) =>
      Option.match(value, {
        onNone: () => Effect.void,
        onSome: () => appSecret(logicalId, envName),
      }),
    ),
  );

export const YahooClientSecret = appSecret("YahooClientSecret", "YAHOO_CLIENT_SECRET");
export const YahooRefreshToken = appSecret("YahooRefreshToken", "YAHOO_REFRESH_TOKEN");
export const TelegramBotToken = optionalAppSecret("TelegramBotToken", "TELEGRAM_BOT_TOKEN");
export const DiscordBotToken = optionalAppSecret("DiscordBotToken", "DISCORD_BOT_TOKEN");
export const OpenRouterApiKey = optionalAppSecret("OpenRouterApiKey", "OPENROUTER_API_KEY");
export const AnthropicApiKey = optionalAppSecret("AnthropicApiKey", "ANTHROPIC_API_KEY");
export const OddsApiKey = appSecret("OddsApiKey", "ODDS_API_KEY");

export const AppSecrets = Effect.all([
  YahooClientSecret,
  YahooRefreshToken,
  TelegramBotToken,
  DiscordBotToken,
  OpenRouterApiKey,
  AnthropicApiKey,
  OddsApiKey,
]).pipe(Effect.map((secrets) => secrets.filter((secret) => secret !== undefined)));
