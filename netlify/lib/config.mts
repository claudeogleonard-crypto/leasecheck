// Central agent settings. Switch MODEL to "claude-sonnet-5-5" for stronger (slower) agents.
export const MODEL = "claude-haiku-5-5";

// Thinking depth per turn. "low" keeps reviews quick; raise to "medium" for more careful agents.
export const EFFORT = "low" as const;

// The loop stops after this many model turns and returns "needs human review".
export const MAX_TURNS = 8;

// Agents run in one background function (15-minute limit), so they get room to finish properly.
// Worst case per agent: no new turn after 2.5 min, plus one call of up to 2 x 60s (one retry),
// so all three agents stay under ~13.5 min.
export const AGENT_DEADLINE_MS = 150_000;
export const REQUEST_TIMEOUT_MS = 60_000;
export const MAX_RETRIES = 1;
