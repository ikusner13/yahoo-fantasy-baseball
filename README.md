# Fantasy Baseball GM

An AI fantasy baseball advisor for Yahoo Fantasy Baseball. It monitors your league 24/7, recommends optimal lineups, scouts the waiver wire, evaluates trades, tracks injuries, and sends execution-ready recommendations via Telegram — all running serverlessly on Cloudflare Workers.

Built for **head-to-head categories** leagues. Every decision is driven by LLM analysis layered on top of real statistical data: rest-of-season projections from FanGraphs, Statcast metrics, pitcher/batter splits, park factors, Vegas run lines, and your current matchup context.

## How It Works

The GM runs as a Cloudflare Worker with scheduled cron triggers. Each trigger fires a specific analysis task that reads your roster, evaluates the situation, consults an LLM, and sends you a Telegram message with what it found and what it recommends. Yahoo API access is currently read-only for this setup, so lineup and transaction changes are executed manually through Yahoo deep links.

**Daily:**

- **Morning analysis** — reviews your lineup for the day, checks projected starters, identifies optimal sits/starts based on matchups, park factors, and recent performance
- **Late scratch check** — catches last-minute lineup changes before games lock

**Weekly:**

- **Monday** — full matchup breakdown against your opponent, identifies category targets and punt candidates
- **Wednesday** — mid-week adjustment based on how the matchup is trending
- **Friday** — two-start pitcher preview for the upcoming week
- **Saturday** — trade evaluation, proposes and analyzes potential deals
- **Sunday** — end-of-week tactics for close categories

**Continuous:**

- **News monitoring** (every 30 min) — player news alerts with deduplication so you don't get spammed

All decisions are logged to a database with reasoning, and the GM runs weekly retrospectives to learn from outcomes.

### Telegram Integration

The GM sends all recommendations to Telegram with direct Yahoo links so you can apply them quickly.

Commands you can send to the bot:

- `/status` — confirm the GM is running
- `/feedback good|bad|note <text>` — tell the GM what it got right or wrong (feeds into the learning loop)

## Architecture

```
Cloudflare Worker (Hono)
  |
  |-- D1 (SQLite) ---- player IDs, projections, decisions, stats cache, retrospectives
  |-- KV ------------- Yahoo OAuth tokens, weekly add budget, news alert dedup
  |-- Cron triggers -- daily analysis, news monitoring, weekly matchup/trade reviews
  |-- Telegram ------- webhook for commands + outbound notifications
  |-- Yahoo API ------ read-only roster, matchup, league, and transaction data
  |-- OpenRouter ----- LLM analysis (Claude, GPT, etc.)
  |-- FanGraphs ------ ROS projections (Steamer + ZiPS blend)
  |-- MLB Stats API -- schedule, game data, Statcast
  |-- Odds API ------- Vegas lines for run environment context
```

Everything runs on Cloudflare's free tier.

## Setup

### Prerequisites

You'll need accounts/keys for the following services:

| Service                                                  | What it's used for                       | How to get it                                                            |
| -------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| [Cloudflare](https://dash.cloudflare.com/sign-up)        | Hosting (Workers, D1 database, KV store) | Sign up for free                                                         |
| [Yahoo Developer](https://developer.yahoo.com/apps/)     | Accessing your fantasy league data       | Create an app, select "Fantasy Sports" API, use `oob` as redirect URI    |
| [Telegram Bot](https://core.telegram.org/bots#botfather) | Receiving recommendations                | Message [@BotFather](https://t.me/botfather) on Telegram, send `/newbot` |
| [OpenRouter](https://openrouter.ai/)                     | LLM API access                           | Sign up, add credits, copy API key                                       |

You'll also need [Node.js](https://nodejs.org/) v20+ and [pnpm](https://pnpm.io/).

### 1. Clone and install

```sh
git clone https://github.com/ikusner13/yahoo-fantasy-baseball.git
cd yahoo-fantasy-baseball
pnpm install
```

### 2. Configure your league

Edit the `vars` section in `wrangler.jsonc` with your league details:

```jsonc
"vars": {
  "YAHOO_LEAGUE_ID": "your-league-id",
  "YAHOO_TEAM_ID": "your-team-number",
  "TELEGRAM_CHAT_ID": "your-telegram-chat-id"
}
```

**Finding these values:**

- **Yahoo League ID** — go to your league on Yahoo Fantasy, the URL looks like `https://baseball.fantasysports.yahoo.com/b2/62744` — the number at the end is your league ID
- **Yahoo Team ID** — click on your team, the URL looks like `.../62744/12` — the last number is your team ID
- **Telegram Chat ID** — message [@userinfobot](https://t.me/userinfobot) on Telegram, it replies with your chat ID

### 3. Create Cloudflare resources

```sh
npx wrangler login
npx wrangler d1 create fantasy-baseball
npx wrangler kv namespace create KV
```

Each command outputs an ID. Update `wrangler.jsonc` with them:

- `d1_databases[0].database_id` — from `d1 create`
- `kv_namespaces[0].id` — from `kv namespace create`

If you have multiple Cloudflare accounts, set `CLOUDFLARE_ACCOUNT_ID` in a `.env` file.

### 4. Set up the database

```sh
pnpm db:generate          # generate migration SQL from Drizzle schema
pnpm db:migrate:local     # test locally
pnpm db:migrate:remote    # apply to production D1
```

### 5. Set secrets

These are sensitive values that get encrypted on Cloudflare's side. Pipe values with `echo -n` to avoid trailing newline issues:

```sh
echo -n "your-yahoo-client-id"     | npx wrangler secret put YAHOO_CLIENT_ID
echo -n "your-yahoo-client-secret" | npx wrangler secret put YAHOO_CLIENT_SECRET
echo -n "your-telegram-bot-token"  | npx wrangler secret put TELEGRAM_BOT_TOKEN
echo -n "your-openrouter-api-key"  | npx wrangler secret put OPENROUTER_API_KEY
```

Optional (for direct API access instead of OpenRouter, or for Vegas odds):

```sh
echo -n "your-value" | npx wrangler secret put ANTHROPIC_API_KEY
echo -n "your-value" | npx wrangler secret put OPENAI_API_KEY
echo -n "your-value" | npx wrangler secret put ODDS_API_KEY
```

### 6. Deploy

```sh
npx wrangler deploy
```

### 7. Post-deploy setup

**Connect Telegram** — point your bot's webhook to the worker (replace `<TOKEN>` and `<subdomain>`):

```sh
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://fantasy-baseball.<subdomain>.workers.dev/telegram"
```

**Connect Yahoo** — visit this URL in your browser to complete the OAuth flow:

```
https://fantasy-baseball.<subdomain>.workers.dev/auth
```

Your `<subdomain>` is your Cloudflare account name (visible in the deploy output).

### 8. Verify

```sh
curl https://fantasy-baseball.<subdomain>.workers.dev/health
```

Then send `/status` to your Telegram bot — it should reply **"GM is online"**.

To watch live logs:

```sh
npx wrangler tail
```

## Local Development

Create a `.env` file with your secrets for local use:

```
YAHOO_CLIENT_ID=...
YAHOO_CLIENT_SECRET=...
TELEGRAM_BOT_TOKEN=...
OPENROUTER_API_KEY=...
```

```sh
pnpm dev                  # starts wrangler dev server at localhost:8787
```

- `http://localhost:8787/health` — health check
- `http://localhost:8787/auth` — Yahoo OAuth flow
- `http://localhost:8787/test` — read-only test suite

Simulate a cron trigger locally:

```sh
curl "http://localhost:8787/__scheduled?cron=0+13+*+*+*"
```

## Project Structure

```
src/
  worker.tsx            # Cloudflare Worker entry point (Hono routes + scheduled handler)
  cron.ts               # Cron pattern dispatcher
  gm.ts                 # Game manager — orchestrates all analysis tasks
  types.ts              # Core TypeScript interfaces
  test-harness.ts       # Read-only test suite
  db/schema.ts          # Drizzle ORM table definitions (D1/SQLite)
  config/tuning.ts      # Tuning parameters
  ai/                   # LLM integration, prompts, data formatting
  analysis/             # Lineup, waivers, trades, streaming, matchup, IL, etc.
  data/                 # External data: projections, Statcast, MLB, Vegas, player IDs
  monitors/             # News alert monitoring
  notifications/        # Telegram webhook handler + outbound messages
  yahoo/                # Yahoo Fantasy API client + OAuth2
```

## Scripts

| Script                   | Description                     |
| ------------------------ | ------------------------------- |
| `pnpm dev`               | Local dev server (wrangler dev) |
| `npx wrangler deploy`    | Deploy to Cloudflare            |
| `pnpm typecheck`         | TypeScript type checking        |
| `pnpm test`              | Run tests                       |
| `pnpm db:generate`       | Generate Drizzle migrations     |
| `pnpm db:migrate:local`  | Apply migrations locally        |
| `pnpm db:migrate:remote` | Apply migrations to production  |

## Tech Stack

- [Cloudflare Workers](https://developers.cloudflare.com/workers/) — serverless compute
- [Cloudflare D1](https://developers.cloudflare.com/d1/) — SQLite at the edge
- [Cloudflare KV](https://developers.cloudflare.com/kv/) — key-value store
- [Hono](https://hono.dev/) — web framework
- [Drizzle ORM](https://orm.drizzle.team/) — type-safe SQL
- [OpenRouter](https://openrouter.ai/) — LLM gateway
- TypeScript
