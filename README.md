# Fantasy Baseball GM

An autonomous AI general manager for Yahoo Fantasy Baseball. It monitors your league 24/7, sets optimal lineups, scouts the waiver wire, evaluates trades, tracks injuries, and sends you actionable recommendations via Telegram — all running serverlessly on Cloudflare Workers.

Built for a **head-to-head categories** league where every category result counts in the season standings. The product goal is not just to win a week as a binary matchup; it is to maximize cumulative category wins and ties across the season. See [docs/league-model.md](docs/league-model.md) for the league rules and rewrite assumptions.

## How It Works

The GM runs as a Cloudflare Worker with scheduled cron triggers. Each trigger fires a specific analysis task that reads your roster, evaluates the situation, consults an LLM, and sends you a Telegram message with what it found and what it recommends.

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

## League Model

This app is being rewritten around the observed Yahoo league model:

- 12-team H2H categories.
- Standings are cumulative category results, not weekly matchup wins.
- Each weekly matchup contributes up to 13 category outcomes to the season record.
- Scoring categories are `R`, `H`, `HR`, `RBI`, `SB`, `TB`, `OBP`, `OUT`, `K`, `ERA`, `WHIP`, `QS`, and `SV+H`.
- `H/AB` and `IP` can appear in Yahoo tables but are not scoring categories; `IP` still matters for the 20 IP weekly minimum.
- The league has a 6-add weekly limit, rolling waiver priority, and 4 IL slots.

The app should optimize for marginal category points. Turning a `4-9` week into `5-8` matters because that extra category win directly improves the standings record.

Current rewrite priorities:

- Treat empty roster spots as urgent category-volume leaks.
- Use real Yahoo state for weekly adds used and waiver priority.
- Support add-only recommendations when roster space exists.
- Separate free-agent adds, waiver claims, add/drops, lineup moves, IL moves, and trades.
- Weight decisions by category state, games remaining, probable starts, and ratio risk.

### Telegram Integration

The GM sends all recommendations to Telegram. For trades, it sends messages with inline **Approve / Reject** buttons so you stay in control of roster-altering moves.

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
  |-- Yahoo API ------ roster, lineup, waiver, trade operations
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

You'll also need [Node.js](https://nodejs.org/) v20+ and [Vite Plus](https://github.com/voidzero-dev/vite-plus).

### 1. Clone and install

```sh
git clone https://github.com/ikusner13/yahoo-fantasy-baseball.git
cd yahoo-fantasy-baseball
vp i
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
vpx wrangler login
vpx wrangler d1 create fantasy-baseball
vpx wrangler kv namespace create KV
```

Each command outputs an ID. Update `wrangler.jsonc` with them:

- `d1_databases[0].database_id` — from `d1 create`
- `kv_namespaces[0].id` — from `kv namespace create`

If you have multiple Cloudflare accounts, set `CLOUDFLARE_ACCOUNT_ID` in a `.env` file.

### 4. Set up the database

```sh
vpr db:generate          # generate migration SQL from Drizzle schema
vpr db:migrate:local     # test locally
vpr db:migrate:remote    # apply to production D1
```

### 5. Set secrets

These are sensitive values that get encrypted on Cloudflare's side. Pipe values with `echo -n` to avoid trailing newline issues:

```sh
echo -n "your-yahoo-client-id"     | vpx wrangler secret put YAHOO_CLIENT_ID
echo -n "your-yahoo-client-secret" | vpx wrangler secret put YAHOO_CLIENT_SECRET
echo -n "your-telegram-bot-token"  | vpx wrangler secret put TELEGRAM_BOT_TOKEN
echo -n "your-openrouter-api-key"  | vpx wrangler secret put OPENROUTER_API_KEY
```

Optional (for direct API access instead of OpenRouter, or for Vegas odds):

```sh
echo -n "your-value" | vpx wrangler secret put ANTHROPIC_API_KEY
echo -n "your-value" | vpx wrangler secret put OPENAI_API_KEY
echo -n "your-value" | vpx wrangler secret put ODDS_API_KEY
```

### 6. Deploy

```sh
vpx wrangler deploy
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
vpx wrangler tail
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
vpr dev                  # starts wrangler dev server at localhost:8787
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

| Script                  | Description                     |
| ----------------------- | ------------------------------- |
| `vpr dev`               | Local dev server (wrangler dev) |
| `vpx wrangler deploy`   | Deploy to Cloudflare            |
| `vpr typecheck`         | TypeScript type checking        |
| `vpr test`              | Run tests                       |
| `vpr db:generate`       | Generate Drizzle migrations     |
| `vpr db:migrate:local`  | Apply migrations locally        |
| `vpr db:migrate:remote` | Apply migrations to production  |

## Tech Stack

- [Cloudflare Workers](https://developers.cloudflare.com/workers/) — serverless compute
- [Cloudflare D1](https://developers.cloudflare.com/d1/) — SQLite at the edge
- [Cloudflare KV](https://developers.cloudflare.com/kv/) — key-value store
- [Hono](https://hono.dev/) — web framework
- [Drizzle ORM](https://orm.drizzle.team/) — type-safe SQL
- [OpenRouter](https://openrouter.ai/) — LLM gateway
- TypeScript
