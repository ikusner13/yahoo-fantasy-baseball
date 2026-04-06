# Cloudflare Deploy Guide

## 1. Create D1 Database

```sh
wrangler d1 create fantasy-baseball
```

Copy the `database_id` from the output into `wrangler.jsonc` → `d1_databases[0].database_id`.

## 2. Generate & Apply Migrations

```sh
pnpm db:generate
pnpm db:migrate:local   # test locally first
pnpm db:migrate:remote  # apply to production D1
```

## 3. Create KV Namespace

```sh
wrangler kv namespace create KV
```

Copy the `id` from the output into `wrangler.jsonc` → `kv_namespaces[0].id`.

## 4. Set Secrets

```sh
wrangler secret put YAHOO_CLIENT_ID
wrangler secret put YAHOO_CLIENT_SECRET
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put OPENROUTER_API_KEY
```

Optional:

```sh
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put OPENAI_API_KEY
wrangler secret put ODDS_API_KEY
```

## 5. Migrate Existing Data

Export from local SQLite and import to D1:

```sh
# Export tables from local fantasy.db
sqlite3 data/fantasy.db .dump > /tmp/fantasy-dump.sql

# Import to D1 (skip CREATE TABLE lines since schema is already applied)
wrangler d1 execute fantasy-baseball --file=/tmp/fantasy-dump.sql --remote
```

Migrate Yahoo tokens to KV:

```sh
# Read existing tokens
cat data/yahoo-tokens.json

# Write to KV
wrangler kv key put --binding=KV yahoo-tokens '{"accessToken":"...","refreshToken":"...","expiresAt":...}'
```

## 6. Test Locally

```sh
pnpm dev  # runs wrangler dev
# Visit http://localhost:8787/health
# Visit http://localhost:8787/auth to test OAuth flow
```

Test cron dispatch:

```sh
curl "http://localhost:8787/__scheduled?cron=0+13+*+*+*"
```

## 7. Deploy

```sh
pnpm deploy
```

## 8. Set Up Telegram Webhook

Point Telegram to your Worker URL:

```sh
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://fantasy-baseball.<your-subdomain>.workers.dev/telegram"
```

## 9. Verify

- Hit `https://fantasy-baseball.<your-subdomain>.workers.dev/health`
- Wait for next cron trigger or test via `wrangler dev --test-scheduled`
- Check Cloudflare dashboard for D1 query stats and cron execution logs
