# windsurf-openai-proxy

One zero-dep, **OpenAI-compatible** proxy (also speaks Ollama and llama.cpp) — use your Windsurf/Cognition/Devin subscription models (Claude, GPT, Gemini, Kimi, SWE) in **Zed, Cline or any editor**, with cost tiers, power ranks and multi-key access built in.

The main point of this proxy isn't just bridging the protocol — it's **giving you instant clarity on what to use right now**. Windsurf has 200+ models with hidden credit costs, shifting promo windows, and wildly varying capability. This proxy decorates every model name with its **power rank, fat coefficient (ж) and cost tier** (`Kimi K3 High ★76 ж11.6 $`, `SWE-2 High ★50 ж∞ free`), pins top picks on top, and comes with a `recommend` command that highlights the real freebies, best-value models, and overpriced traps at a glance.

Based on [pi-windsurf](https://github.com/ktappdev/pi-windsurf) (originally a Pi extension), reworked into a pure proxy.

![windsurf-openai-proxy — Windsurf models in Zed's model picker](screenshot.png)

## Why

A Windsurf subscription gives you access to Claude, GPT, Gemini, Kimi, SWE, GLM and more — but only inside Windsurf's own IDE. Two problems with that: first, you might just prefer a different editor. Second — as of October 2026 they straight-up broke their own IDE for regular users with a botched team migration (a "team" error on launch, fix timeline unknown).

**Practical advice (October 2026):** a Pro subscription is worth it if used strategically — SWE-2 covers routine work for free, GLM-5.3 Flash / GPT-6 Luna give the best quota-per-intelligence ratio, and Gemini Flash is the safe buy once you're into Extra-Usage. (March 2026+: the weekly quota bills per-token $/1M, not per-prompt credits — context size is what you watch.) Full details in [RECOMMENDATIONS](RECOMMENDATIONS.md) ([смотри рекомендации по русски](RECOMMENDATIONS_RU.md)).

- **No Windsurf IDE needed** — OAuth once, then it's just a localhost HTTP service
- **Zero dependencies** — plain Node/tsx, no npm packages
- **Live model list** — fetched from Windsurf itself (`GetUserStatus`), not a hardcoded table; new models appear automatically
- **Cost tiers in the names** — Windsurf publishes no pricing, but its API leaks real $/1M token prices and promo windows; the proxy surfaces them as `$`/`$$`/`$$$`/`promo`/`free` right in the model list, so you know what each request costs under the token-priced quota
- **Power rankings** — each model gets a `★NN` badge (Artificial Analysis index via OpenRouter's public API; SWE models are hand-estimated, override via `ranks.json`)
- **Fat coefficient (ж)** — real OpenRouter compute per $1 of subscription at full quota burn (Pro ≈ ×14.5 ÷ WS markup). ж ≥ 10 → burn freely; ж < 1 → OpenRouter direct beats the subscription
- **`recommend` command** — one-shot digest: what's free right now, best value, best power-per-credit, and what's overpriced
- **Zed native** — works with Zed's built-in `llama.cpp` provider: model list auto-populates with context windows, featured models pinned on top

There are alternatives ([WindsurfAPI](https://github.com/dwgx/WindsurfAPI), `windsurf2api` variants, etc.) — I tried them and none quite fit: some bundle a heavy runtime, some hardcode stale model lists, most skip Zed's auto-discovery entirely, and none show what each model costs. This one stays small, dependency-free, and honest about pricing.

## How it works

```
Zed → proxy (localhost:42100, OpenAI API) → Windsurf cloud (Connect-RPC)
```

The proxy translates standard OpenAI Chat Completions to Windsurf's proprietary Connect-RPC API — the same one the Windsurf IDE speaks.

## Quick start

```bash
npx tsx cli.ts login     # browser OAuth → credentials saved to ~/.config/opencode-windsurf-auth/
npx tsx cli.ts serve     # proxy on http://127.0.0.1:42100/v1
```

(Or `bun cli.ts …` / `npm run serve`. Plain Node does not work — extensionless imports.)

## Zed setup

Use the **llama.cpp provider** (settings key: `"llama.cpp"`, URL has no `/v1` — the provider appends `/v1/models` itself):

```json
{
  "language_models": {
    "llama.cpp": {
      "api_url": "http://127.0.0.1:42100"
    }
  }
}
```

Restart Zed — the model list appears automatically: a few **featured models pinned on top** (edit `FEATURED_UIDS` in `featured.ts` to taste), then promo/free, then `$` → `$$` → `$$$`, with per-model context windows. No API key needed on localhost.

Other editors: point any OpenAI-compatible client at `http://127.0.0.1:42100/v1` (auth: Bearer key from `cli.ts status` for non-localhost clients).

### Cline / other Ollama clients

The proxy also speaks **Ollama's native protocol**: `GET /api/tags` for the model list, `POST /api/chat` for chat (NDJSON streaming, tool calls supported) and `POST /api/show` for capabilities/context (what Zed's `ollama` provider probes per model). Point any Ollama client at it:

- **Cline** → API Provider: *Ollama*, base URL `http://<host>:42100` (or `http://<host>:42100/key:<key>` for a per-key model list)
- **Zed** → the `ollama` provider works too: `"ollama": { "api_url": "http://127.0.0.1:42100" }`

Same key rules as everywhere else: localhost needs no key, remote clients use the path prefix (Ollama clients don't send auth headers).

### Remote access

With `--host 0.0.0.0` you can serve friends/teammates over the network. Put Bearer keys in `keys.json` next to the CLI (see `keys.json.example`):

```json
{
  "my-secret-key": { "name": "me",           "max_price": -1 },
  "vasya-key":     { "name": "friend-vasya", "max_price": 1.0 }
}
```

`max_price` limits which models that key can list and call: `-1` or missing = unlimited, `0` = free/promo only, `N` = models whose Windsurf input price ($/1M) is ≤ N. Free/promo models always pass. At startup the proxy logs each key's name with its visible model count.

Clients can authenticate in three ways:
1. Header: `Authorization: Bearer <key>` (standard OpenAI clients).
2. Path prefix: `http://<host>:42100/key:<key>` (recommended for Zed's `llama.cpp` provider, e.g. `"api_url": "http://server:42100/key:friend-key"`).
3. Query param: `http://<host>:42100?key=<key>`.

## CLI

| Command | Does |
|---------|------|
| `serve` | Start the proxy (`--port`, `--host`) |
| `login` / `logout` | Browser OAuth / remove credentials |
| `status` | Show saved credentials |
| `models` | List models with cost tiers (`--zed` → ready-to-paste JSON) |
| `recommend` | What to use right now — freebies, value picks, power picks (`--all` → full table) |
| `speeds` | Refresh the TPS snapshot from OpenRouter model pages (slow one-time crawl) |
| `probe` | Dump Windsurf's raw per-model credits + prices |

## Cost tiers

Windsurf exposes no public pricing. Tiers come from its own `GetUserStatus` data: **credits per prompt** and **promo windows** (the plugin's "PROMO" badge). Since March 2026 the quota bills per-token $/1M — the `$/$$/$$$` tier is derived from the real blended price, not the legacy credits.

| Tier | Meaning |
|---|---|
| `free` | 0-quota promo as marketed by Windsurf (the SWE line) — real freebie while the window lasts |
| `promo` | discounted window — very cheap, but still token-priced |
| `$` / `$$` / `$$$` | ≲$1 / ≲$4 / >$4 blended $/1M |
| `unknown` | no pricing data (new models — override via `tiers.json`) |

The `★NN` badge after the name is the model's power score — Artificial Analysis coding/intelligence index fetched from OpenRouter's public models API at startup (12h cache). Models not on OpenRouter (Cognition-internal SWE) get hand-estimated scores. Override or add via `ranks.json` next to the CLI.

The `жN` badge is the **fat coefficient**: real OpenRouter compute per $1 of subscription at full quota burn (Pro ≈ ×14.5 issuance ÷ WS markup). ж ≥ 10 → burn freely; ж < 1 → paying OpenRouter directly beats the subscription. Requires OpenRouter reachable at startup; missing when OR is unreachable or the model isn't mapped.

```json
{ "claude-opus-5-5-max": 59, "some-brand-new-model": 45 }
```

Override any tier via `tiers.json` next to the CLI (value `"blocked"` hides a model entirely).

## Behind a proxy

Outbound requests to Windsurf honor the standard `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` env vars:

- **Bun** — works out of the box (`HTTPS_PROXY=http://proxy:3128 bun cli.ts serve`)
- **Node 24+** — `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://proxy:3128 npx tsx cli.ts serve`
- **Older Node** — fetch ignores proxy env vars; run through Bun, or upgrade Node

## Security

Localhost clients are trusted without a key. With `--host 0.0.0.0`, chat requests from remote clients must send `Authorization: Bearer <key>` — either a `keys.json` key or the stored Windsurf apiKey (`cli.ts status` prints it). The model list itself — names and tiers only — stays readable without a key. Credentials stored mode 0600. Never commit API keys.

## Requirements

- tsx (`npx tsx`) or Bun — no npm dependencies
- Windsurf account (free or paid)

## Credits

Reverse-engineering by [opencode-windsurf-auth](https://github.com/rsvedant/opencode-windsurf-auth) (@rsvedant); proxy architecture from [pi-windsurf](https://github.com/ktappdev/pi-windsurf) by @ktappdev. Standalone proxy rework by @ploginoff.

## License

MIT
