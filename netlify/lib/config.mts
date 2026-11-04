// Central agent settings. Switch MODEL to "claude-sonnet-5-5" for stronger (slower) agents.
export const MODEL = "claude-haiku-5-5";

// Thinking depth per turn. "low" keeps each turn fast for the 60s function limit.
export const EFFORT = "low" as const;

// The loop stops after this many model turns and returns "needs human review".
export const MAX_TURNS = 8;

// Netlify cuts this site's functions off at 30s (measured on the live deploy). The loop won't
// start a new turn after 18s, and each model call times out at 10s with no retry, so a run
// always ends (worst case about 28s) with time to save its result.
export const AGENT_DEADLINE_MS = 18_000;
export const REQUEST_TIMEOUT_MS = 10_000;
