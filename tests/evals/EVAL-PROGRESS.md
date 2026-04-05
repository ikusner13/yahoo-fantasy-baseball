# LLM Eval Progress

## Goal
Find the optimal model + prompt per touchpoint for performance/cost. All 5 LLM touchpoints in the fantasy baseball GM are supplemental commentary — the stats engine makes decisions, the LLM explains them.

## Framework
- **Evalite** (Vitest-based, `.eval.ts` files)
- **OpenRouter** for multi-model testing (single API key, OpenAI-compatible)
- **GPT-5.4 Mini** as LLM judge (upgraded from Nano which was too harsh)
- Temperature 0.3, max_tokens 512 for all models
- Keyword synonym matching for flexible scoring

## Current Best Scores (v2 tuning, April 5 2026)

| Touchpoint | Model | Prompt Style | Score | Cost/MTok (in/out) |
|---|---|---|---|---|
| **Lineup Summary** | Qwen 3.5 Flash | directive/rules | **99%** | $0.07/$0.26 |
| **Waiver Wire** | Qwen 3.5 Flash | rules-v2 | **93%** | $0.07/$0.26 |
| **Matchup Strategy** | DeepSeek V3 | XML structured | **95%** | $0.20/$0.77 |
| **Matchup Strategy** | Qwen 3.5 Flash | rules priorities | **95%** | $0.07/$0.26 |
| **Trade Proposal** | DeepSeek V3 | friend-msg | **94%** | $0.20/$0.77 |
| **Injury Assessment** | Llama 3.3 70B | anti-preamble | **94%** | $0.10/$0.32 |

## Score Progression

### Waiver Wire
- v0 (Sonnet, current prompt): 73%
- v1 (Sonnet, decision-only): 84%
- v1 (Qwen 3.5, decision-only): 83%
- v2 (Qwen 3.5, rules-v2): **93%** (+20pts from baseline)

### Matchup Strategy
- v0 (Sonnet, current prompt): 65%
- v1 (Sonnet, priorities): 85%
- v2 (DeepSeek V3, XML): **95%** (+30pts from baseline)
- v2 (Qwen 3.5, rules): **95%**

### Injury Assessment
- v0 (Sonnet, full-assessment): 65%
- v1 (Haiku, decision-tree): 84%
- v2 (Llama 3.3, anti-preamble): **94%** (+29pts from baseline)

### Trade Proposal
- v0 (Sonnet, friend-msg): 75%
- v1 (DeepSeek V3, friend-msg): 90%
- v2 (DeepSeek V3, friend-msg): **94%** (+19pts from baseline)

### Lineup Summary
- v0 (Sonnet, current): 83%
- v1 (GPT-5.4 Mini, current): 92%
- v1 (Qwen 3.5, directive): **99%** (+16pts from baseline)

## Models Tested (11 total)

### Eliminated
| Model | Reason | Best Score |
|---|---|---|
| GPT-5 Nano | Too weak, errors on most tasks | 33-49% |
| Mistral Small 3.1 | Borderline, inconsistent | 58-82% |
| Gemma 3 27B | Invalid model ID on OpenRouter | N/A |

### Competitive but not best
| Model | Strongest Touchpoint | Score |
|---|---|---|
| GPT-5.4 Mini ($0.75) | Waiver Wire | 92% |
| GPT-4.1 Nano ($0.10) | Waiver Wire | 83% |
| Claude Haiku 4.5 ($1.00) | Injury Assessment | 84% |
| Gemini 2.5 Flash ($0.30) | Matchup | 78% |
| Claude Sonnet 4.6 ($3.00) | Matchup | 85% |

### Winners
| Model | Best For | Score |
|---|---|---|
| **Qwen 3.5 Flash** ($0.07) | Lineup (99%), Waiver (93%), Matchup (95%) | Cheapest, best rules-following |
| **DeepSeek V3** ($0.20) | Matchup (95%), Trade (94%) | Best natural tone, XML structure |
| **Llama 3.3 70B** ($0.10) | Injury (94%), Matchup (93%) | Best with anti-verbosity prompts |

## Winning Prompts (copy into prod)

### Lineup Summary → Qwen 3.5 Flash
```
System: RULES: (1) Plain text only (2) Max 2 sentences (3) Name key starters (4) Explain benchings
```

### Waiver Wire → Qwen 3.5 Flash
```
System: RULES: (1) 2-3 sentences only (2) Plain text, no markdown (3) Start with YES or NO (4) Name categories that improve (5) Address priority cost. Categories: R, H, HR, RBI, SB, TB, OBP | Outs, K, ERA, WHIP, QS, SV+HLD
```

### Matchup Strategy → Qwen 3.5 Flash or DeepSeek V3
Qwen:
```
System: RULES: (1) Output exactly 3 numbered priorities (2) Each must name specific categories (3) Plain text only (4) No markdown, headers, or bullets beyond the numbers. H2H league categories: R, H, HR, RBI, SB, TB, OBP | Outs, K, ERA, WHIP, QS, SV+HLD
```
DeepSeek (XML):
```
System:
<role>H2H fantasy baseball strategist</role>
<categories>R, H, HR, RBI, SB, TB, OBP | Outs, K, ERA, WHIP, QS, SV+HLD</categories>
<output_rules>
- Plain text, no markdown
- Exactly 3 numbered priorities
- Each priority must name specific categories
- No preamble or summary
</output_rules>
```

### Trade Proposal → DeepSeek V3
```
System: You are a fantasy baseball trade negotiator. Craft a fair but favorable trade proposal. The message should sound natural, not robotic — you're sending this to a friend in a league. Categories: R, H, HR, RBI, SB, TB, OBP | Outs, K, ERA, WHIP, QS, SV+HLD.
```

### Injury Assessment → Llama 3.3 70B
```
System: Fantasy baseball injury analyst. Output a decision: HOLD, IL_STASH, DROP, or REPLACE. Then explain in 1-2 sentences. No preamble. No markdown. Plain text only. Categories: R, H, HR, RBI, SB, TB, OBP | Outs, K, ERA, WHIP, QS, SV+HLD.
```

## Key Prompting Insights by Model

### Qwen 3.5 Flash
- RULES-based numbered constraints work best
- Always provide a system prompt (loops without one)
- "Plain text only" must be explicit
- Cheapest model that competes with premium

### DeepSeek V3
- XML structure (`<role>`, `<constraints>`) works well for structured tasks
- Generic "friend message" prompt naturally produces good casual tone
- Over-constraining hurts it — keep creative tasks open
- Defaults to heavy markdown, must explicitly suppress
- Temperature 0.0-0.3 for analytical tasks

### Llama 3.3 70B
- Must include "No preamble. No summary. No markdown." explicitly
- Few-shot examples can actually hurt on simple tasks
- Strongest anti-verbosity discipline when properly instructed
- 92% IFEval — excellent instruction following when constraints are clear

### GPT-5.4 Mini
- Front-load critical constraints (put format rules FIRST in system prompt)
- More literal than older models — no contradictions in prompts
- Good but expensive ($0.75) vs Qwen at $0.07

## Estimated Prod Cost (optimal config)
- Qwen for 3 touchpoints (~12 calls/week): ~$0.001/week
- DeepSeek for 1 touchpoint (~1 call/week): ~$0.0002/week
- Llama for 1 touchpoint (~varies): ~$0.0001/week
- **Season total: ~$0.03** (down from ~$2 with Sonnet)

## Next Steps
1. Wire winning model+prompt combos into `src/ai/llm.ts` and `src/ai/prompts.ts`
2. Add OpenRouter as primary provider in prod, claude CLI as fallback
3. Consider per-model temperature tuning in prod
4. Run evals periodically as models update to catch regressions
5. Could try Qwen 3.5 for trade proposals (currently DeepSeek) — natural tone might be worth testing

## Eval Files
- `tests/evals/helpers.ts` — OpenRouter call, scorers, judge
- `tests/evals/waiver-wire.eval.ts` — 11 models × 3 prompts × 4 scenarios
- `tests/evals/lineup-summary.eval.ts` — 11 models × 2 prompts × 3 scenarios
- `tests/evals/matchup-strategy.eval.ts` — 11 models × 2 prompts × 3 scenarios
- `tests/evals/trade-proposal.eval.ts` — 11 models × 2 prompts × 2 scenarios
- `tests/evals/injury-assessment.eval.ts` — 11 models × 2 prompts × 4 scenarios
- `tests/evals/prompt-tuning.eval.ts` — model-specific prompt variants round 1
- `tests/evals/prompt-tuning-v2.eval.ts` — model-specific prompt variants round 2
- `evalite.config.ts` — 120s timeout, max 3 concurrent

## Running Evals
```bash
# Single touchpoint
npx evalite run tests/evals/waiver-wire.eval.ts

# All evals
npx evalite run

# With UI
npx evalite serve

# Requires OPENROUTER_API_KEY in .env
```
