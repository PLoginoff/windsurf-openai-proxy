/**
 * OpenAI-compatible HTTP proxy → Cognition Connect-RPC.
 *
 * Binds at 127.0.0.1:42100 (or fallback port). Accepts standard
 * /v1/chat/completions and /v1/models requests, translates to
 * WindSurf's cloud-direct GetChatMessage wire format.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { streamChatEventsWithRetry, CloudChatError, type ChatHistoryItem, type ToolDef } from "./chat";
import { loadCredentials } from "./oauth";
import { authenticateKey, priceLimit, type KeyPolicy } from "./keys";
import { getCachedCatalog } from "./catalog";
import { getUserStatus, getCachedUserStatus, isPromoActive, isActuallyFreePromo, type UserStatusModel } from "./status";
import { stripCostAnnotation, tierAnnotation, tierFromCredits, tierFromPricing, blendedPricePer1M, userTierOverride, isBlockedModel, titleizeModelId, type PriceTier, type UsageSummary } from "./costs";
import { FEATURED_UIDS } from "./featured";
import { powerScore, fatK } from "./ranks";
import { looksLikeToolBlockError } from "./toolblock";

const WINDSURF_PROXY_HOST = "127.0.0.1";
const WINDSURF_PROXY_PORT = 42100;

// ----------------------------------------------------------------------------
// Proxy handler (Node http server)
// ----------------------------------------------------------------------------

interface ChatCompletionRequest {
  model?: string;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
    tool_call_id?: string;
    tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: Record<string, unknown> } }>;
}

// Ollama-native chat request (/api/chat) — translated into the same pipeline.
// Differences from OpenAI: content parts use {type:"image", image:"<b64>"},
// tool_call arguments may be objects, options carry num_predict/temperature.
interface OllamaChatRequest {
  model?: string;
  messages: Array<{
    role: string;
    content?: string | Array<{ type: string; text?: string; image?: string; image_url?: { url: string } }>;
    tool_call_id?: string;
    tool_name?: string;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
  }>;
  stream?: boolean;
  tools?: Array<Record<string, unknown>>;
  options?: { num_predict?: number; temperature?: number; top_k?: number; top_p?: number; num_ctx?: number };
}

function mapMessageToHistoryItem(m: ChatCompletionRequest["messages"][number]): ChatHistoryItem {
  const item: ChatHistoryItem = { role: m.role as ChatHistoryItem["role"], content: m.content as ChatHistoryItem["content"] };
  if (m.role === "tool" && typeof m.tool_call_id === "string" && m.tool_call_id.length > 0) {
    item.tool_call_id = m.tool_call_id;
  }
  if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    item.tool_calls = m.tool_calls
      .map(tc => ({ id: typeof tc.id === "string" ? tc.id : "", name: typeof tc.function?.name === "string" ? tc.function.name : "", arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : "" }))
      .filter(tc => tc.id !== "" && tc.name !== "");
  }
  return item;
}

// ----------------------------------------------------------------------------
// Model list — live per-account data from GetUserStatus, catalog fallback
// ----------------------------------------------------------------------------

export interface ModelListItem {
  id: string; // client-facing id: pretty display name with tier annotation.
  // Zed's llama.cpp provider derives what it shows AND what it sends back from
  // `id`, so the tier must live there. Resolution maps it back to `canonical`.
  name: string;
  canonical: string; // canonical id / model_uid used to route chat requests
  tier: PriceTier;
  contextWindow?: number;
}

// Sort order: featured first (in list order), then promo/free, cheap → expensive, unknown last.
const TIER_ORDER: Record<PriceTier, number> = { free: 0, promo: 1, "$": 2, "$$": 3, "$$$": 4, unknown: 5 };

function featuredRank(uid: string): number {
  const idx = FEATURED_UIDS.indexOf(uid);
  return idx === -1 ? FEATURED_UIDS.length : idx;
}

// Zed re-sorts the model list alphabetically by name (llama_cpp.rs:
// `models.sort_by_key(|model| model.name())`), ignoring our /v1/models order.
// To pin featured models on top anyway, their ids get three leading spaces:
// space sorts before any letter, so all featured land above the rest
// (their internal order is alphabetical — fine). Small indent in Zed's picker.
function featuredIndent(uid: string): string {
  return FEATURED_UIDS.includes(uid) ? "   " : "";
}

// Tier for a live model: tiers.json override wins, then promo → free,
// then Windsurf's credits-per-prompt, then "unknown".
/** Coerce a tiers.json value to a display tier ("blocked" never reaches here). */
function asTier(v: ReturnType<typeof userTierOverride>): PriceTier {
  return v !== undefined && v !== "blocked" ? v : "unknown";
}

function tierForLiveModel(m: UserStatusModel): PriceTier {
  const override = userTierOverride(m.uid);
  if (override !== undefined && override !== "blocked") return override;
  if (isActuallyFreePromo(m)) return "free";
  if (isPromoActive(m)) return "promo";
  // Since March 2026 quotas bill per-token ($/1M from f32), not per-prompt
  // credits — tier by the real token price. f3 creditsPerPrompt is legacy.
  if (m.pricing) return tierFromPricing(m.pricing);
  if (m.creditsPerPrompt !== undefined) return tierFromCredits(m.creditsPerPrompt);
  return "unknown";
}

/** Rank badge for a model id: " ★76" or "" when no score is known. */
async function rankAnnotation(uid: string): Promise<string> {
  const score = await powerScore(uid);
  return score !== undefined ? ` ★${Math.round(score)}` : "";
}

/** Ж badge for a model: " ж29" or "" when OR price is unknown. */
async function zhirAnnotation(uid: string, wsIn?: number, wsOut?: number): Promise<string> {
  const status = getCachedUserStatus();
  const quotaWeekly = status?.quota?.limit !== undefined ? Number(status.quota.limit) : undefined;
  const k = await fatK(uid, wsIn, wsOut, { quotaWeeklyUsd: quotaWeekly });
  if (k === undefined) return "";
  const rounded = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
  return ` ж${rounded}`;
}

export async function buildModelList(maxPrice?: number): Promise<ModelListItem[]> {
  const out: ModelListItem[] = [];
  const seen = new Set<string>();
  const push = (uid: string, label: string, tier: PriceTier, contextWindow?: number): void => {
    if (seen.has(uid)) return;
    seen.add(uid);
    out.push({ id: label, name: label, canonical: uid, tier, ...(contextWindow ? { contextWindow } : {}) });
  };

  // Per-key filter: with a max_price limit, only models whose Windsurf input
  // price ($/1M) is ≤ limit are listed. Real quota-free promo always passes.
  const withinLimit = (m: UserStatusModel): boolean => {
    if (maxPrice === undefined) return true;
    if (isActuallyFreePromo(m)) return true;
    const price = m.pricing?.input ?? 0;
    return price <= maxPrice;
  };

  // Live account data — GetUserStatus (the endpoint the Windsurf plugin uses):
  // the full per-account model list with labels, context windows, credits, promos.
  let creds: { apiKey: string; apiServerUrl: string } | null = null;
  try { creds = loadCredentials(); } catch {}
  if (creds) {
    let liveOk = false;
    try {
      const status = await getUserStatus(creds.apiKey, creds.apiServerUrl);
      if (status.models.size > 0) {
        liveOk = true;
        for (const m of status.models.values()) {
          if (m.disabled || isBlockedModel(m.uid) || !withinLimit(m)) continue;
          const tier = tierForLiveModel(m);
          const label = `${featuredIndent(m.uid)}${m.label}${await rankAnnotation(m.uid)}${await zhirAnnotation(m.uid, m.pricing?.input, m.pricing?.output)}${tierAnnotation(tier)}`;
          push(m.uid, label, tier, m.contextWindow);
        }
      }
    } catch {}

    // Fallback: GetCascadeModelConfigs (404s on self-serve hosts). No credits
    // data here — tiers come from tiers.json overrides or "unknown".
    if (!liveOk) {
      try {
        const catalog = await getCachedCatalog(creds.apiKey, creds.apiServerUrl);
        if (catalog) {
          for (const [uid, entry] of catalog.byUid) {
            if (entry.disabled || isBlockedModel(uid)) continue;
            const tier = asTier(userTierOverride(uid));
            const base = entry.label && entry.label !== uid ? entry.label : titleizeModelId(uid);
            push(uid, `${featuredIndent(uid)}${base}${await rankAnnotation(uid)}${await zhirAnnotation(uid)}${tierAnnotation(tier)}`, tier);
          }
        }
      } catch {}
    }
  }

  // featured first (in FEATURED_UIDS order), then free/promo → $ → $$ → $$$,
  // unknown last; alphabetical within each group
  out.sort((a, b) =>
    (featuredRank(a.canonical) - featuredRank(b.canonical)) ||
    (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]) ||
    a.id.localeCompare(b.id),
  );
  return out;
}

// Resolve what a client sends as `model` back to a model_uid:
//  1. pretty label from our own list (incl. leading featured-indent spaces)
//  2. live catalog label
//  3. raw model_uid passthrough
async function resolveRequestedModel(raw: string | undefined): Promise<string> {
  const stripped = raw ? stripCostAnnotation(raw) : "";
  if (!stripped) return "";
  const trimmed = stripped.trim();
  const items = await buildModelList();
  // Pretty id / name from /v1/models — exact match first, then trimmed
  // (in case a client strips the featured indent spaces)
  const byId = items.find(m => m.id === raw || m.id === stripped || m.name === stripped)
    ?? items.find(m => m.id.trim() === trimmed || m.name.trim() === trimmed);
  if (byId) return byId.canonical;
  // Live catalog label without annotation ("Claude Opus 5.5 Medium")
  const status = getCachedUserStatus();
  if (status) {
    const lower = trimmed.toLowerCase();
    for (const m of status.models.values()) {
      if (m.label.toLowerCase() === lower) return m.uid;
    }
  }
  // Raw model_uid passthrough (the client knows a uid we didn't list)
  return trimmed;
}

// Best-available tier for a model_uid: live promo/credits + tiers.json override.
function tierForModel(uid: string): PriceTier {
  const status = getCachedUserStatus();
  const m = status?.models.get(uid);
  if (m) return tierForLiveModel(m);
  return asTier(userTierOverride(uid));
}

function logCost(modelId: string, usage: UsageSummary | null, keyPolicy?: KeyPolicy): void {
  if (!usage) return;
  const fmt = (n?: number) => (n ?? 0).toLocaleString("en-US");
  const who = keyPolicy?.name ? ` [${keyPolicy.name}]` : "";
  // Expected $ at WS list prices (cache-read discounted). Diff against the
  // quota line logged by logBalance() to validate how the weekly budget is
  // actually metered — estimate and quota delta should match.
  const p = getCachedUserStatus()?.models.get(modelId)?.pricing;
  let est = "";
  if (p && (p.input ?? 0) > 0) {
    const cached = usage.cachedInputTokens ?? 0;
    const fresh = Math.max(0, (usage.promptTokens ?? 0) - cached);
    const cost = fresh / 1e6 * (p.input ?? 0)
      + cached / 1e6 * (p.cachedInput ?? 0)
      + (usage.completionTokens ?? 0) / 1e6 * (p.output ?? 0);
    est = `  ≈$${cost.toFixed(4)}`;
  }
  console.error(`[windsurf] ${modelId}  in=${fmt(usage.promptTokens)} out=${fmt(usage.completionTokens)} cached=${fmt(usage.cachedInputTokens)}${est}  (${tierForModel(modelId)})${who}`);
}

// Refresh GetUserStatus after a chat and report the plan credit pool (f7).
// We can't see per-request credit deductions, but watching the pool value
// between requests reveals the real cost (including retries that fail silently).
let lastQuotaUsedCents: number | null = null;

function logBalance(creds: { apiKey: string; apiServerUrl: string }): void {
  getUserStatus(creds.apiKey, creds.apiServerUrl, undefined, { force: true })
    .then((s) => {
      const q = s.quota;
      if (q) {
        const end = q.windowEnd ? new Date(q.windowEnd * 1000).toISOString().slice(0, 16) : "?";
        // f15 = weekly $ budget; f16 = remaining balance in cents (signed).
        // Used = limit*100 - balance_cents. Observed: -5874¢ = $58.74 overdraft.
        const usedCents = Number(q.limit) * 100 - Number(q.balance);
        const delta = lastQuotaUsedCents !== null ? usedCents - lastQuotaUsedCents : null;
        lastQuotaUsedCents = usedCents;
        const dstr = delta !== null && delta !== 0 ? `  (Δ $${(delta / 100).toFixed(4)} since last request)` : "";
        console.error(`[windsurf] quota: $${(usedCents / 100).toFixed(2)} of $${q.limit} used this week${dstr} (resets ${end})`);
      } else {
        console.error(`[windsurf] plan ${s.planName ?? "?"}: no quota block parsed`);
      }
    })
    .catch(() => { /* quota exhausted or network — skip silently */ });
}

function openAIError(status: number, message: string, details?: string): object {
  return { status, body: JSON.stringify({ error: { message: details ? `${message}\n${details}` : message, type: "windsurf_error", param: null, code: null } }), contentType: "application/json" };
}

function isLoopbackAddress(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export function extractPathKeyAndNormalize(pathname: string): { normalizedPath: string; pathKey: string | null } {
  // Matches:
  //   /key:<key>/v1/models
  //   /k:<key>/v1/models
  //   /key/<key>/v1/models
  //   /k/<key>/v1/models
  const match = pathname.match(/^\/(?:key:|k:|key\/|k\/)([^/]+)(\/.*)?$/);
  if (match) {
    const pathKey = decodeURIComponent(match[1]);
    const rest = match[2] || "/";
    return { normalizedPath: rest, pathKey };
  }
  return { normalizedPath: pathname, pathKey: null };
}

function extractBearerOrQueryKey(req: IncomingMessage, url: URL, pathKey: string | null): string | null {
  // 1. Path prefix /key:<key> — highest priority: when present, the header is
  // ignored (clients like Zed/Cline tend to stuff garbage into Authorization).
  if (pathKey && pathKey.trim().length > 0) return pathKey.trim();
  // 2. Header
  const authHeader = (req.headers.authorization ?? "") as string;
  if (authHeader.startsWith("Bearer ")) {
    const key = authHeader.slice("Bearer ".length).trim();
    if (key.length > 0) return key;
  }
  // 3. Query param ?key= / ?api_key=
  const qKey = url.searchParams.get("key") ?? url.searchParams.get("api_key");
  if (qKey && qKey.trim().length > 0) return qKey.trim();
  return null;
}

async function authorizeRequest(req: IncomingMessage, url: URL, pathKey: string | null): Promise<{ status: number; body: string; contentType: string; keyPolicy?: KeyPolicy } | null> {
  const ip = req.socket.remoteAddress;

  // Local clients (Zed, curl on this machine) are trusted without a Bearer key —
  // the proxy is localhost-oriented and the key only guards remote access when
  // bound to a non-loopback host (--host 0.0.0.0).
  if (isLoopbackAddress(ip)) {
    const presented = extractBearerOrQueryKey(req, url, pathKey);
    if (presented) {
      const policy = authenticateKey(presented);
      if (policy) return { status: 0, body: "", contentType: "", keyPolicy: policy };
    }
    return null;
  }

  const presented = extractBearerOrQueryKey(req, url, pathKey);
  if (!presented) {
    return { status: 401, body: JSON.stringify({ error: { message: "Unauthorized: missing Authorization header, path prefix /key:<key>, or ?key query param.", type: "windsurf_error" } }), contentType: "application/json" };
  }
  const presentedBuf = Buffer.from(presented, "utf8");

  // keys.json policies first (per-key model restrictions)
  const policy = authenticateKey(presented);
  if (policy) return { status: 0, body: "", contentType: "", keyPolicy: policy };

  // Otherwise, accept the persisted apiKey from disk (from `cli.ts login`)
  try {
    const creds = loadCredentials();
    if (creds?.apiKey) {
      const credBuf = Buffer.from(creds.apiKey, "utf8");
      if (presentedBuf.length === credBuf.length && crypto.timingSafeEqual(presentedBuf, credBuf)) return null;
    }
  } catch {}

  return { status: 401, body: JSON.stringify({ error: { message: "Unauthorized: Invalid API key.", type: "windsurf_error" } }), contentType: "application/json" };
}

function getBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const rawUrl = new URL(req.url ?? "/", `http://${WINDSURF_PROXY_HOST}`);
    const { normalizedPath, pathKey } = extractPathKeyAndNormalize(rawUrl.pathname);
    const url = new URL(normalizedPath + rawUrl.search, `http://${WINDSURF_PROXY_HOST}`);

    // /health — unauthenticated
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /v1/models and /props — unauthenticated, so Zed's dynamic providers
    // (llama.cpp / LM Studio) can list models before an API key is configured.
    // These leak nothing (model names/tiers only, localhost-bound); chat still
    // requires the Bearer key.
    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      // If the client sent a Bearer key (or path prefix /k/<key> or query param) from keys.json
      // with a max_price limit, filter the list to models within that budget.
      const presented = extractBearerOrQueryKey(req, rawUrl, pathKey);
      let maxPrice: number | undefined;
      if (presented) {
        const policy = authenticateKey(presented);
        if (policy) maxPrice = priceLimit(policy);
      }
      const items = await buildModelList(maxPrice);
      const created = Math.floor(Date.now() / 1000);
      const data = items.map(m => ({
        id: m.id,
        object: "model",
        created,
        owned_by: "windsurf",
        name: m.name,
        ...(m.contextWindow ? { meta: { n_ctx_train: m.contextWindow } } : {}),
        architecture: { input_modalities: ["text", "image"] },
        // Router mode: Zed probes /props?model=<id> per model for capabilities
        // and context, instead of one blanket /props for the whole list.
        status: { value: "loaded" },
        type: "llm",
        publisher: "windsurf",
        compatibility_type: "gguf",
        state: "loaded",
        capabilities: ["tool_use", "vision"],
        ...(m.contextWindow ? { max_context_length: m.contextWindow } : {}),
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data }));
      return;
    }
    // /props — llama.cpp capability probe. Router mode passes ?model=<id>;
    // answer with that model's real context window.
    if (req.method === "GET" && url.pathname === "/props") {
      const model = url.searchParams.get("model");
      let nCtx = 128000;
      if (model) {
        const items = await buildModelList();
        const trimmed = model.trim();
        const hit = items.find(m => m.id === model || m.canonical === model)
          ?? items.find(m => m.id.trim() === trimmed || m.canonical === trimmed);
        if (hit?.contextWindow) nCtx = hit.contextWindow;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        default_generation_settings: { n_ctx: nCtx },
        modalities: { vision: true },
        chat_template_caps: {
          supports_tool_calls: true,
          supports_tools: true,
          supports_preserve_reasoning: true,
        },
      }));
      return;
    }

    // GET /api/tags — Ollama-native model list (Zed's/Cline's "Ollama" provider).
    // Same data as /v1/models in Ollama's shape; honors the key policy for filtering.
    if (req.method === "GET" && url.pathname === "/api/tags") {
      const presented = extractBearerOrQueryKey(req, rawUrl, pathKey);
      let maxPrice: number | undefined;
      if (presented) {
        const policy = authenticateKey(presented);
        if (policy) maxPrice = priceLimit(policy);
      }
      const items = await buildModelList(maxPrice);
      const modified = new Date().toISOString();
      const models = items.map(m => ({
        name: m.id,
        model: m.id,
        modified_at: modified,
        size: 0,
        digest: m.canonical,
        details: {
          parent_model: "",
          format: "gguf",
          family: "windsurf",
          families: ["windsurf"],
          parameter_size: "",
          quantization_level: "",
        },
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models }));
      return;
    }

    // GET /api/version — Ollama version probe (some clients check it).
    if (req.method === "GET" && url.pathname === "/api/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: "0.0.0" }));
      return;
    }

    // POST /api/show — Ollama model info (modelfile, capabilities, context).
    // Cline calls this per model; answer with real context window + caps.
    if (req.method === "POST" && url.pathname === "/api/show") {
      const rawBody = await getBody(req);
      let model: string | undefined;
      try { model = (JSON.parse(rawBody) as { model?: string }).model; } catch {}
      let nCtx = 128000;
      if (model) {
        const items = await buildModelList();
        const trimmed = model.trim();
        const hit = items.find(m => m.id === model || m.canonical === model)
          ?? items.find(m => m.id.trim() === trimmed || m.canonical === trimmed);
        if (hit?.contextWindow) nCtx = hit.contextWindow;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        license: "",
        modelfile: "",
        parameters: "",
        template: "",
        model_info: {
          "general.architecture": "windsurf",
          "general.family": "windsurf",
          "windsurf.context_length": nCtx,
        },
        // Ollama sends a string array here; Zed's ModelShow deserializer expects
        // Vec<String> and enables features by name: "tools", "vision", "thinking".
        capabilities: ["completion", "tools", "vision", "thinking"],
        ...(nCtx ? { "general.context_length": nCtx } : {}),
        messages: [],
        modified_at: new Date().toISOString(),
      }));
      return;
    }

    // Auth gate for everything else
    const auth = await authorizeRequest(req, rawUrl, pathKey);
    if (auth && auth.status !== 0) {
      res.writeHead(auth.status, { "Content-Type": auth.contentType });
      res.end(auth.body);
      return;
    }
    const keyPolicy = auth?.keyPolicy;

    // POST /api/chat — Ollama-native chat (Zed's/Cline's "Ollama" provider).
    if (url.pathname === "/api/chat") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed; use POST." }));
        return;
      }

      const rawBody = await getBody(req);
      let body: OllamaChatRequest;
      try { body = JSON.parse(rawBody) as OllamaChatRequest; }
      catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Malformed JSON." })); return; }

      if (!body.messages || !Array.isArray(body.messages)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "messages must be an array." }));
        return;
      }

      const creds = loadCredentials();
      if (!creds) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not authenticated. Run `windsurf-openai-proxy login` first." }));
        return;
      }

      const modelUid = await resolveRequestedModel(typeof body.model === "string" ? body.model : undefined);
      if (!modelUid) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'model' in request body." }));
        return;
      }

      // Per-key model restriction (same rule as the OpenAI endpoint)
      // Per-key model restriction by Windsurf input $/1M (free promo always passes)
      const keyLimit = keyPolicy ? priceLimit(keyPolicy) : undefined;
      if (keyLimit !== undefined) {
        const status = getCachedUserStatus();
        const m = status?.models.get(modelUid);
        const price = m?.pricing?.input ?? 0;
        const isFree = m ? isActuallyFreePromo(m) : false;
        if (!isFree && price > keyLimit) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Model not allowed for this key: input $${price}/1M exceeds limit $${keyLimit}/1M. Pick a cheaper model.` }));
          return;
        }
      }

      // Tools: accept OpenAI format and Ollama's flat {name, description, parameters}.
      const tools: ToolDef[] = [];
      for (const t of body.tools ?? []) {
        const rec = t as { function?: { name?: string; description?: string; parameters?: Record<string, unknown> }; name?: string; description?: string; parameters?: Record<string, unknown> };
        const fn = rec.function;
        if (fn && typeof fn.name === "string") tools.push({ name: fn.name, description: fn.description ?? "", parameters: fn.parameters ?? {} });
        else if (typeof rec.name === "string") tools.push({ name: rec.name, description: rec.description ?? "", parameters: rec.parameters ?? {} });
      }

      // Messages: normalize Ollama image parts ({type:"image", image:"<b64>"})
      // and tool_call arguments (Ollama allows objects; our wire wants strings).
      const multimodalMessages: ChatHistoryItem[] = body.messages.map(m => {
        let content: ChatCompletionRequest["messages"][number]["content"] = "";
        if (Array.isArray(m.content)) {
          content = m.content.map(p => {
            if (p.type === "image" && typeof p.image === "string") {
              const url = p.image.startsWith("data:") ? p.image : `data:image/png;base64,${p.image}`;
              return { type: "image_url" as const, image_url: { url } };
            }
            return { type: p.type, ...(p.text !== undefined ? { text: p.text } : {}), ...(p.image_url ? { image_url: p.image_url } : {}) };
          });
        } else if (typeof m.content === "string") {
          content = m.content;
        }
        const toolCalls = Array.isArray(m.tool_calls)
          ? m.tool_calls.map(tc => ({
            id: typeof tc?.id === "string" && tc.id ? tc.id
              : typeof tc?.function?.name === "string" ? `call-${tc.function.name}` : undefined,
            type: "function",
            function: {
              name: typeof tc?.function?.name === "string" ? tc.function.name : "",
              arguments: typeof tc?.function?.arguments === "object" && tc.function.arguments !== null
                ? JSON.stringify(tc.function.arguments)
                : typeof tc?.function?.arguments === "string" ? tc.function.arguments : "",
            },
          }))
          : undefined;
        // Zed's Ollama provider sends tool results as {role:"tool", tool_name, content}
        // with no tool_call_id — map tool_name onto it so the wire can pair them.
        const toolCallId = typeof m.tool_call_id === "string" && m.tool_call_id
          ? m.tool_call_id
          : typeof m.tool_name === "string" && m.tool_name ? m.tool_name : undefined;
        return mapMessageToHistoryItem({ role: m.role, content: content ?? "", tool_call_id: toolCallId, tool_calls: toolCalls });
      });

      const opts = body.options ?? {};
      const completionOpts = {
        maxOutputTokens: typeof opts.num_predict === "number" && opts.num_predict > 0 ? opts.num_predict : 128_000,
        ...(typeof opts.temperature === "number" ? { temperature: opts.temperature } : {}),
        ...(typeof opts.top_k === "number" ? { topK: opts.top_k } : {}),
        ...(typeof opts.top_p === "number" ? { topP: opts.top_p } : {}),
      };
      const isStreaming = body.stream !== false;
      const modelName = typeof body.model === "string" ? body.model : modelUid;
      const nowIso = (): string => new Date().toISOString();

      if (isStreaming) {
        // NDJSON streaming, Ollama-native chunks. Tool calls are buffered and
        // flushed whole (one complete tool_calls line per call) — clients
        // accumulate `function.arguments` strings across chunks, so this is
        // the most compatible shape.
        res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        const abort = new AbortController();
        req.on("close", () => { if (!res.writableEnded) abort.abort(); });
        const send = (o: unknown): void => { res.write(`${JSON.stringify(o)}\n`); };
        let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null = null;
        let pendingToolCall: { name: string; args: string } | null = null;
        let toolCallSeq = 0;
        const flushToolCall = (): void => {
          if (!pendingToolCall) return;
          // Zed's ChatResponseDelta requires tool_calls[].id (String) and expects
          // arguments as a JSON object — it becomes the tool input verbatim.
          let args: unknown = pendingToolCall.args;
          try { args = JSON.parse(pendingToolCall.args); } catch { /* keep raw string */ }
          send({
            model: modelName, created_at: nowIso(), done: false,
            message: {
              role: "assistant", content: "",
              tool_calls: [{
                id: `call-${pendingToolCall.name}-${(toolCallSeq += 1)}`,
                function: { name: pendingToolCall.name, arguments: args },
              }],
            },
          });
          pendingToolCall = null;
        };
        try {
          for await (const ev of streamChatEventsWithRetry({
            apiKey: creds.apiKey,
            apiServerUrl: creds.apiServerUrl,
            modelUid,
            messages: multimodalMessages,
            tools: tools.length > 0 ? tools : undefined,
            signal: abort.signal,
            completionOpts,
          })) {
            if (ev.kind === "text") {
              send({ model: modelName, created_at: nowIso(), message: { role: "assistant", content: ev.text }, done: false });
            } else if (ev.kind === "reasoning") {
              send({ model: modelName, created_at: nowIso(), message: { role: "assistant", content: "", thinking: ev.text }, done: false });
            } else if (ev.kind === "tool_call_start") {
              flushToolCall();
              pendingToolCall = { name: ev.name, args: "" };
            } else if (ev.kind === "tool_call_args") {
              if (pendingToolCall) pendingToolCall.args += ev.argsDelta;
            } else if (ev.kind === "usage") {
              usage = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens, totalTokens: ev.totalTokens };
            }
          }
          flushToolCall();
          send({
            model: modelName, created_at: nowIso(),
            message: { role: "assistant", content: "" },
            done_reason: "stop", done: true,
            ...(usage ? { prompt_eval_count: usage.promptTokens ?? 0, eval_count: usage.completionTokens ?? 0 } : {}),
          });
          res.end();
          logCost(modelUid, usage, keyPolicy);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          // Blocklist rejections look mysterious in logs — add a one-line hint.
          const hint = looksLikeToolBlockError(errorMessage)
            ? " (tool-description blocklist hit — extend POISON_PHRASES in toolblock.ts)"
            : "";
          console.error(`[windsurf] CHAT ERROR (${modelUid}): ${errorMessage}${hint}`);
          // A bare {error} line breaks Zed's line parser (ChatResponseDelta):
          // send the error as a final assistant message instead.
          try {
            send({ model: modelName, created_at: nowIso(), message: { role: "assistant", content: `Error: ${errorMessage}` }, done_reason: "error", done: true });
            res.end();
          } catch { /* socket dead */ }
        }
      } else {
        // Non-streaming: single JSON response
        let collected = "";
        let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null = null;
        type CollectedToolCall = { name: string; args: string };
        const collectedToolCalls: CollectedToolCall[] = [];
        let currentToolCall: CollectedToolCall | null = null;
        const abort = new AbortController();
        req.on("close", () => { if (!res.writableEnded) abort.abort(); });
        for await (const ev of streamChatEventsWithRetry({
          apiKey: creds.apiKey,
          apiServerUrl: creds.apiServerUrl,
          modelUid,
          messages: multimodalMessages,
          tools: tools.length > 0 ? tools : undefined,
          completionOpts,
          signal: abort.signal,
        })) {
          if (ev.kind === "text") collected += ev.text;
          else if (ev.kind === "tool_call_start") { currentToolCall = { name: ev.name, args: "" }; collectedToolCalls.push(currentToolCall); }
          else if (ev.kind === "tool_call_args") { if (currentToolCall) currentToolCall.args += ev.argsDelta; }
          else if (ev.kind === "usage") usage = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens, totalTokens: ev.totalTokens };
        }
        const message = collectedToolCalls.length > 0
          ? {
            role: "assistant", content: collected,
            tool_calls: collectedToolCalls.map((tc, i) => {
              let args: unknown = tc.args;
              try { args = JSON.parse(tc.args); } catch { /* keep string */ }
              return { id: `call-${tc.name}-${i + 1}`, function: { name: tc.name, arguments: args } };
            }),
          }
          : { role: "assistant", content: collected };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          model: modelName, created_at: nowIso(), message, done: true, done_reason: "stop",
          ...(usage ? { prompt_eval_count: usage.promptTokens ?? 0, eval_count: usage.completionTokens ?? 0 } : {}),
        }));
        logCost(modelUid, usage, keyPolicy);
        logBalance(creds);
      }
      return;
    }

    // /v1/chat/completions
    if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Method not allowed; use POST.", type: "windsurf_error" } }));
        return;
      }

      const rawBody = await getBody(req);
      if (process.env.WINDSURF_DEBUG_REQ) {
        try { fs.writeFileSync(`/tmp/ws-req-${Date.now()}.json`, JSON.stringify(JSON.parse(rawBody), null, 1)); } catch {}
      }
      let requestBody: ChatCompletionRequest;
      try { requestBody = JSON.parse(rawBody); }
      catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Malformed JSON." } })); return; }

      if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "messages must be an array." } }));
        return;
      }

      const creds = loadCredentials();
      if (!creds) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Not authenticated. Run `windsurf-openai-proxy login` first." } }));
        return;
      }

      // Resolve what the client sends (pretty name, label, or raw uid) → model_uid.
      const modelUid = await resolveRequestedModel(requestBody.model);
      if (!modelUid) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Missing 'model' in request body." } }));
        return;
      }

      // Per-key model restriction by Windsurf input $/1M (free promo always passes)
      const keyLimit = keyPolicy ? priceLimit(keyPolicy) : undefined;
      if (keyLimit !== undefined) {
        const status = getCachedUserStatus();
        const m = status?.models.get(modelUid);
        const price = m?.pricing?.input ?? 0;
        const isFree = m ? isActuallyFreePromo(m) : false;
        if (!isFree && price > keyLimit) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: `Model not allowed for this key: input $${price}/1M exceeds limit $${keyLimit}/1M. Pick a cheaper model.`, type: "windsurf_error" } }));
          return;
        }
      }

      const tools: ToolDef[] = (requestBody.tools ?? []).map(t => ({
        name: t.function?.name ?? "unknown",
        description: t.function?.description ?? "",
        parameters: t.function?.parameters ?? {},
      }));

      const multimodalMessages: ChatHistoryItem[] = requestBody.messages.map(m => mapMessageToHistoryItem(m));
      const requestedMaxTokens = typeof requestBody.max_tokens === "number" && requestBody.max_tokens > 0 ? requestBody.max_tokens : 128_000;
      const isStreaming = requestBody.stream !== false;

      if (isStreaming) {
        // SSE streaming response
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        const responseId = `chatcmpl-${crypto.randomUUID()}`;
        const abort = new AbortController();
        req.on("close", () => { if (!res.writableEnded) abort.abort(); });

        try {
          let firstChunkSent = false;
          let toolCallIndex = -1;
          const toolIdToIndex = new Map<string, number>();
          let lastToolCallId: string | undefined;
          let finishReason: "stop" | "tool_calls" | "length" | "content_filter" | null = null;
          let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null = null;

          for await (const ev of streamChatEventsWithRetry({
            apiKey: creds.apiKey,
            apiServerUrl: creds.apiServerUrl,
            modelUid,
            messages: multimodalMessages,
            tools: tools.length > 0 ? tools : undefined,
            signal: abort.signal,
            completionOpts: { maxOutputTokens: requestedMaxTokens },
          })) {
            const role = firstChunkSent ? undefined : "assistant";

            if (ev.kind === "text") {
              const chunk = { id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestBody.model ?? modelUid, choices: [{ index: 0, delta: role ? { role, content: ev.text } : { content: ev.text }, finish_reason: null }] };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              firstChunkSent = true;
            } else if (ev.kind === "reasoning") {
              const chunk = { id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestBody.model ?? modelUid, choices: [{ index: 0, delta: role ? { role, reasoning: ev.text } : { reasoning: ev.text }, finish_reason: null }] };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              firstChunkSent = true;
            } else if (ev.kind === "tool_call_start") {
              toolCallIndex += 1;
              toolIdToIndex.set(ev.id, toolCallIndex);
              lastToolCallId = ev.id;
              const baseDelta = { tool_calls: [{ index: toolCallIndex, id: ev.id, type: "function", function: { name: ev.name, arguments: "" } }] };
              const delta = firstChunkSent ? baseDelta : { role: "assistant", ...baseDelta };
              const chunk = { id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestBody.model ?? modelUid, choices: [{ index: 0, delta, finish_reason: null }] };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              firstChunkSent = true;
            } else if (ev.kind === "tool_call_args") {
              if (lastToolCallId === undefined || toolCallIndex < 0) continue;
              const routeKey = ev.id ?? lastToolCallId;
              const idx = toolIdToIndex.get(routeKey) ?? toolCallIndex;
              const chunk = { id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestBody.model ?? modelUid, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: ev.argsDelta } }] }, finish_reason: null }] };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            } else if (ev.kind === "finish") {
              finishReason = ev.reason;
            } else if (ev.kind === "usage") {
              usage = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens, totalTokens: ev.totalTokens };
            }
          }

          // Cognition sometimes reports "stop" even when the model made tool
          // calls — clients (Zed) would end the turn without executing them.
          const finalReason = toolCallIndex >= 0 && (finishReason === null || finishReason === "stop")
            ? "tool_calls"
            : finishReason ?? (toolCallIndex >= 0 ? "tool_calls" : "stop");
          const finishChunk = { id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestBody.model ?? modelUid, choices: [{ index: 0, delta: {}, finish_reason: finalReason }] };
          res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);

          if (usage) {
            const usageChunk = { id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestBody.model ?? modelUid, choices: [], usage: { prompt_tokens: usage.promptTokens ?? 0, completion_tokens: usage.completionTokens ?? 0, total_tokens: usage.totalTokens ?? 0 } };
            res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
          logCost(modelUid, usage, keyPolicy);
          logBalance(creds);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          const hint = looksLikeToolBlockError(errorMessage)
            ? " (tool-description blocklist hit — extend POISON_PHRASES in toolblock.ts)"
            : "";
          console.error(`[windsurf] CHAT ERROR (${modelUid}): ${errorMessage}${hint}`);
          try {
            res.write(`data: ${JSON.stringify({ error: { message: errorMessage } })}\n\n`);
            const fChunk = { id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestBody.model ?? modelUid, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
            res.write(`data: ${JSON.stringify(fChunk)}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          } catch { /* socket dead */ }
        }
      } else {
        // Non-streaming response
        let collected = "";
        let finishReason: "stop" | "tool_calls" | "length" | "content_filter" = "stop";
        let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null = null;
        type CollectedToolCall = { id: string; name: string; args: string };
        const collectedToolCalls: CollectedToolCall[] = [];
        let currentToolCall: CollectedToolCall | null = null;

        const abort = new AbortController();
        req.on("close", () => { if (!res.writableEnded) abort.abort(); });
        for await (const ev of streamChatEventsWithRetry({
          apiKey: creds.apiKey,
          apiServerUrl: creds.apiServerUrl,
          modelUid,
          messages: multimodalMessages,
          tools: tools.length > 0 ? tools : undefined,
          completionOpts: { maxOutputTokens: requestedMaxTokens },
          signal: abort.signal,
        })) {
          if (ev.kind === "text") collected += ev.text;
          else if (ev.kind === "tool_call_start") { currentToolCall = { id: ev.id, name: ev.name, args: "" }; collectedToolCalls.push(currentToolCall); }
          else if (ev.kind === "tool_call_args") { if (currentToolCall) currentToolCall.args += ev.argsDelta; }
          else if (ev.kind === "finish") finishReason = ev.reason;
          else if (ev.kind === "usage") usage = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens, totalTokens: ev.totalTokens };
        }
        if (collectedToolCalls.length > 0 && finishReason === "stop") finishReason = "tool_calls";

        const assistantMessage = collectedToolCalls.length > 0
          ? { role: "assistant" as const, content: collected, tool_calls: collectedToolCalls.map(tc => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args } })) }
          : { role: "assistant" as const, content: collected };

        const resp = {
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: requestBody.model ?? modelUid,
          choices: [{ index: 0, message: assistantMessage, finish_reason: finishReason }],
          ...(usage ? { usage: { prompt_tokens: usage.promptTokens ?? 0, completion_tokens: usage.completionTokens ?? 0, total_tokens: usage.totalTokens ?? 0 } } : {}),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resp));
        logCost(modelUid, usage, keyPolicy);
        logBalance(creds);
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Unsupported path: ${url.pathname}` } }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[windsurf] REQUEST ERROR: ${message}`);
    try {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message } }));
    } catch {}
  }
}

// ----------------------------------------------------------------------------
// Server startup
// ----------------------------------------------------------------------------

let serverInstance: ReturnType<typeof createServer> | null = null;

export function startProxy(port: number = WINDSURF_PROXY_PORT, host: string = WINDSURF_PROXY_HOST): Promise<number> {
  if (serverInstance) return Promise.resolve((serverInstance.address() as { port: number }).port);

  return new Promise((resolve, reject) => {
    const srv = createServer(handleRequest);
    srv.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[windsurf] port ${port} is busy — picking a random free port instead. Use --port to pin one.`);
        // Try fallback port
        srv.listen(0, host, () => {
          const addr = srv.address() as { port: number };
          serverInstance = srv;
          resolve(addr.port);
        });
        return;
      }
      reject(err);
    });
    srv.listen(port, host, () => {
      serverInstance = srv;
      const addr = srv.address() as { port: number };
      resolve(addr.port);
    });
  });
}

export function stopProxy(): void {
  if (serverInstance) {
    try { serverInstance.close(); } catch {}
    serverInstance = null;
  }
}
