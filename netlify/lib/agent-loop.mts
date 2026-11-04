// Shared agent loop: Claude decides which tools to call. We run them, return results, and repeat
// until the agent calls its finish tool, hits MAX_TURNS, or runs out of time.
import Anthropic from "@anthropic-ai/sdk";
import { AGENT_DEADLINE_MS, EFFORT, MAX_TURNS, MODEL, REQUEST_TIMEOUT_MS } from "./config.mts";

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  /** Returns a short result string for the model. Throw ToolError to send back an error result. */
  run: (input: any) => string | Promise<string>;
  /** Calling this tool successfully ends the run. */
  finish?: boolean;
}

/** An error the agent should see and can recover from (e.g. "quote not found, search again"). */
export class ToolError extends Error {}

export interface TraceStep {
  turn: number;
  kind: "tool" | "note" | "system";
  tool?: string;
  input?: unknown;
  result: string;
  isError?: boolean;
  at: string;
}

export interface AgentRun {
  status: "finished" | "needs_human_review";
  reason: string | null;
  turns: number;
  trace: TraceStep[];
}

const short = (s: string, n = 240) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

let sharedClient: Anthropic | null = null;
function client() {
  // The SDK reads ANTHROPIC_API_KEY from process.env. It is never logged or returned to the browser.
  sharedClient ??= new Anthropic({ timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
  return sharedClient;
}

export async function runAgent(
  systemPrompt: string,
  tools: AgentTool[],
  input: string,
  onStep: (step: TraceStep) => void | Promise<void> = () => {},
  anthropic: Anthropic = client(),
): Promise<AgentRun> {
  const started = Date.now();
  const trace: TraceStep[] = [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const toolDefs: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    strict: true,
  }));
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: input }];

  const record = async (step: Omit<TraceStep, "at">) => {
    const s = { ...step, at: new Date().toISOString() };
    trace.push(s);
    await onStep(s);
  };
  const stop = async (reason: string, turns: number): Promise<AgentRun> => {
    await record({ turn: turns, kind: "system", result: `Stopped: ${reason}. Needs human review.` });
    return { status: "needs_human_review", reason, turns, trace };
  };

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (Date.now() - started > AGENT_DEADLINE_MS) return stop("time limit reached", turn - 1);

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: systemPrompt,
      tools: toolDefs,
      tool_choice: { type: "auto" },
      output_config: { effort: EFFORT },
      cache_control: { type: "ephemeral" },
      messages,
    });
    // Append the full content (including thinking blocks) unchanged, as the API requires.
    messages.push({ role: "assistant", content: response.content });

    for (const b of response.content) {
      if (b.type === "text" && b.text.trim()) await record({ turn, kind: "note", result: short(b.text.trim(), 400) });
    }

    if (response.stop_reason === "refusal") return stop("the model declined this request", turn);
    if (response.stop_reason === "max_tokens") return stop("response was cut off", turn);

    const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (calls.length === 0) {
      // The agent replied without a tool call. Nudge it to keep working or finish.
      messages.push({ role: "user", content: "Continue using your tools. When you're done, call your finish tool." });
      continue;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let finished = false;
    for (const call of calls) {
      const tool = byName.get(call.name);
      let content: string;
      let isError = false;
      try {
        if (!tool) throw new ToolError(`Unknown tool ${call.name}`);
        content = await tool.run(call.input ?? {});
        if (tool.finish) finished = true;
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        content = `Error: ${e.message}`;
        isError = true;
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content, is_error: isError || undefined });
      await record({ turn, kind: "tool", tool: call.name, input: call.input, result: short(content), isError });
    }
    // All tool results for the turn go back in a single user message.
    messages.push({ role: "user", content: results });
    if (finished) return { status: "finished", reason: null, turns: turn, trace };
  }
  return stop(`reached the ${MAX_TURNS}-turn limit`, MAX_TURNS);
}
