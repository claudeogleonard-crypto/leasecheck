// Runs the risk agent for one review (POST {id}). Streams the agent's steps as NDJSON.
import type { Config } from "@netlify/functions";
import { handleAgent } from "../lib/agent-endpoint.mts";

export default (req: Request) => handleAgent("risk", req);

export const config: Config = {
  path: "/api/agents/risk",
  method: "POST",
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
