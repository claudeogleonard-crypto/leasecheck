// Runs the extraction agent for one review (POST {id}). Streams the agent's steps as NDJSON.
import type { Config } from "@netlify/functions";
import { handleAgent } from "../lib/agent-endpoint.mts";

export default (req: Request) => handleAgent("extraction", req);

export const config: Config = {
  path: "/api/agents/extraction",
  method: "POST",
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
