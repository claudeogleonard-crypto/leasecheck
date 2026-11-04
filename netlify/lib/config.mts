// Central agent settings. Switch MODEL to "claude-sonnet-5-5" for stronger (slower) agents.
export const MODEL = "claude-haiku-5-5";

// Thinking depth per turn. "low" keeps each turn fast for the 60s function limit.
export const EFFORT = "low" as const;

// The loop stops after this many model turns and returns "needs human review".
export const MAX_TURNS = 8;

// Netlify cuts this site's functions off at 30s (measured on the live deploy). One large agent
// turn can take 10-17s, so: no new turn after 10s, each model call times out at 18s with no retry.
// Worst case about 28s, leaving time to save the result.
export const AGENT_DEADLINE_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 18_000;
