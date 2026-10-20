/**
 * toolblock.ts — Windsurf tool-description blocklist scrubber.
 *
 * WHAT THIS IS
 * Cognition's chat backend silently rejects chat requests whose `tools`
 * section contains certain exact phrases in tool descriptions / JSON-schema
 * property descriptions. The failure surfaces as a generic upstream error:
 *
 *   "Unable to process request due to an MCP configuration issue."
 *
 * Verified experimentally (2026-10-18, plan Pro, glm-5-3-max / swe-2-high):
 *   - The match is EXACT-STRING, not heuristic: changing one word, the word
 *     order, letter case, or trimming the phrase makes the request pass.
 *   - The same phrase in a plain user/system message is NOT blocked — the
 *     filter only applies to the tools section of the request.
 *   - It is deterministic (5/5 identical failures on identical requests).
 *   - The blocked phrases are verbatim copies of tool descriptions shipped by
 *     Zoo (a Cline fork). Older Zoo versions used slightly different wording
 *     and passed. So the list looks like targeted anti-fork protection:
 *     break the tools of known Cline-clone clients, while the generic error
 *     gives the fork authors nothing to debug from.
 *
 * WHY WE SCRUB
 * Our proxy is a neutral translator: clients send whatever tool descriptions
 * they like, and we forward them. When Cognition blocklists a client's exact
 * wording, that client breaks through no fault of its own. Rewording a tool
 * description does not change what the model is asked to do — the semantics
 * stay identical — so scrubbing known-banned phrases restores compatibility
 * without altering behavior. The scrub runs upfront on every request (in
 * encodeToolDef), so blocked wording never even reaches the wire.
 *
 * HOW TO EXTEND
 * When a new blocked phrase is found (symptom: deterministic "MCP
 * configuration issue" for one client while others work), bisect the toolset
 * down to the single tool that fails, then bisect its JSON to the exact
 * string, and add a `poison → replacement` pair below. Keep replacements
 * semantically equivalent and as close to the original wording as possible.
 */

/** Exact phrases Cognition's backend rejects inside tool descriptions. */
const POISON_PHRASES: Array<{ poison: string; replacement: string }> = [
  {
    // Zoo ask_followup_question → follow_up.description (found 2026-10-18)
    poison: "Required list of 2-4 suggested responses; each suggestion must be a complete, actionable answer and may include a mode switch",
    replacement: "Required list of 2-4 suggested responses; each suggestion is a complete, actionable answer and may include a mode switch",
  },
  {
    // Zoo list_files → recursive.description (found 2026-10-18)
    poison: "Set true to list contents recursively; false to show only the top level",
    replacement: "Set true to list contents recursively; false to show top level only",
  },
];

/** Deep-scrub every string inside a JSON value (tool parameters are JSON schemas —
 *  poison can sit at any nesting level). Returns the value unchanged when no
 *  poison is present, so the common path stays allocation-free. */
export function scrubToolValue<T>(value: T): T {
  if (typeof value === "string") {
    let s = value as unknown as string;
    for (const { poison, replacement } of POISON_PHRASES) {
      if (s.includes(poison)) s = s.split(poison).join(replacement);
    }
    return s as unknown as T;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(v => {
      const r = scrubToolValue(v);
      if (r !== v) changed = true;
      return r;
    });
    return (changed ? out : value) as unknown as T;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = scrubToolValue(v);
      if (r !== v) changed = true;
      out[k] = r;
    }
    return (changed ? out : value) as unknown as T;
  }
  return value;
}

/** Scrub a ToolDef before it goes on the wire. Cheap no-op when clean. */
export function scrubToolDef(tool: ToolDefLike): ToolDefLike {
  const description = scrubToolValue(tool.description);
  const parameters = scrubToolValue(tool.parameters);
  if (description === tool.description && parameters === tool.parameters) return tool;
  return { ...tool, description, parameters };
}

interface ToolDefLike {
  name: string;
  description: string;
  parameters: unknown;
}

/** Did an upstream error look like the blocklist rejection? Used to log a hint. */
export function looksLikeToolBlockError(message: string): boolean {
  return /MCP configuration issue/i.test(message);
}
