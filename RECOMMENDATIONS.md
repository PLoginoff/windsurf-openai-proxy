# Windsurf model recommendations

> Practical advice for a Windsurf Pro subscription (October 2026), followed by the full model table.
> Regenerate the table with `npx tsx cli.ts recommend --all --md`; refresh TPS with `npx tsx cli.ts speeds`.

> **⚠ March 2026 change:** Windsurf replaced per-prompt **credits** with a **token-priced quota** (a single 7-day window; the "daily quota exhausted" error text refers to the same window). The `creditsPerPrompt` field in GetUserStatus is legacy — what actually burns your quota is the `$/1M tokens` price (f32 pricing below). A "1 credit" model isn't one prompt anymore — it's however many tokens the request uses. Pro gets roughly **$50**/week of API tokens.

## What to actually use

**TL;DR:** SWE-2 for free work, GLM-5.3 Flash / GPT-6 Luna for cheap routine, GLM-5.3 Max when you need frontier-level intelligence at ~$2.6/1M, and only buy Claude/GPT in Extra-Usage — at market price.

1. **Free Workhorse (`SWE-2 High ★50 free`):**
   - Costs **0 quota** while the promo window lasts (free models don't count against quota at all).
   - Best for routine edits, refactoring, exploring directories, running tools, and small bugs. Don't burn your weekly allowance on simple tasks.
2. **Cheap-but-smart (`GLM-5.3 Flash Max $`, `GPT-6 Luna $`, `Claude Haiku 5.5 $`):**
   - **DeepSeek V4 Flash** ~**$0.20/1M** blended — the cheapest model on the platform.
   - **Claude Haiku 5.5** ~**$0.26/1M** — nearly free, and it's a Claude (150tps).
   - **GPT-6 Luna** ~**$0.26/1M** — a solid second pick at the same price.
   - **GLM-5.3 Flash** ~**$0.29/1M** — the best quota-per-intelligence ratio in the GLM family. Fast and capable enough for most Zoo/Cline work.
   - **Kimi K2.7** ~**$2.2/1M** blended — mid-price, strong reasoning.
3. **Frontier intelligence (`GLM-5.3 Max ★75 $$` & friends):**
   - **GLM-5.3 Max** ~**$2.6/1M** blended — top-tier ★75 intelligence but noticeably pricier than Flash. Good for genuinely hard problems, overkill for routine tool loops.
   - **Claude Opus/Sonnet**, **GPT-5.4** — $5-15/1M blended. Worth it only for architectural work; save your weekly quota.
4. **Extra Usage Beyond the Weekly Quota (paying in real $):**
   - **Safe to buy in Windsurf:** Western frontier models (**Claude Opus/Sonnet 5.5**, **GPT-5.4**, **Gemini 3.8 Flash**) have zero markup in Extra-Usage — prices match OpenRouter and official APIs 1:1 (e.g. Claude Opus 5.5 is $4/$20 per 1M tokens either way).
   - **Do NOT buy via Windsurf Extra-Usage:** Chinese open models like **GLM-5.3**, **GLM-5.2**, or **Kimi K3**. Windsurf charges an **~18x markup on input tokens** ($1.40/1M vs $0.08/1M on OpenRouter). If your weekly quota runs out, switch to OpenRouter directly for these models!
   - **Exception:** **GLM-5.3 Flash** — its Windsurf price ($0.15/$0.5) carries a ~2.5-3x markup over OpenRouter ($0.05/$0.2), but it's absolutely cheap. A fast fallback when you're out of quota.
   - **Exception:** **Gemini 3.7/3.8 Flash** — WS $0.75/$3.75: exactly OpenRouter's price on 3.7, and *below* OR on 3.8 ($0.83/$4.13), at ★76 intelligence. The best value model to buy in Extra-Usage when the promo window is over.

## How to stretch the weekly quota

Windsurf meters **tokens**, not prompts — so the lever is context size, not request count:

- **Watch your context.** A 1M-token conversation burns quota ~30× faster than a 30k one. In agentic tools (Zed, Zoo/Cline), each tool round-trip re-sends the full system prompt + history — reset the chat when it gets long instead of letting it pile up.
- **Stick to one model.** Cache reads are ~5× cheaper than fresh input ($0.26 vs $1.4 on GLM-5.3 Max). Bouncing between models throws away the cache and re-bills the whole context.
- **Retries hurt twice.** A failed tool call that retries the full prompt is two quota hits — fix the root cause (e.g. a broken MCP config) instead of letting the agent loop.
- **Short prompts.** `@`-mention only the files the model actually needs; a 20k input is ~4× cheaper than 80k on the same model.

Run `npx tsx cli.ts recommend` anytime to get the live picture for your account.

## Current favorites (October 2026)

> **The deal:** Pro (~$15/mo) grants ~$50/week of quota ≈ **$217/mo of internal currency** — ×14.5 on your money, *if you burn it all*. WS also marks up per-model prices vs OpenRouter, so **ж** folds both into one number: **real OpenRouter compute per $1 of subscription at full quota burn** = ×14.5 ÷ markup.

Selected by ЖИР (value inside the quota) — models where the weekly budget buys the most real compute:

| Model | Rank¹ | WS $/1M in/out | WS÷OR | ж² | Why it's here |
| --- | --- | --- | --- | --- | --- |
| **SWE-2 High** | ★50 | — | — | **∞** | Free (promo → Nov 1). The routine workhorse — burns zero quota |
| **Gemini 4 Argon** | AA 53 | 1/5 | **×0.5**⁴ | **ж29**⁴ | New flagship — WS price is *half* of OpenRouter. Purest ЖИР — stock up |
| **Gemini 3.8 Flash** | ★76 | 0.75/3.75 | ×0.9 | **ж16** | Promo → Jan 2027. ★76 at a price *below* OpenRouter |
| **Claude Haiku 5.5** | AA 43, #3/172³ | 0.10/0.50 | ×1.0 | ж14.5 | Claude for pennies, 150 t/s — try it |
| **GPT-6 Luna** | AA 38, #9/172³ | 0.10/0.50 | ×1.0⁴ | ж14.5⁴ | Fast cheap OpenAI — try it (hidden by the proxy as Devin Local — re-enable via tiers.json) |
| **Claude Sonnet 5.5** | AA 56 | 2/10 | ×1.0 | ж14.5 | Mainline workhorse at market price |
| **Claude Opus 5.5** | AA 58 | 4/20 | ×1.0 | ж14.5 | Flagship for the hard stuff — this is what the subscription is for |
| **GPT-5.4** | ★71 | 2.5/15 | ×1.0 | ж14.5 | Frontier at market price |
| **GPT-6 Astra** | ★77 | 10/50 | ×1.0⁴ | ж14.5⁴ | Top intelligence, pricey but honest (hidden by the proxy as Devin Local — re-enable via tiers.json) |
| **Grok 4.5 Low** | ★72 | 2/6 | ×1.0 | ж14.5 | Strong mid at market price |
| **Claude Sonnet 4.6** | ★63 | 3/15 | ×1.0 | ж14.5 | Proven agent model |
| **Kimi K2.7** | ★61 | 0.95/4 | ×1.25 | ж11.6 | Open-weight reasoner |
| **DeepSeek V4 Flash** | ★69 | 0.14/0.28 | ×1.3 | ж11 | Cheapest absolute blended ($0.20) |
| **GLM-5.3 Flash** | ★72 | 0.15/0.50 | ×2.7 | ж5.4 | Cheap smart fallback while quota lasts |
| ⚠️ **GLM-5.3 Max** | ★75 | 1.40/4.40 (cache 0.26) | **×18 fresh / ×3 cache** | **ж0.8–ж4.4** | NOT ЖИР: fresh-input ж0.8 < 1 — paying OpenRouter directly beats the subscription; cache reads lift it to ж4.4. Hard tasks only, short context, stay on-model for cache |

¹ ★ = OR/AA coding index (same scale as the full table). "AA" = Artificial Analysis Intelligence Index — a different scale; for calibration: Sonnet 5.5 = 56, Opus 5.5 = 58, GLM-5.3 Max = 45. ² **ж** (fat coefficient) = real OpenRouter compute per $1 of subscription at full quota burn = (quota ≈$217/mo ÷ $15/mo) × (OR price ÷ WS price) ≈ ×14.5 ÷ markup. ³ Haiku 5.5 and GPT-6 Luna have no published coding index on OR; class rank is from artificialanalysis.ai (172 models in their price tier). ⁴ Hand estimates: Gemini 4 Argon, GPT-6 Luna and GPT-6 Astra are missing from the proxy's OR mapping — live `recommend` shows "?" for them; Luna/Astra are additionally hidden as Devin Local-only (a tiers.json entry brings them back).

**Decision rule by ж:** **ж ≥ 10** → fat — burn freely, every subscription dollar buys ≥$10 of real OpenRouter compute. **1 ≤ ж < 10** → still beats paying OpenRouter directly, but each quota dollar buys only ж÷14.5 of what it would on an honest-price model — burn surplus quota only. **ж < 1** → the subscription LOSES to paying OpenRouter directly (GLM-5.3 Max fresh input: ж0.8) — never burn scarce quota there. Live per-model ж: `npx tsx cli.ts recommend` (needs OpenRouter reachable).

**Rule of thumb:** burn the quota on Claude/GPT/Gemini/Grok (×1.0 — full subsidy). Chinese open-weights via WS only as Flash-class fallbacks; once the quota is out, switch them to OpenRouter directly — WS Extra-Usage on GLM Max means paying the ×18 markup in real money.

## All models

> Snapshot for plan **Pro**, 204 models, generated 2026-10-18.
> Regenerate: `npx tsx cli.ts recommend --all --md`.
> **March 2026:** per-prompt credits are gone — quota bills tokens. "Cost/1M" is the real driver.

| Tier | Score | Cost/1M | WS $/1M in/out | OR $/1M in/out | Age | TPS | Model |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 🟢 FREE | 50 | 0 | - | - | fresh | 100 | SWE-2 High |
| 🟢 FREE | 50 | 0 | - | - | fresh | 100 | SWE-2 Medium |
| 🟢 FREE | 50 | 0 | - | - | fresh | 100 | SWE-2 Max |
| 🟢 FREE | ? | 0 | 1/5 | - | - | 100 | SWE-2 Medium Lightning |
| 🟢 FREE | ? | 0 | 1/5 | - | - | 100 | SWE-2 High Lightning |
| 🟢 FREE | ? | 0 | 1/5 | - | - | 100 | SWE-2 Max Lightning |
| 🟢 PROMO | ? | 1.95 | 0.75/3.75 | - | - | 77 | Gemini 3.8 Flash Medium |
| 🟢 PROMO | ? | 1.95 | 0.75/3.75 | - | - | 77 | Gemini 3.7 Flash Low |
| 🟢 PROMO | ? | 1.95 | 0.75/3.75 | - | - | 77 | Gemini 3.7 Flash Medium |
| 🟢 PROMO | ? | 1.95 | 0.75/3.75 | - | - | 77 | Gemini 3.7 Flash High |
| 🟢 PROMO | ? | 1.95 | 0.75/3.75 | - | - | 77 | Gemini 3.8 Flash Low |
| 🟢 PROMO | ? | 1.95 | 0.75/3.75 | - | - | 77 | Gemini 3.8 Flash High |
| 🟡 | ? | 2.6 | 1/5 | - | - | - | Gemini 4 Argon Medium |
| 🟡 | ? | 2.6 | 1/5 | - | - | - | Gemini 4 Argon Low |
| 🟡 | ? | 2.6 | 1/5 | - | - | - | Gemini 4 Argon High |
|  | 42 | 1.3 | 0.5/2.5 | - | aging | 100 | SWE-1.7 Max |
|  | 42 | 1.3 | 0.5/2.5 | - | aging | 100 | SWE-1.7 Medium |
| 🔴 | 39 | 6.5 | 2.5/12.5 | - | aging | 100 | SWE-1.7 Lightning Max |
| 🔴 | 39 | 6.5 | 2.5/12.5 | - | aging | 100 | SWE-1.7 Lightning Medium |
|  | 33 | 1.3 | 0.5/2.5 | - | aging | 100 | SWE-1.6 |
|  | 33 | 1.3 | 0.5/2.5 | - | aging | 100 | SWE-1.6 Fast |
|  | ? | 0.2 | 0.14/0.28 | - | - | 54 | DeepSeek V4 Flash High |
|  | ? | 0.2 | 0.14/0.28 | - | - | 54 | DeepSeek V4 Flash Max |
|  | ? | 0.26 | 0.1/0.5 | - | - | 150 | Claude Haiku 5.5 Low |
|  | ? | 0.26 | 0.1/0.5 | - | - | 150 | Claude Haiku 5.5 Medium |
|  | ? | 0.26 | 0.1/0.5 | - | - | 150 | Claude Haiku 5.5 High |
|  | ? | 0.26 | 0.1/0.5 | - | - | 150 | Claude Haiku 5.5 XHigh |
|  | ? | 0.26 | 0.1/0.5 | - | - | 150 | Claude Haiku 5.5 Max |
| 🟢 | ? | 0.29 | 0.15/0.5 | - | - | 67 | GLM-5.3 Flash Low |
| 🟢 | ? | 0.29 | 0.15/0.5 | - | - | 67 | GLM-5.3 Flash High |
| 🟢 | ? | 0.29 | 0.15/0.5 | - | - | 67 | GLM-5.3 Flash Max |
|  | ? | 0.38 | 0.3/0.5 | - | - | 54 | xAI Grok-3 mini Thinking |
|  | ? | 0.4 | 0.22/0.66 | - | - | 87 | DeepSeek V4.1 Flash High |
|  | ? | 0.4 | 0.22/0.66 | - | - | 87 | DeepSeek V4.1 Flash Max |
|  | ? | 0.72 | 0.2/1.5 | - | - | - | Grok Code Fast 1 |
|  | ? | 1.32 | 0.6/2.4 | - | - | 59 | Nemotron 3 Ultra None |
|  | ? | 1.32 | 0.6/2.4 | - | - | 59 | Nemotron 3 Ultra Medium |
|  | ? | 1.32 | 0.6/2.4 | - | - | 59 | Nemotron 3 Ultra High |
|  | ? | 1.5 | 0.5/3 | - | - | 77 | Gemini 3 Flash Minimal |
|  | ? | 1.5 | 0.5/3 | - | - | 77 | Gemini 3 Flash Low |
|  | ? | 1.5 | 0.5/3 | - | - | 77 | Gemini 3 Flash Medium |
|  | ? | 1.5 | 0.5/3 | - | - | 77 | Gemini 3 Flash High |
|  | ? | 2.17 | 0.95/4 | - | - | 35 | Kimi K2.6 |
|  | ? | 2.17 | 0.95/4 | - | - | 39 | Kimi K2.7 |
| 🟡 | ? | 2.25 | 0.75/4.5 | - | - | 83 | GPT-5.4 Mini Low Thinking |
| 🟡 | ? | 2.25 | 0.75/4.5 | - | - | 83 | GPT-5.4 Mini Medium Thinking |
| 🟡 | ? | 2.25 | 0.75/4.5 | - | - | 83 | GPT-5.4 Mini High Thinking |
| 🟡 | ? | 2.25 | 0.75/4.5 | - | - | 83 | GPT-5.4 Mini XHigh Thinking |
|  | ? | 2.38 | 1.32/3.96 | - | - | 42 | DeepSeek V4 Pro High |
|  | ? | 2.38 | 1.32/3.96 | - | - | 42 | DeepSeek V4 Pro Max |
|  | ? | 2.6 | 1/5 | - | - | - | Claude Haiku 4.5 |
|  | ? | 2.6 | 1.4/4.4 | - | - | 66 | GLM-5.2 High |
| 🟢 | ? | 2.6 | 1.4/4.4 | - | - | 85 | GLM-5.3 Low |
| 🟢 | ? | 2.6 | 1.4/4.4 | - | - | 85 | GLM-5.3 High |
| 🟢 | ? | 2.6 | 1.4/4.4 | - | - | 85 | GLM-5.3 Max |
|  | ? | 2.6 | 1.4/4.4 | - | - | 66 | GLM-5.2 Max |
|  | ? | 2.6 | 1.4/4.4 | - | - | 66 | GLM-5.2 High 1M |
|  | ? | 2.6 | 1.4/4.4 | - | - | 66 | GLM-5.2 Max 1M |
|  | ? | 2.6 | 1.4/4.4 | - | - | 66 | GLM-5.2 No Thinking |
|  | ? | 2.6 | 1.4/4.4 | - | - | 66 | GLM-5.2 No Thinking 1M |
|  | ? | 3.6 | 2/6 | - | - | 54 | Grok 4.5 Low |
|  | ? | 3.6 | 2/6 | - | - | 54 | Grok 4.5 Medium |
|  | ? | 3.6 | 2/6 | - | - | 54 | Grok 4.5 High |
| 🟡 | ? | 3.6 | 2/6 | - | - | 55 | Grok 4.6 Low |
| 🟡 | ? | 3.6 | 2/6 | - | - | 55 | Grok 4.6 Medium |
| 🟡 | ? | 3.6 | 2/6 | - | - | 55 | Grok 4.6 High |
| 🟡 | ? | 3.6 | 2/6 | - | - | 55 | Grok 4.6 XHigh |
|  | ? | 3.6 | 2/6 | - | - | 62 | Grok 4.7 Low |
|  | ? | 3.6 | 2/6 | - | - | 62 | Grok 4.7 Medium |
|  | ? | 3.6 | 2/6 | - | - | 62 | Grok 4.7 High |
|  | ? | 3.6 | 2/6 | - | - | 62 | Grok 4.7 XHigh |
|  | ? | 3.9 | 1.5/7.5 | - | - | 128 | Gemini 3.6 Flash Minimal |
|  | ? | 3.9 | 1.5/7.5 | - | - | 128 | Gemini 3.6 Flash Low |
|  | ? | 3.9 | 1.5/7.5 | - | - | 128 | Gemini 3.6 Flash Medium |
|  | ? | 3.9 | 1.5/7.5 | - | - | 128 | Gemini 3.6 Flash High |
| 🔴 | ? | 4.4 | 2/8 | - | - | 80 | GPT-4.1 |
| 🔴 | ? | 4.4 | 2/8 | - | - | 40 | o3 |
| 🔴 | ? | 4.4 | 2/8 | - | - | 40 | o3 High Reasoning |
| 🔴 | ? | 4.5 | 1.5/9 | - | - | 128 | Gemini 3.5 Flash Minimal |
| 🔴 | ? | 4.5 | 1.5/9 | - | - | 128 | Gemini 3.5 Flash Low |
| 🔴 | ? | 4.5 | 1.5/9 | - | - | 128 | Gemini 3.5 Flash Medium |
| 🔴 | ? | 4.5 | 1.5/9 | - | - | 128 | Gemini 3.5 Flash High |
| 🔴 | ? | 4.75 | 1.25/10 | - | - | - | GPT-5 Low Thinking |
| 🔴 | ? | 4.75 | 1.25/10 | - | - | 75 | Gemini 2.5 Pro |
| 🔴 | ? | 4.75 | 1.25/10 | - | - | - | GPT-5 Medium Thinking |
| 🔴 | ? | 4.75 | 1.25/10 | - | - | - | GPT-5 High Thinking |
| 🔴 | ? | 4.75 | 1.25/10 | - | - | - | GPT-5.1 No Thinking |
| 🔴 | ? | 4.75 | 1.25/10 | - | - | - | GPT-5.1 Low Thinking |
| 🔴 | ? | 4.75 | 1.25/10 | - | - | - | GPT-5.1 Medium Thinking |
| 🔴 | ? | 4.75 | 1.25/10 | - | - | - | GPT-5.1 High Thinking |
| 🔴 | ? | 5.2 | 2/10 | - | - | 94 | Claude Sonnet 5.5 Medium |
| 🔴 | ? | 5.2 | 2/10 | - | - | 71 | Claude Sonnet 5 Low |
| 🔴 | ? | 5.2 | 2/10 | - | - | 71 | Claude Sonnet 5 Medium |
| 🔴 | ? | 5.2 | 2/10 | - | - | 71 | Claude Sonnet 5 High |
| 🔴 | ? | 5.2 | 2/10 | - | - | 71 | Claude Sonnet 5 XHigh |
| 🔴 | ? | 5.2 | 2/10 | - | - | 71 | Claude Sonnet 5 Max |
| 🔴 | ? | 5.2 | 2/10 | - | - | 94 | Claude Sonnet 5.5 Low |
| 🔴 | ? | 5.2 | 2/10 | - | - | 94 | Claude Sonnet 5.5 High |
| 🔴 | ? | 5.2 | 2/10 | - | - | 94 | Claude Sonnet 5.5 XHigh |
| 🔴 | ? | 5.2 | 2/10 | - | - | 94 | Claude Sonnet 5.5 Max |
| 🔴 | ? | 5.5 | 2.5/10 | - | - | 60 | GPT-4o |
| 🔴 | ? | 6 | 2/12 | - | - | 76 | Gemini 3.1 Pro Low Thinking |
| 🔴 | ? | 6 | 2/12 | - | - | 76 | Gemini 3.1 Pro High Thinking |
| 🔴 | ? | 6.65 | 1.75/14 | - | - | 50 | GPT-5.2 Low Thinking |
| 🔴 | ? | 6.65 | 1.75/14 | - | - | 50 | GPT-5.2 Medium Thinking |
| 🔴 | ? | 6.65 | 1.75/14 | - | - | 50 | GPT-5.2 No Thinking |
| 🔴 | ? | 6.65 | 1.75/14 | - | - | 50 | GPT-5.2 High Thinking |
| 🔴 | ? | 6.65 | 1.75/14 | - | - | 50 | GPT-5.2 XHigh Thinking |
| 🔴 | ? | 6.65 | 1.75/14 | - | - | 51 | GPT-5.3-Codex Low |
| 🔴 | ? | 6.65 | 1.75/14 | - | - | 51 | GPT-5.3-Codex Medium |
| 🔴 | ? | 6.65 | 1.75/14 | - | - | 51 | GPT-5.3-Codex High |
| 🔴 | ? | 6.65 | 1.75/14 | - | - | 51 | GPT-5.3-Codex X-High |
| 🔴 | ? | 7.5 | 2.5/15 | - | - | 55 | GPT-5.4 No Thinking |
| 🔴 | ? | 7.5 | 2.5/15 | - | - | 55 | GPT-5.4 Low Thinking |
| 🔴 | ? | 7.5 | 2.5/15 | - | - | 55 | GPT-5.4 Medium Thinking |
| 🔴 | ? | 7.5 | 2.5/15 | - | - | 55 | GPT-5.4 High Thinking |
| 🔴 | ? | 7.5 | 2.5/15 | - | - | 55 | GPT-5.4 XHigh Thinking |
| 🟢 | ? | 7.8 | 3/15 | - | - | 49 | Kimi K3 High |
| 🟢 | ? | 7.8 | 3/15 | - | - | 49 | Kimi K3 Low |
| 🟢 | ? | 7.8 | 3/15 | - | - | 49 | Kimi K3 Max |
| 🔴 | ? | 7.8 | 3/15 | - | - | 45 | Claude Sonnet 4.6 |
| 🔴 | ? | 7.8 | 3/15 | - | - | 45 | Claude Sonnet 4.6 Thinking |
| 🔴 | ? | 7.8 | 3/15 | - | - | 45 | Claude Sonnet 4.6 1M |
| 🔴 | ? | 7.8 | 3/15 | - | - | 45 | Claude Sonnet 4.6 Thinking 1M |
| 🔴 | ? | 7.8 | 3/15 | - | - | 54 | xAI Grok-3 |
| 🔴 | ? | 9.5 | 2.5/20 | - | - | - | GPT-5.1 No Thinking Fast |
| 🔴 | ? | 9.5 | 2.5/20 | - | - | - | GPT-5.1 Low Thinking Fast |
| 🔴 | ? | 9.5 | 2.5/20 | - | - | - | GPT-5.1 Medium Thinking Fast |
| 🔴 | ? | 9.5 | 2.5/20 | - | - | - | GPT-5.1 High Thinking Fast |
| 🔴 | ? | 10.4 | 4/20 | - | - | 76 | Claude Opus 5.5 Medium |
| 🔴 | ? | 10.4 | 4/20 | - | - | 76 | Claude Opus 5.5 Low |
| 🔴 | ? | 10.4 | 4/20 | - | - | 76 | Claude Opus 5.5 High |
| 🔴 | ? | 10.4 | 4/20 | - | - | 76 | Claude Opus 5.5 XHigh |
| 🔴 | ? | 10.4 | 4/20 | - | - | 76 | Claude Opus 5.5 Max |
| 🔴 | ? | 13 | 5/25 | - | - | 56 | Claude Opus 4.7 Medium |
| 🔴 | ? | 13 | 5/25 | - | - | 56 | Claude Opus 4.7 Low |
| 🔴 | ? | 13 | 5/25 | - | - | 56 | Claude Opus 4.7 High |
| 🔴 | ? | 13 | 5/25 | - | - | 56 | Claude Opus 4.7 XHigh |
| 🔴 | ? | 13 | 5/25 | - | - | 56 | Claude Opus 4.7 Max |
| 🔴 | ? | 13 | 5/25 | - | - | 76 | Claude Opus 4.8 Medium |
| 🔴 | ? | 13 | 5/25 | - | - | 76 | Claude Opus 4.8 Low |
| 🔴 | ? | 13 | 5/25 | - | - | 76 | Claude Opus 4.8 High |
| 🔴 | ? | 13 | 5/25 | - | - | 76 | Claude Opus 4.8 XHigh |
| 🔴 | ? | 13 | 5/25 | - | - | 76 | Claude Opus 4.8 Max |
| 🔴 | ? | 13 | 5/25 | - | - | 70 | Claude Opus 5 Medium |
| 🔴 | ? | 13 | 5/25 | - | - | 70 | Claude Opus 5 Low |
| 🔴 | ? | 13 | 5/25 | - | - | 70 | Claude Opus 5 High |
| 🔴 | ? | 13 | 5/25 | - | - | 70 | Claude Opus 5 XHigh |
| 🔴 | ? | 13 | 5/25 | - | - | 70 | Claude Opus 5 Max |
| 🔴 | ? | 13 | 5/25 | - | - | 40 | Claude Opus 4.6 |
| 🔴 | ? | 13 | 5/25 | - | - | 40 | Claude Opus 4.6 Thinking |
| 🔴 | ? | 13 | 5/25 | - | - | 40 | Claude Opus 4.6 1M |
| 🔴 | ? | 13 | 5/25 | - | - | 40 | Claude Opus 4.6 Thinking 1M |
| 🔴 | ? | 13 | 5/25 | - | - | 47 | Claude Opus 4.5 |
| 🔴 | ? | 13 | 5/25 | - | - | 47 | Claude Opus 4.5 Thinking |
| 🔴 | ? | 13.3 | 3.5/28 | - | - | 50 | GPT-5.2 Low Thinking Fast |
| 🔴 | ? | 13.3 | 3.5/28 | - | - | 50 | GPT-5.2 Medium Thinking Fast |
| 🔴 | ? | 13.3 | 3.5/28 | - | - | 50 | GPT-5.2 No Thinking Fast |
| 🔴 | ? | 13.3 | 3.5/28 | - | - | 50 | GPT-5.2 High Thinking Fast |
| 🔴 | ? | 13.3 | 3.5/28 | - | - | 50 | GPT-5.2 XHigh Thinking Fast |
| 🔴 | ? | 13.3 | 3.5/28 | - | - | 51 | GPT-5.3-Codex Low Fast |
| 🔴 | ? | 13.3 | 3.5/28 | - | - | 51 | GPT-5.3-Codex Medium Fast |
| 🔴 | ? | 13.3 | 3.5/28 | - | - | 51 | GPT-5.3-Codex High Fast |
| 🔴 | ? | 13.3 | 3.5/28 | - | - | 51 | GPT-5.3-Codex XHigh Fast |
| 🔴 | ? | 15 | 5/30 | - | - | 57 | GPT-5.5 No Thinking |
| 🔴 | ? | 15 | 5/30 | - | - | 57 | GPT-5.5 Low Thinking |
| 🔴 | ? | 15 | 5/30 | - | - | 57 | GPT-5.5 Medium Thinking |
| 🔴 | ? | 15 | 5/30 | - | - | 57 | GPT-5.5 High Thinking |
| 🔴 | ? | 15 | 5/30 | - | - | 57 | GPT-5.5 XHigh Thinking |
| 🔴 | ? | 15 | 5/30 | - | - | 55 | GPT-5.4 No Thinking Fast |
| 🔴 | ? | 15 | 5/30 | - | - | 55 | GPT-5.4 Low Thinking Fast |
| 🔴 | ? | 15 | 5/30 | - | - | 55 | GPT-5.4 Medium Thinking Fast |
| 🔴 | ? | 15 | 5/30 | - | - | 55 | GPT-5.4 High Thinking Fast |
| 🔴 | ? | 15 | 5/30 | - | - | 55 | GPT-5.4 XHigh Thinking Fast |
| 🔴 | ? | 20.8 | 8/40 | - | - | 76 | Claude Opus 5.5 Low Fast |
| 🔴 | ? | 20.8 | 8/40 | - | - | 76 | Claude Opus 5.5 Medium Fast |
| 🔴 | ? | 20.8 | 8/40 | - | - | 76 | Claude Opus 5.5 High Fast |
| 🔴 | ? | 20.8 | 8/40 | - | - | 76 | Claude Opus 5.5 XHigh Fast |
| 🔴 | ? | 20.8 | 8/40 | - | - | 76 | Claude Opus 5.5 Max Fast |
| 🔴 | ? | 26 | 10/50 | - | - | 50 | Claude Fable 5.1 Medium |
| 🔴 | ? | 26 | 10/50 | - | - | 76 | Claude Opus 4.8 Low Fast |
| 🔴 | ? | 26 | 10/50 | - | - | 76 | Claude Opus 4.8 Medium Fast |
| 🔴 | ? | 26 | 10/50 | - | - | 76 | Claude Opus 4.8 High Fast |
| 🔴 | ? | 26 | 10/50 | - | - | 76 | Claude Opus 4.8 XHigh Fast |
| 🔴 | ? | 26 | 10/50 | - | - | 76 | Claude Opus 4.8 Max Fast |
| 🔴 | ? | 26 | 10/50 | - | - | 70 | Claude Opus 5 Low Fast |
| 🔴 | ? | 26 | 10/50 | - | - | 70 | Claude Opus 5 Medium Fast |
| 🔴 | ? | 26 | 10/50 | - | - | 70 | Claude Opus 5 High Fast |
| 🔴 | ? | 26 | 10/50 | - | - | 70 | Claude Opus 5 XHigh Fast |
| 🔴 | ? | 26 | 10/50 | - | - | 70 | Claude Opus 5 Max Fast |
| 🔴 | ? | 26 | 10/50 | - | - | 50 | Claude Fable 5 Low |
| 🔴 | ? | 26 | 10/50 | - | - | 50 | Claude Fable 5 Medium |
| 🔴 | ? | 26 | 10/50 | - | - | 50 | Claude Fable 5 High |
| 🔴 | ? | 26 | 10/50 | - | - | 50 | Claude Fable 5 XHigh |
| 🔴 | ? | 26 | 10/50 | - | - | 50 | Claude Fable 5 Max |
| 🔴 | ? | 26 | 10/50 | - | - | 50 | Claude Fable 5.1 Low |
| 🔴 | ? | 26 | 10/50 | - | - | 50 | Claude Fable 5.1 High |
| 🔴 | ? | 26 | 10/50 | - | - | 50 | Claude Fable 5.1 XHigh |
| 🔴 | ? | 26 | 10/50 | - | - | 50 | Claude Fable 5.1 Max |
| 🔴 | ? | 37.5 | 12.5/75 | - | - | 57 | GPT-5.5 No Thinking Fast |
| 🔴 | ? | 37.5 | 12.5/75 | - | - | 57 | GPT-5.5 Low Thinking Fast |
| 🔴 | ? | 37.5 | 12.5/75 | - | - | 57 | GPT-5.5 Medium Thinking Fast |
| 🔴 | ? | 37.5 | 12.5/75 | - | - | 57 | GPT-5.5 High Thinking Fast |
| 🔴 | ? | 37.5 | 12.5/75 | - | - | 57 | GPT-5.5 XHigh Thinking Fast |

**Cost/1M** — blended 0.6·input + 0.4·output $/1M; what the quota actually bills per token volume.  
**Markers** — 🟢 free/promo or grab-it family (GLM-5.3, Kimi K3), 🟡 powerful at a fair price (score ≥70 or hand-picked families), 🔴 >$4/1M blended (money pit).  
**Score** — Artificial Analysis coding/intelligence index via OpenRouter (0-100).  
**FREE** — quota-free promo as marketed by Windsurf (SWE). **PROMO** — discounted window, still token-priced.  
**WS $/1M** — Windsurf extra-usage prices; **OR $/1M** — OpenRouter reference. SWE scores are estimates.  
**Age** — release date from OpenRouter: new <1mo, fresh <6mo, aging <18mo, old ≥18mo.  
**TPS** — median output tokens/sec across OpenRouter providers (speeds.json snapshot).

