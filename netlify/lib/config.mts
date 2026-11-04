// Central agent settings. Switch MODEL to "claude-sonnet-5-5" for stronger (slower) agents.
export const MODEL = "claude-haiku-5-5";

// Thinking depth per turn. "low" keeps each turn fast for the 60s function limit.
export const EFFORT = "low" as const;

// The loop stops after this many model turns and returns "needs human review".
export const MAX_TURNS = 8;

// Netlify synchronous functions stop at 60s. The loop won't start a new turn after this,
// so the function always has time to save its result and respond.
export const AGENT_DEADLINE_MS = 45_000;

// Per-request timeout for one Messages API call.
export const REQUEST_TIMEOUT_MS = 25_000;
