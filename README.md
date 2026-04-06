# Fantasy Baseball GM

AI-powered assistant for Yahoo Fantasy Baseball. Runs on Cloudflare Workers with D1 (SQLite), KV, and cron triggers. Analyzes your matchup, optimizes lineups, scouts the waiver wire, evaluates trades, and sends recommendations to Telegram.

## What It Does

- **Daily lineup optimization** — sets your lineup based on projections, matchups, park factors, splits, and recent performance
- **Waiver wire scouting** — finds pickups, manages weekly add budget, identifies streamers
- **Trade evaluation** — proposes and evaluates trades with approval flow via Telegram
- **Matchup analysis** — weekly opponent scouting, category targeting, punt strategies
- **IL management** — monitors injury news, suggests IL stashes and activations
- **News monitoring** — polls for player news every 30 min, deduplicates alerts
- **Retrospectives** — weekly review of decisions and outcomes for self-improvement

All analysis is powered by LLMs (via OpenRouter) combined with projection data from FanGraphs, Statcast metrics, Vegas lines, and MLB schedule data.

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

### Cron Schedule (UTC)

| Schedule           | Task                             |
| ------------------ | -------------------------------- |
| `0 13 * * *`       | Daily morning analysis + lineup  |
| `0 22 * * *`       | Late scratch check               |
| `0 14 * * 1`       | Monday matchup analysis          |
| `0 19 * * 3`       | Wednesday mid-week adjustment    |
| `0 14 * * 5`       | Friday two-start pitcher preview |
| `0 14 * * 6`       | Saturday trade evaluation        |
| `0 14 * * SUN`     | Sunday tactics                   |
| `*/30 13-23 * * *` | News monitoring                  |

### Telegram Commands

| Command                            | Description                    |
| ---------------------------------- | ------------------------------ |
| `/status`                          | Health check                   |
| `/feedback good\|bad\|note <text>` | Log feedback for learning loop |

Trade proposals are sent with inline approve/reject buttons.

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v20+)
- [pnpm](https://pnpm.io/)
- A [Cloudflare](https://cloudflare.com) account
- A [Yahoo Developer](https://developer.yahoo.com/) app (OAuth2 credentials)
- A [Telegram Bot](https://core.telegram.org/bots#botfather) token
- An [OpenRouter](https://openrouter.ai/) API key

### 1. Clone and install

```sh
git clone https://github.com/ikusner13/yahoo-fantasy-baseball.git
cd yahoo-fantasy-baseball
pnpm install
```

### 2. Configure Cloudflare resources

Log in to Cloudflare:

```sh
npx wrangler login
```

Create the D1 database and KV namespace:

```sh
npx wrangler d1 create fantasy-baseball
npx wrangler kv namespace create KV
```

Update `wrangler.jsonc` with the IDs from the output:

- `d1_databases[0].database_id` -- from `d1 create`
- `kv_namespaces[0].id` -- from `kv namespace create`

If you have multiple Cloudflare accounts, set `CLOUDFLARE_ACCOUNT_ID` in your `.env`.

### 3. Generate and apply database migrations

```sh
pnpm db:generate          # generate migration SQL from Drizzle schema
pnpm db:migrate:local     # test locally
pnpm db:migrate:remote    # apply to production D1
```

### 4. Set secrets

Pipe values to avoid trailing newlines:

```sh
echo -n "your-value" | npx wrangler secret put YAHOO_CLIENT_ID
echo -n "your-value" | npx wrangler secret put YAHOO_CLIENT_SECRET
echo -n "your-value" | npx wrangler secret put TELEGRAM_BOT_TOKEN
echo -n "your-value" | npx wrangler secret put OPENROUTER_API_KEY
```

Optional:

```sh
echo -n "your-value" | npx wrangler secret put ANTHROPIC_API_KEY
echo -n "your-value" | npx wrangler secret put OPENAI_API_KEY
echo -n "your-value" | npx wrangler secret put ODDS_API_KEY
```

### 5. Configure your league

Edit the `vars` section in `wrangler.jsonc`:

```jsonc
"vars": {
  "YAHOO_LEAGUE_ID": "your-league-id",
  "YAHOO_TEAM_ID": "your-team-number",
  "TELEGRAM_CHAT_ID": "your-telegram-chat-id"
}
```

### 6. Local development

Create a `.env` file for local secrets:

```
YAHOO_CLIENT_ID=...
YAHOO_CLIENT_SECRET=...
TELEGRAM_BOT_TOKEN=...
OPENROUTER_API_KEY=...
```

```sh
pnpm dev                  # starts wrangler dev server at localhost:8787
```

- `http://localhost:8787/health` -- health check
- `http://localhost:8787/auth` -- start Yahoo OAuth flow
- `http://localhost:8787/test` -- run read-only test suite

Simulate a cron trigger:

```sh
curl "http://localhost:8787/__scheduled?cron=0+13+*+*+*"
```

### 7. Deploy

```sh
npx wrangler deploy
```

### 8. Post-deploy setup

Set the Telegram webhook:

```sh
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://fantasy-baseball.<subdomain>.workers.dev/telegram"
```

Authenticate with Yahoo by visiting:

```
https://fantasy-baseball.<subdomain>.workers.dev/auth
```

### 9. Verify

```sh
# health check
curl https://fantasy-baseball.<subdomain>.workers.dev/health

# tail live logs
npx wrangler tail

# trigger a test run
curl https://fantasy-baseball.<subdomain>.workers.dev/test
```

Send `/status` to your Telegram bot -- it should reply "GM is online".

## Project Structure

```
src/
  worker.tsx            # Cloudflare Worker entry point (Hono routes + scheduled handler)
  cron.ts               # Cron pattern dispatcher
  gm.ts                 # Game manager -- orchestrates all analysis tasks
  types.ts              # Core TypeScript interfaces
  test-harness.ts       # Read-only test suite
  simulation.ts         # Simulation utilities
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

- [Cloudflare Workers](https://developers.cloudflare.com/workers/) -- compute
- [Cloudflare D1](https://developers.cloudflare.com/d1/) -- SQLite database
- [Cloudflare KV](https://developers.cloudflare.com/kv/) -- key-value store
- [Hono](https://hono.dev/) -- web framework
- [Drizzle ORM](https://orm.drizzle.team/) -- type-safe SQL
- [OpenRouter](https://openrouter.ai/) -- LLM gateway
- TypeScript
