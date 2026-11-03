# LeaseCheck

AI-assisted lease review for CU Boulder Off-Campus Housing. Students paste or upload a lease. Three Claude agents review it on the server. A follow-up automation queues risky leases for a Student Legal Services attorney.

> LeaseCheck gives educational guidance, not legal advice.

## How it works

```
Student page ──POST /api/reviews──▶ reviews-create   (validates input, stores it, returns 202 + id)
      ▲                                   │ internal call
      │ polls /api/reviews/:id            ▼
      │                            review-pipeline   (background function, up to 15 min)
      │                              1. Extraction agent → rent, deposit, fees, term, tenants, clauses (JSON)
      │                              2. Risk agent       → flagged clauses, Boulder occupancy, low/medium/high
      │                              3. Triage agent     → attorney yes/no, plain-language summary, landlord questions
      │                                   │ "review finished" event
      │                                   ▼
      └──────────────────────────── review-completed  (background automation, idempotent, retried on failure)
                                     • save the record
                                     • add high-risk leases (and any lease triage sends for review) to the attorney queue
                                     • hold the next open attorney slot (Tue/Thu afternoons, MT)
                                     • notify staff (email/webhook) and the student (email), and log every notification
Staff dashboard ──/api/staff/*──▶ staff             (password-protected: queue, reviews, notifications, slot confirmation)
```

- **The API key stays on the server.** It is read with `Netlify.env.get("ANTHROPIC_API_KEY")` inside functions only. The browser never sees it.
- **Model:** `claude-opus-5-5` with adaptive thinking, structured JSON outputs (strict schemas in `netlify/lib/schemas.mts`), streaming, and server-side refusal fallback (`fallbacks: "default"`).
- **PDFs** are sent to Claude as native document blocks, so scanned PDFs work too.
- **Policy guardrail:** if the risk is high or any flag is high severity, the code forces `attorney_review_needed = true`, whatever the model says.
- **Prompt-injection hardening:** lease text is treated as untrusted data. The high-risk sample includes an injection attempt to test this.
- **Storage:** Netlify Blobs (`reviews`, `lease-inputs`, `attorney-queue`, `appointments`, `notifications`). Slot holds use `onlyIfNew`, so two reviews can't claim the same slot.

## Project layout

```
public/                 static site (no build step)
  index.html, app.js    student page
  staff.html, staff.js  staff dashboard (/staff)
  render.js, styles.css shared rendering and styles (light and dark)
  samples/              clean, medium-risk, and high-risk sample leases
netlify/functions/      reviews-create, review-status, review-pipeline (bg), review-completed (bg), staff
netlify/lib/            agents, prompts, schemas, store, scheduling, notify, automation, http helpers
tests/                  unit tests for scheduling, triage rules, queue logic, schemas
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
   - Optional: `INTERNAL_SECRET`, `RESEND_API_KEY` + `NOTIFY_FROM_EMAIL` + `STAFF_NOTIFY_EMAIL` (email), `NOTIFY_WEBHOOK_URL` (Slack/Teams)
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
- **Legal content** in `netlify/lib/prompts.mts` reflects Colorado law as of late 2026: C.R.S. 38-12-105 late fees, 38-12-103 deposits, the warranty of habitability, and HB24-1007, which ended unrelated-occupant caps. Have Student Legal Services review it periodically.
- **Privacy:** leases contain personal information and are stored in Blobs, so set a retention policy. Site-wide Blobs stores are shared with deploy previews, so don't submit test leases on previews.
- **Cost:** each review is three Opus calls. `reviews-create` is rate-limited to 10 requests per minute per IP.
