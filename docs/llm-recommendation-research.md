# LLM Recommendation Research Notes

This app uses LLMs as a constrained layer around the stats engine, not as the forecasting engine itself.

## Why the new implementation uses AI SDK Core

- The AI SDK's structured output flow (`generateText` + `Output.object`) gives provider-agnostic schema validation for extraction and review tasks.
- The AI SDK agent docs recommend using core functions directly when the workflow is a controlled single-step classification/review path rather than an open-ended tool loop.
- The OpenRouter AI SDK provider supports provider-specific options such as the `response-healing` plugin, which is useful for non-streaming structured outputs.

That maps well to this app's needs:

- structured news extraction
- borderline waiver review
- typed weekly reflection tags

All three are deterministic, schema-shaped workflows. They do not need a free-running multi-step agent.

## Practical design choices

- News extraction is limited to high-impact alert types (`closer_change`, `callup`, `injury`, `trade`) and falls back to deterministic heuristics when LLMs are unavailable.
- Waiver review only runs on borderline recommendations, so the LLM acts as a context-sensitive veto layer instead of replacing the ranking engine.
- Reflections now store typed miss tags and tuning ideas in JSON so future prompts can reuse repeat patterns instead of re-reading opaque prose.

## Sources

- AI SDK structured outputs: https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
- AI SDK overview and agent guidance: https://ai-sdk.dev/docs/agents/overview
- OpenRouter AI SDK provider: https://github.com/OpenRouterTeam/ai-sdk-provider
- Existing baseball model audit: [algorithm-research-audit.md](/Users/ikusner/dev/fantasy-baseball/docs/algorithm-research-audit.md:1)
