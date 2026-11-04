# LeaseCheck

AI-assisted lease review for CU Boulder Off-Campus Housing. Students paste or upload a lease, and three tool-using Claude agents review it on the server. A follow-up automation queues risky leases for a Student Legal Services attorney.

> LeaseCheck gives educational guidance, not legal advice.

## How it works

LeaseCheck uses three **tool-using agents**. Each one is a loop in which Claude picks its next tool call, sees the result, and keeps going until it calls its finish tool.

```
Student page ─POST /api/reviews──────▶ reviews-create     stores lease text (PDFs converted with unpdf) → id
      │
      ├─POST /api/agents/extraction──▶ agent-extraction   ┐ each is its own Netlify Function,
      ├─POST /api/agents/risk────────▶ agent-risk         │ called in sequence by the browser;
      ├─POST /api/agents/triage──────▶ agent-triage       ┘ each streams its steps live (NDJSON)
      │                                      │ triage finished
      │                                      ▼
      └─(result in triage stream) ◀── automation          separate module run after triage: save → queue → slot → notify
```

| Agent | Tools | Finishes when |
|---|---|---|
| Extraction | `search_lease`, `record_field`, `flag_unclear`, `finish_extraction` | rent, deposit, fees, lease length, tenants and bedrooms are each recorded with a quote or flagged unclear, plus at least two notable clauses |
| Risk | `lookup_rule` (reads `data/rules.json`), `check_occupancy`, `search_lease`, `add_flag`, `set_risk_rating` | it sets a rating (at least one rule checked; the rating can't be lower than the worst flag) |
| Triage | `get_flags`, `get_attorney_availability` (reads `data/attorney-slots.json`), `decide_route`, `write_student_summary`, `draft_landlord_questions`, `finish_triage` | route, summary and questions are all saved |

- **Shared loop:** `runAgent(systemPrompt, tools, input)` in `netlify/lib/agent-loop.mts`. It calls the Messages API with the tools, runs every `tool_use`, returns all `tool_result`s in one message, and repeats. It stops at the finish tool, after **8 turns**, or at a **10-second limit on starting new turns**; the last two return "needs human review". Every step is saved to a trace that the UI shows as a timeline.
- **Guardrails in the tools:** quotes must actually appear in the lease, or the tool returns an error and the agent searches again. Finish tools reject incomplete work. `decide_route` refuses `summary_only` when the policy requires an attorney: any medium or high rating, any unclear field, or an agent that didn't finish. The code enforces the same policy again after the agent returns.
- **Model:** one constant in `netlify/lib/config.mts`: `MODEL = "claude-haiku-5-5"`, effort `low`. Change it to `"claude-sonnet-5-5"` for stronger, slower agents.
- **API key:** read from `process.env.ANTHROPIC_API_KEY` by the SDK, inside functions only. It is never logged or sent to the browser.
- **Timeouts:** this site's functions are cut off at about 30 seconds (measured on the live deploy). Each agent runs in its own request. The loop won't start a new turn after 10 seconds, and each model call times out at 18 seconds with no retry, so a run always ends cleanly. If an agent runs out of time, the review is routed to an attorney ("needs human review") rather than failing. If that happens often (for example with Sonnet), move the agents to background functions with polling.
- **Storage:** Netlify Blobs (`reviews`, `lease-inputs`, `attorney-queue`, `appointments`, `notifications`). Slot holds use `onlyIfNew`, so two reviews can't claim the same slot.

## Project layout

```
public/                 static site (no build step)
  index.html, app.js    student page
  staff.html, staff.js  staff dashboard (/staff)
  render.js, styles.css shared rendering and styles (light and dark)
  samples/              clean, medium-risk, and high-risk sample leases
data/                   rules.json and attorney-slots.json (sample data)
netlify/functions/      reviews-create, agent-extraction, agent-risk, agent-triage, review-status,
                        staff
netlify/lib/            agent-loop, agents/{extraction,risk,triage}, lease-search, config,
                        store, scheduling, notify, automation, http helpers
tests/                  agent loop (scripted fake client), search, quotes, occupancy, routing, slots
```

## Local development

```bash
npm install
```

```bash
cp .env.example .env   # then fill in ANTHROPIC_API_KEY and STAFF_PASSWORD
```

```bash
npx netlify-cli dev    # http://localhost:8888, staff dashboard at /staff
```

```bash
npm test && npm run typecheck
```

`.env` is in `.gitignore`. Never commit it.

## Deploy to Netlify

1. Push this repo to GitHub, then in Netlify choose **Add new project → Import an existing project** and pick the repo. `netlify.toml` already sets publish = `public` and functions = `netlify/functions`.
2. Under **Site configuration → Environment variables**, add these with the **Functions** scope:
   - `ANTHROPIC_API_KEY` (required)
   - `STAFF_PASSWORD` (required for `/staff`)
   - Optional: `RESEND_API_KEY` + `NOTIFY_FROM_EMAIL` + `STAFF_NOTIFY_EMAIL` (email), `NOTIFY_WEBHOOK_URL` (Slack/Teams)
3. Deploy. Environment variable changes need a redeploy.

Or deploy from the CLI: `npx netlify-cli deploy --prod`.

Without email or webhook settings, notifications are still recorded and shown on the dashboard with delivery `skipped`.

## Sample leases

| File | Expected result |
|---|---|
| `public/samples/clean-lease.txt` | Low risk: Colorado-compliant late fee, 30-day deposit return, individual liability, rental license listed |
| `public/samples/medium-risk-lease.txt` | Medium risk: joint liability for 4 people, flat utility fee, 90-day auto-renewal, 2-month lease-break fee, mandatory carpet charge, outdated unrelated-person clause |
| `public/samples/high-risk-lease.txt` | High risk: habitability waiver, day-2 escalating late fees, non-refundable deposit, 90-day deposit return, 7 people in 3 bedrooms plus basement, instruction to conceal occupants, unlimited entry, injection attempt |

All three are on the student page as "Try a sample" buttons.

## Notes and next steps for production

- **Staff auth** is a shared password. For production, use Netlify Identity or university SSO.
- **Legal content** in `data/rules.json` and the agent prompts reflects Colorado law as of late 2026: C.R.S. 38-12-105 late fees, 38-12-103 deposits, the warranty of habitability, and HB24-1007, which ended unrelated-occupant caps. Have Student Legal Services review it periodically.
- **Privacy:** leases contain personal information and are stored in Blobs, so set a retention policy. Site-wide Blobs stores are shared with deploy previews, so don't submit test leases on previews.
- **Cost:** each review is about 6 to 12 Haiku calls. Submissions are rate-limited per IP.
