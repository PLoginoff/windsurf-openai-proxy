/**
 * windsurf-openai-proxy — standalone OpenAI-compatible proxy for Windsurf/Cognition.
 *
 * Usage:
 *   npx tsx cli.ts serve [--port 42100] [--host 127.0.0.1]
 *   npx tsx cli.ts login
 *   npx tsx cli.ts status
 *   npx tsx cli.ts logout
 *   npx tsx cli.ts models
 *
 * The proxy speaks OpenAI Chat Completions at http://<host>:<port>/v1 and
 * Ollama-native /api/tags + /api/chat (Zed llama.cpp/ollama providers, Cline).
 * Localhost clients need no key; remote clients (--host 0.0.0.0) send a
 * Bearer key from keys.json, or the Windsurf apiKey (printed by `status`).
 *
 * Point Zed's llama.cpp provider at http://127.0.0.1:42100 (no /v1),
 * or any OpenAI-compatible client at http://127.0.0.1:42100/v1.
 */
import { startProxy, stopProxy, buildModelList } from "./proxy";
import {
  loadCredentials, saveCredentials, deleteCredentials,
  DEFAULT_REGION, runLoginLoopback, registerUser,
  type PersistedCredentials,
} from "./oauth";
import { clearCachedUserJwt } from "./auth";
import { clearSessionIds, streamChatEvents } from "./chat";
import { getUserStatus, getCachedUserStatus, isPromoActive, isActuallyFreePromo, clearCachedUserStatus } from "./status";
import { isBlockedModel, blendedPricePer1M } from "./costs";
import { FEATURED_UIDS, GREEN_FAMILIES, YELLOW_FAMILIES } from "./featured";
import { baseUid } from "./ranks";
import { powerScore, getOrCatalog, lookupOrInfo, speedClass, speedInfo, collectSpeeds, manualCreated } from "./ranks";
import { keyCount, getKeys, priceLimit } from "./keys";
import { clearCachedCatalog } from "./catalog";

const DEFAULT_PORT = 42100;
const DEFAULT_HOST = "127.0.0.1";

function parseArgs(argv: string[]): { command: string; port: number; host: string; zed: boolean; all: boolean; md: boolean } {
  let command = "serve";
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let zed = false;
  let all = false;
  let md = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") { port = parseInt(argv[++i] ?? "", 10) || DEFAULT_PORT; }
    else if (a.startsWith("--port=")) { port = parseInt(a.slice("--port=".length), 10) || DEFAULT_PORT; }
    else if (a === "--host" || a === "--bind") { host = argv[++i] ?? DEFAULT_HOST; }
    else if (a.startsWith("--host=") || a.startsWith("--bind=")) { host = a.slice(a.indexOf("=") + 1); }
    else if (a === "--zed") { zed = true; }
    else if (a === "--all") { all = true; }
    else if (a === "--md") { md = true; }
    else if (!a.startsWith("--")) { command = a; }
  }
  return { command, port, host, zed, all, md };
}

async function cmdServe(port: number, host: string): Promise<void> {
  const stored = loadCredentials();
  if (stored) {
    console.error(`[windsurf] authenticated as ${stored.name} (${stored.apiServerUrl})`);
    // Warm the live model list (GetUserStatus) so /v1/models reflects the account.
    getUserStatus(stored.apiKey, stored.apiServerUrl).then((s) => {
      const available = [...s.models.values()].filter(m => !m.disabled && !isBlockedModel(m.uid)).length;
      console.log(`[windsurf] plan: ${s.planName ?? "?"}, ${available} models available (${s.models.size} from Windsurf, ${s.models.size - available} hidden)`);
    }).catch(() => {});
    // Warm OpenRouter benchmarks in the background — used by `recommend`.
    getOrCatalog().then((or) => {
      if (or) console.log(`[windsurf] OpenRouter rankings loaded: ${or.byId.size} models`);
      else console.log("[windsurf] OpenRouter unreachable — `recommend` will show no scores");
    }).catch(() => {});
  } else {
    console.error("[windsurf] not authenticated — run: windsurf-openai-proxy login");
  }

  const actualPort = await startProxy(port, host);
  console.error(`[windsurf] proxy listening on http://${host}:${actualPort}/v1`);
  console.error(`[windsurf] models endpoint:  http://${host}:${actualPort}/v1/models`);
  console.error(`[windsurf] chat endpoint:   http://${host}:${actualPort}/v1/chat/completions`);
  console.error(`[windsurf] ollama endpoint:  http://${host}:${actualPort}/api/tags (+/api/chat, /api/show)`);

  const nKeys = keyCount();
  if (nKeys > 0 && stored) {
    console.error(`[windsurf] access keys: ${nKeys} configured in keys.json`);
    // Single status fetch — the model list is already warmed above (or will
    // come from the same in-flight request). Count per key from that, not from
    // buildModelList() per key — each call re-fires getUserStatus and stalls.
    const status = await getUserStatus(stored.apiKey, stored.apiServerUrl).catch(() => null);
    if (status) {
      const usable = [...status.models.values()].filter(m => !m.disabled && !isBlockedModel(m.uid));
      for (const [key, policy] of getKeys()) {
        const name = policy.name ?? key;
        const limit = priceLimit(policy);
        const visible = limit !== undefined
          ? usable.filter(m => isActuallyFreePromo(m) || (m.pricing?.input ?? 0) <= limit).length
          : usable.length;
        const label = limit !== undefined ? `≤$${limit}/1M` : "unlimited";
        console.error(`[windsurf]   "${name}" → ${visible} models (${label})`);
      }
    }
  } else if (nKeys > 0) {
    console.error("[windsurf] keys.json present but not logged in — run: windsurf-openai-proxy login");
  } else {
    console.error("[windsurf] access: localhost only (no keys.json — full local access)");
  }

  if (stored) {
    console.error(`[windsurf] proxy auth:     Windsurf apiKey accepted for remote clients (Bearer ${stored.apiKey.slice(0, 12)}…)`);
  } else {
    console.error("[windsurf] chat will return 503 until you log in (windsurf-openai-proxy login)");
  }
  console.error("[windsurf] press Ctrl+C to stop");

  const shutdown = (): void => {
    console.error("\n[windsurf] shutting down…");
    stopProxy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdLogin(): Promise<void> {
  console.error("[windsurf] opening browser to sign in…");
  let token: string = "";
  try {
    token = await runLoginLoopback(DEFAULT_REGION, (url) => {
      console.error(`[windsurf] if a browser didn't open, visit:\n  ${url}`);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[windsurf] login failed: ${msg}`);
    process.exit(1);
  }

  const result = await registerUser(token, DEFAULT_REGION);
  const creds: PersistedCredentials = {
    ...result,
    issuedAt: new Date().toISOString(),
    oauthClientId: DEFAULT_REGION.oauthClientId,
  };
  saveCredentials(creds);
  clearCachedUserJwt();
  clearSessionIds();
  clearCachedCatalog();
  clearCachedUserStatus();
  console.error(`[windsurf] signed in as ${result.name}`);
  console.error(`[windsurf] api_key: ${result.apiKey}`);
  console.error(`[windsurf] server:  ${result.apiServerUrl}`);
  console.error("[windsurf] now run: windsurf-openai-proxy serve");
}

function cmdStatus(): void {
  const c = loadCredentials();
  if (!c) {
    console.error("[windsurf] not signed in. Run: windsurf-openai-proxy login");
    return;
  }
  console.log(`name:         ${c.name}`);
  console.log(`apiServerUrl: ${c.apiServerUrl}`);
  console.log(`apiKey:       ${c.apiKey}`);
  console.log(`issuedAt:     ${c.issuedAt}`);
}

function cmdLogout(): void {
  const ok = deleteCredentials();
  clearCachedUserJwt();
  clearSessionIds();
  clearCachedCatalog();
  clearCachedUserStatus();
  console.error(ok ? "[windsurf] signed out." : "[windsurf] already signed out.");
}

async function cmdModels(zed: boolean): Promise<void> {
  const items = await buildModelList();

  if (zed) {
    // Ready-to-paste JSON for Zed's openai_compatible available_models.
    // `name` is what gets sent as the request model — the pretty id (with tier),
    // which the proxy resolves back to the canonical id.
    const arr = items.map(m => ({
      name: m.id,
      display_name: m.name,
      max_tokens: m.contextWindow ?? 128000,
    }));
    console.log(JSON.stringify(arr, null, 2));
    return;
  }

  console.log("model (id sent to clients)                      canonical");
  console.log("------                                        ----");
  for (const m of items) {
    console.log(`${m.id.padEnd(46)} ${m.canonical}`);
  }
  console.log("");
  console.log(`total: ${items.length} models`);
  console.log("Cost marks (March 2026+ quota system — token-priced, not per-prompt):");
  console.log("  $         cheap   — blended ≲ $1/1M  (GLM-5.3 Flash, Luna, DeepSeek)");
  console.log("  $$        mid     — blended ≲ $4/1M  (GLM-5.3 Max, GPT-5.x, Grok 4.5)");
  console.log("  $$$       pricey  — blended  > $4/1M (Claude Opus/Sonnet, Fast tiers)");
  console.log("  free      quota-free promo (SWE line, active promo window)");
  console.log("  promo     discounted window — still token-priced, but cheap");
  console.log("  unknown   no pricing data");
  console.log("Blended price = 0.6·input + 0.4·output per 1M tokens, a rough stand-in");
  console.log("for agentic workloads. `probe` shows raw per-model credits + $/1M.");
  console.log("Use --zed to print Zed-ready available_models JSON.");
}

function fmtPrice(n: number): string {
  return String(Math.round(n * 100) / 100);
}

async function cmdRecommend(all: boolean, md = false): Promise<void> {
  const c = loadCredentials();
  if (!c) {
    console.error("[windsurf] not signed in. Run: windsurf-openai-proxy login");
    return;
  }
  const status = await getUserStatus(c.apiKey, c.apiServerUrl);

  const rows: Array<{
    uid: string; label: string; score?: number; credits?: number; free: boolean; promo: boolean;
    wsIn?: number; wsOut?: number; orIn?: number; orOut?: number; created?: number; speed?: string; tps?: number;
  }> = [];
  for (const m of status.models.values()) {
    if (m.disabled || isBlockedModel(m.uid)) continue;
    const score = await powerScore(m.uid);
    const info = await lookupOrInfo(m.uid);
    rows.push({
      uid: m.uid, label: m.label, score,
      credits: m.creditsPerPrompt,
      free: isActuallyFreePromo(m),
      promo: isPromoActive(m) && !isActuallyFreePromo(m),
      wsIn: m.pricing?.input, wsOut: m.pricing?.output,
      created: info?.created ?? manualCreated(m.uid),
      speed: speedClass(m.uid),
      tps: speedInfo(m.uid)?.tpsMedian,
    });
  }

  // Enrich with OR prices for models we can map.
  await Promise.all(rows.map(async (r) => {
    const info = await lookupOrInfo(r.uid);
    if (info) { r.orIn = info.inputPer1M; r.orOut = info.outputPer1M; }
  }));

  const ageStr = (created?: number): string => {
    if (!created) return "-";
    const days = Math.floor((Date.now() - created * 1000) / 86_400_000);
    if (days < 31) return "new";
    if (days < 183) return "fresh";
    if (days < 548) return "aging";
    return "old";
  };

  const fmt = (n: number | undefined, digits = 2): string =>
    n === undefined ? "-" : n.toFixed(digits).replace(/\.?0+$/, "");

  // Blended $/1M — what a typical agentic prompt actually costs under the
  // March-2026 quota system (token-priced, not per-prompt credits).
  const cost1M = (r: typeof rows[number]): number | undefined =>
    r.wsIn !== undefined || r.wsOut !== undefined ? blendedPricePer1M({ input: r.wsIn, output: r.wsOut }) : undefined;

  // ЖИР coefficient Ж = real OpenRouter compute per $1 of SUBSCRIPTION,
  // assuming the whole weekly quota is burned on this model:
  //   Ж = (quota $/mo ÷ plan $/mo) × (blended OR price ÷ blended WS price)
  //     = ×14.5 ÷ WS markup for Pro ($50/wk quota from GetUserStatus, $15/mo plan).
  //   Ж ≥ 10     → fat — burn freely; every sub $ buys ≥$10 of real OR compute
  //   1 ≤ Ж < 10 → beats paying OpenRouter directly, but weak — burn surplus quota only
  //   Ж < 1      → the subscription LOSES to OpenRouter on this model (GLM Max fresh input)
  const PRO_USD_PER_MO = 15;
  const WEEKS_PER_MO = 365.25 / 7 / 12;
  const quotaPerMoUsd = (status.quota?.limit !== undefined ? Number(status.quota.limit) : 50) * WEEKS_PER_MO;
  const subBase = quotaPerMoUsd / PRO_USD_PER_MO; // ≈ ×14.5 for Pro
  const fatK = (r: typeof rows[number]): number | undefined => {
    const ws = blendedPricePer1M({ input: r.wsIn, output: r.wsOut });
    const or = blendedPricePer1M({ input: r.orIn, output: r.orOut });
    if (ws === undefined || or === undefined || ws <= 0) return undefined;
    return subBase * or / ws;
  };

  const zhir = (r: typeof rows[number]): string =>
    r.free ? "∞" : fatK(r) !== undefined ? `ж${fmt(fatK(r), 1)}` : "?";

  const line = (r: typeof rows[number]): string => {
    const score = r.score !== undefined ? String(Math.round(r.score)).padStart(3) : "  ?";
    const cost = r.free ? "   0" : cost1M(r) !== undefined ? fmt(cost1M(r), 2).padStart(5) : "    ?";
    const ws = r.wsIn !== undefined ? `${fmt(r.wsIn)}/${fmt(r.wsOut)}` : "-";
    const orr = r.orIn !== undefined ? `${fmt(r.orIn)}/${fmt(r.orOut)}` : "-";
    const z = zhir(r).padEnd(5);
    const age = ageStr(r.created).padEnd(5);
    const tps = r.tps !== undefined ? `${String(Math.round(r.tps)).padStart(3)}tps` : "  ---";
    return `${score}  ${cost}$/1M  ${ws.padEnd(16)}  ${orr.padEnd(16)}  ${z}  ${age}  ${tps}  ${r.label}`;
  };

  // Markdown output for RECOMMENDATIONS.md (--md). GitHub tables are static
  // (no sorting, no row colors) — emoji tier markers are the only visual cue.
  const mdTable = (title: string, header: string[], rowsMd: string[][]): void => {
    console.log(`## ${title}\n`);
    console.log(`| ${header.join(" | ")} |`);
    console.log(`|${header.map(() => " --- |").join("")}`);
    for (const row of rowsMd) console.log(`| ${row.join(" | ")} |`);
    console.log("");
  };

  if (all) {
    // Full flat table: free first, then promos, score desc, price asc.
    rows.sort((a, b) => {
      if (a.free !== b.free) return a.free ? -1 : 1;
      if (a.promo !== b.promo) return a.promo ? -1 : 1;
      const sa = a.score ?? -1, sb = b.score ?? -1;
      if (sa !== sb) return sb - sa;
      return (cost1M(a) ?? 1e9) - (cost1M(b) ?? 1e9);
    });

    if (md) {
      console.log(`> Snapshot for plan **${status.planName ?? "?"}**, ${rows.length} models, generated ${new Date().toISOString().slice(0, 10)}.\n`);
      console.log(`> Regenerate: \`npx tsx cli.ts recommend --all --md\`.\n`);
      console.log(`> **March 2026:** Windsurf replaced per-prompt credits with a token-priced quota — cost below is the real driver.\n`);
      mdTable("All models", ["Tier", "Score", "Cost/1M", "WS $/1M in/out", "OR $/1M in/out", "Ж", "Age", "TPS", "Model"],
        rows.map(r => {
          const base = baseUid(r.uid);
          const tier = r.free ? "🟢 FREE"
            : r.promo && !YELLOW_FAMILIES.some(f => base.startsWith(f)) ? "🟢 PROMO"
            : GREEN_FAMILIES.some(f => base.startsWith(f)) ? "🟢"
            : (cost1M(r) ?? 0) >= 4.0 ? "🔴"
            : YELLOW_FAMILIES.some(f => base.startsWith(f)) || (r.score ?? 0) >= 70 ? "🟡"
            : "";
          return [
            tier,
            r.score !== undefined ? String(Math.round(r.score)) : "?",
            r.free ? "0" : cost1M(r) !== undefined ? fmt(cost1M(r), 2) : "?",
            r.wsIn !== undefined ? `${fmt(r.wsIn)}/${fmt(r.wsOut)}` : "-",
            r.orIn !== undefined ? `${fmt(r.orIn)}/${fmt(r.orOut)}` : "-",
            zhir(r),
            ageStr(r.created),
            r.tps !== undefined ? String(Math.round(r.tps)) : "-",
            r.label,
          ];
        }));
      console.log("**Cost/1M** — blended 0.6·input + 0.4·output $/1M; what the quota actually bills per token volume.  ");
      console.log("**Ж** — fat coefficient: real OpenRouter compute per $1 of subscription at full quota burn (Pro ≈ ×14.5 issuance ÷ WS markup). Ж ≥ 10 → burn freely; Ж < 1 → paying OpenRouter directly beats the subscription.  ");
      console.log("**Score** — Artificial Analysis coding/intelligence index via OpenRouter (0-100).  ");
      console.log("**FREE** — quota-free promo as marketed by Windsurf (SWE). **PROMO** — discounted window, still token-priced.  ");
      console.log("**WS $/1M** — Windsurf extra-usage prices; **OR $/1M** — OpenRouter reference. SWE scores are estimates.  ");
      console.log("**Age** — release date from OpenRouter: new <1mo, fresh <6mo, aging <18mo, old ≥18mo.  ");
      console.log("**TPS** — median output tokens/sec across OpenRouter providers (speeds.json snapshot).\n");
      return;
    }

    console.log(`plan: ${status.planName ?? "?"}   models: ${rows.length} available\n`);
    console.log("TIER    SCORE  COST/1M  WS $/1M (in/out)   OR $/1M (in/out)   Ж      AGE    TPS    MODEL");
    console.log("-----   -----  -------  ----------------   ----------------   -----  -----  -----");
    for (const r of rows) {
      const tier = (r.free ? "FREE" : r.promo ? "PROMO" : "").padEnd(5);
      console.log(`${tier}  ${line(r)}`);
    }
    console.log("\nCOST/1M — blended 0.6·input + 0.4·output $/1M (the quota bills tokens, not prompts).");
    console.log("Ж — fat coefficient: real OpenRouter compute per $1 of subscription at full quota burn (Pro ≈ ×14.5 ÷ markup). Ж ≥ 10 → burn freely; Ж < 1 → paying OR directly beats the subscription.");
    console.log("SCORE — Artificial Analysis coding/intelligence index via OpenRouter (0-100).");
    console.log("FREE — quota-free promo as marketed by Windsurf (SWE). PROMO — discounted window, still token-priced.");
    console.log("WS $/1M — Windsurf extra-usage prices; OR $/1M — OpenRouter reference. SWE scores are estimates.");
    console.log("AGE — release date from OpenRouter: new <1mo, fresh <6mo, aging <18mo, old ≥18mo.");
    console.log("TPS — median output tokens/sec across OpenRouter providers (speeds.json snapshot; run `speeds` to refresh).");
    return;
  }

  // ---- Digest: buckets, few picks each ----
  const byScore = (a: typeof rows[number], b: typeof rows[number]) =>
    (b.score ?? -1) - (a.score ?? -1) || (cost1M(a) ?? 1e9) - (cost1M(b) ?? 1e9);

  // Effective $/1M the subscriber pays now: FREE promos are 0 regardless of
  // listed pricing (that's the extra-usage price, not what quota bills).
  const effectiveCost = (r: typeof rows[number]): number => r.free ? 0 : (cost1M(r) ?? 1e9);

  const free = rows.filter(r => r.free).sort(byScore);                  // genuinely free (SWE line)
  const promo = rows.filter(r => r.promo).sort(byScore);                // promo window: still token-priced, cheap
  const rest = rows.filter(r => !r.free && !r.promo);
  const value = rest.filter(r => effectiveCost(r) < 1.0).sort(byScore);      // ≲$1/1M blended
  const power = rest.filter(r => effectiveCost(r) >= 1.0 && effectiveCost(r) < 4.0).sort(byScore); // $1-4/1M
  const premium = rest.filter(r => effectiveCost(r) >= 4.0).sort(byScore);   // >$4/1M

  const promoTill = promo.length
    ? new Date(Math.max(...[...status.models.values()].filter(isPromoActive).map(m => (m.promoUntil ?? 0) * 1000)))
        .toISOString().slice(0, 10)
    : "";

  // In --md mode the digest becomes section tables of the same picks.
  if (md) {
    const bucketTable = (title: string, picks: typeof rows, note: string): void => {
      mdTable(title, ["Score", "Cost/1M", "WS $/1M in/out", "OR $/1M in/out", "Ж", "Age", "TPS", "Model"],
        picks.slice(0, 5).map(r => [
          r.score !== undefined ? String(Math.round(r.score)) : "?",
          r.free ? "0" : cost1M(r) !== undefined ? fmt(cost1M(r), 2) : "?",
          r.wsIn !== undefined ? `${fmt(r.wsIn)}/${fmt(r.wsOut)}` : "-",
          r.orIn !== undefined ? `${fmt(r.orIn)}/${fmt(r.orOut)}` : "-",
          zhir(r),
          ageStr(r.created),
          r.tps !== undefined ? String(Math.round(r.tps)) : "-",
          r.label,
        ]));
      if (note) console.log(`_${note}_\n`);
    };
    console.log(`# Windsurf model recommendations\n`);
    console.log(`> Snapshot for plan **${status.planName ?? "?"}**, ${rows.length} models, generated ${new Date().toISOString().slice(0, 10)}.\n`);
    console.log(`> Regenerate: \`npx tsx cli.ts recommend --all --md > RECOMMENDATIONS.md\`.\n`);
    console.log(`> **March 2026:** quota system bills per-token ($/1M), not per-prompt credits — Cost/1M is what actually burns your weekly allowance.\n`);
    bucketTable("FREE (no quota)", free, "Genuinely free — grab it while the promo window is open.");
    bucketTable("PROMO (dirt cheap)", promo, `Discounted window, still token-priced — active until ${promoTill}.`);
    bucketTable("VALUE (≲$1/1M)", value, "Best bang for the buck.");
    bucketTable("POWER ($1-4/1M)", power, "Serious muscle at a fair price.");
    bucketTable("PREMIUM (>$4/1M)", premium, "Pricey — save for the really hard stuff.");
    const best = [...value].sort(byScore)[0];
    const strongest = [...power].sort(byScore)[0];
    if (best) console.log(`**Best value pick:** \"${best.label}\" (~$${effectiveCost(best).toFixed(2)}/1M, score ${Math.round(best.score ?? 0)}).\n`);
    if (strongest) console.log(`**Most power for the price:** \"${strongest.label}\" (~$${effectiveCost(strongest).toFixed(2)}/1M, score ${Math.round(strongest.score ?? 0)}).\n`);
    // Full flat table after the digest.
    rows.sort((a, b) => {
      if (a.free !== b.free) return a.free ? -1 : 1;
      if (a.promo !== b.promo) return a.promo ? -1 : 1;
      const sa = a.score ?? -1, sb = b.score ?? -1;
      if (sa !== sb) return sb - sa;
      return (cost1M(a) ?? 1e9) - (cost1M(b) ?? 1e9);
    });
    mdTable("All models", ["Tier", "Score", "Cost/1M", "WS $/1M in/out", "OR $/1M in/out", "Ж", "Age", "TPS", "Model"],
      rows.map(r => [
        r.free ? "FREE" : r.promo ? "PROMO" : "",
        r.score !== undefined ? String(Math.round(r.score)) : "?",
        r.free ? "0" : cost1M(r) !== undefined ? fmt(cost1M(r), 2) : "?",
        r.wsIn !== undefined ? `${fmt(r.wsIn)}/${fmt(r.wsOut)}` : "-",
        r.orIn !== undefined ? `${fmt(r.orIn)}/${fmt(r.orOut)}` : "-",
        zhir(r),
        ageStr(r.created),
        r.tps !== undefined ? String(Math.round(r.tps)) : "-",
        r.label,
      ]));
    console.log("**Cost/1M** — blended 0.6·input + 0.4·output $/1M; the quota bills tokens, not prompts.  ");
    console.log("**Ж** — fat coefficient: real OpenRouter compute per $1 of subscription at full quota burn (Pro ≈ ×14.5 issuance ÷ WS markup). Ж ≥ 10 → burn freely; Ж < 1 → paying OpenRouter directly beats the subscription.  ");
    console.log("**Score** — Artificial Analysis coding/intelligence index via OpenRouter (0-100).  ");
    console.log("**FREE** — quota-free promo as marketed by Windsurf (SWE). **PROMO** — discounted window, still token-priced.  ");
    console.log("**WS $/1M** — Windsurf extra-usage prices; **OR $/1M** — OpenRouter reference. SWE scores are estimates.  ");
    console.log("**Age** — release date from OpenRouter: new <1mo, fresh <6mo, aging <18mo, old ≥18mo.  ");
    console.log("**TPS** — median output tokens/sec across OpenRouter providers (speeds.json snapshot).\n");
    return;
  }

  const section = (title: string, picks: typeof rows, note: string): void => {
    console.log(`── ${title} ${note ? "— " + note : ""}`);
    if (!picks.length) { console.log("   (none)"); console.log(""); return; }
    for (const r of picks.slice(0, 5)) console.log("   " + line(r));
    if (picks.length > 5) console.log(`   … +${picks.length - 5} more (--all)`);
    console.log("");
  };

  console.log(`plan: ${status.planName ?? "?"}   models: ${rows.length} available\n`);
  section("FREE (no quota)", free, "genuinely free — grab it while the promo window is open");
  section("PROMO (dirt cheap)", promo, "discounted window, still token-priced — active until " + promoTill);
  section("VALUE (≲$1/1M)", value, "best bang for the buck");
  section("POWER ($1-4/1M)", power, "serious muscle at a fair price");
  section("PREMIUM (>$4/1M)", premium, "pricey — save for the really hard stuff");

  const best = [...value].sort(byScore)[0];
  const strongest = [...power].sort(byScore)[0];
  if (best) console.log(`Best value pick: go with "${best.label}" (~$${effectiveCost(best).toFixed(2)}/1M, score ${Math.round(best.score ?? 0)}).`);
  if (strongest) console.log(`Most power for the price: "${strongest.label}" (~$${effectiveCost(strongest).toFixed(2)}/1M, score ${Math.round(strongest.score ?? 0)}).`);
  console.log("\nCOST/1M — blended 0.6·input + 0.4·output $/1M. The March-2026 quota bills tokens, not prompts.");
  console.log("Ж — fat coefficient: real OpenRouter compute per $1 of subscription at full quota burn (Pro ≈ ×14.5 ÷ markup). Ж ≥ 10 → burn freely; Ж < 1 → paying OR directly beats the subscription.");
  console.log("WS $/1M — Windsurf extra-usage; OR $/1M — reference market price. Full list: recommend --all");
}

async function cmdProbe(): Promise<void> {
  const c = loadCredentials();
  if (!c) {
    console.error("[windsurf] not signed in. Run: windsurf-openai-proxy login");
    return;
  }
  const host = c.apiServerUrl.replace(/\/$/, "");

  // 1. GetUserStatus — the endpoint the plugin uses: full model list + credits + pricing
  console.log("\n=== 1. GetUserStatus — models with Windsurf's own credits & prices ===");
  try {
    const status = await getUserStatus(c.apiKey, host);
    console.log(`  plan: ${status.planName ?? "?"}  models: ${status.models.size}`);
    let n = 0;
    for (const m of status.models.values()) {
      if (m.disabled || n >= 15) continue;
      n++;
      const promo = isPromoActive(m) ? ` PROMO→${new Date(m.promoUntil! * 1000).toISOString().slice(0, 10)}` : "";
      const cr = m.creditsPerPrompt !== undefined ? `${fmtPrice(m.creditsPerPrompt)}cr` : "?";
      const p = m.pricing ? `$${fmtPrice(m.pricing.input ?? 0)}/$${fmtPrice(m.pricing.output ?? 0)} per 1M` : "";
      console.log(`  ${m.label.padEnd(34)} ${cr.padEnd(7)} ${p}${promo}`);
    }
    const promos = [...status.models.values()].filter(m => isPromoActive(m));
    console.log(`  active promos: ${promos.length} → ${promos.map(m => m.label).join(", ")}`);
  } catch (e) { console.log("  ERR:", e instanceof Error ? e.message : String(e)); }

  // 2. One tiny chat request with usage debug — dump every metric the server sends
  console.log("\n=== 2. Chat request — all usage metrics ===");
  process.env.WINDSURF_DEBUG_USAGE = "1";
  try {
    const probeUid = [...(await getUserStatus(c.apiKey, host)).models.values()]
      .find(m => !m.disabled)?.uid ?? "swe-2-high";
    let text = "";
    for await (const ev of streamChatEvents({
      apiKey: c.apiKey,
      apiServerUrl: c.apiServerUrl,
      modelUid: probeUid,
      messages: [{ role: "user", content: "hi" }],
      completionOpts: { maxOutputTokens: 16 },
    })) {
      if (ev.kind === "text") text += ev.text;
      if (ev.kind === "usage") console.log("  parsed usage:", JSON.stringify(ev));
    }
    console.log("  reply:", text.slice(0, 80) || "(empty)");
  } catch (e) { console.log("  ERR:", e instanceof Error ? e.message : String(e)); }
}

async function cmdSpeeds(): Promise<void> {
  console.error("[windsurf] collecting provider speed stats from OpenRouter model pages…");
  const ok = await collectSpeeds((done, total, orId) => {
    if (done % 10 === 0 || done === total) console.error(`[windsurf] ${done}/${total} ${orId}`);
  });
  console.log(`[windsurf] speeds.json updated: ${ok} models with stats`);
}

async function main(): Promise<void> {
  const { command, port, host, zed, all, md } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "serve": await cmdServe(port, host); break;
    case "login": await cmdLogin(); break;
    case "status": cmdStatus(); break;
    case "logout": cmdLogout(); break;
    case "models": await cmdModels(zed); break;
    case "recommend": await cmdRecommend(all, md); break;
    case "speeds": await cmdSpeeds(); break;
    case "probe": await cmdProbe(); break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`windsurf-openai-proxy — standalone OpenAI-compatible proxy for Windsurf/Cognition

Usage:
  npx tsx cli.ts serve [--port 42100] [--host 127.0.0.1]
  npx tsx cli.ts login
  npx tsx cli.ts status
  npx tsx cli.ts logout
  npx tsx cli.ts models
  npx tsx cli.ts recommend
  npx tsx cli.ts speeds
  npx tsx cli.ts probe

Commands:
  serve   Start the HTTP proxy (default). Point OpenAI clients at http://<host>:<port>/v1
  login   Sign in via Windsurf OAuth and save credentials to disk
  status  Show saved credentials
  logout  Delete saved credentials
  models  Print the known model list with approximate pricing
  recommend  Power-vs-cost table: merges Windsurf promos/$-prices with
          OpenRouter benchmarks ( Artificial Analysis ) — shows what to use now
  speeds  Scrape per-provider throughput (tps) from OpenRouter model pages
          into speeds.json — refresh occasionally, it's a slow one-time crawl
  probe   Dump Windsurf's raw per-model credits (legacy) + $/1M prices from
          GetUserStatus, then log every usage metric from one tiny chat request

Options:
  --port, -p <n>   Proxy port (default 42100)
  --host <addr>    Bind address (default 127.0.0.1; use 0.0.0.0 to expose on LAN/WAN)

Remote access: put keys in keys.json next to the CLI — remote clients must send
'Authorization: Bearer <key>'. Optional 'max_price' per key limits model list
and chat to models whose Windsurf input $/1M is ≤ that limit (free/promo always pass).
Localhost clients are trusted without a key.
`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
