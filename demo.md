# Demo Briefing — Invoice Processing Agent (Client CTO + Leadership)

## Context
This is the demo briefing for the invoice-processing agentic workflow, presented live to a client's CTO, business leaders, and engineers. It is positioned honestly as a **working prototype**, not production. Every claim below is grounded in a full read of the actual codebase (`app/agent.py`, `app/nodes.py`, `app/config.py`, `app/cost_calculator.py`, `app/gmail_tools.py`, `app/a2ui_views.py`, `frontend/`), so it is defensible if a sharp engineer cross-checks. It covers: (1) what the system really does and where the narrative could outrun the code, (2) anticipated Q&A with business-first answers + technical backup, (3) a polished live-demo storyline, and (4) a separate narration for the conceptual architecture slide.

---

## Part 1 — Codebase Reality Check (what's true, and where to be careful)

### The pipeline as actually built
It's an **ADK 2.0 Workflow DAG** (not a free-roaming "orchestrator agent") — a deterministic graph where each node runs, writes shared state, and emits a `route` that selects the next edge (`app/agent.py:343-410`). There are **six functional stages**, not five — the README is outdated:

1. **Intake** — `fetch_invoice_email` (deterministic) pulls the email + PDF. `check_inbox` gates found/not-found.
2. **Screening / Noise Elimination** — `noise_eliminator_agent` (LLM) reads the email + PDF and decides "is this really an invoice?" before any expensive extraction. `screen_email_signal` routes invoice vs. discard.
3. **Extraction** — `extraction_agent` (LLM, multimodal) reads the PDF natively and returns a structured `InvoiceRecord` with **per-field confidence scores**.
4. **Validation** — `validate_invoice` (deterministic rule engine) applies AP rules and routes `proceed` / `human_review` / `duplicate_po`.
5. **Human-in-the-loop** — `human_approval_gate` (real pause/resume) when rules flag risk; on reject, an LLM drafts a vendor email that a human reviews/edits in a second HITL loop before it sends.
6. **Classify & Post** — `classify_spend` looks up the PO and routes **Direct → SAP CIMS** or **Indirect → Coupa AP**; `post_to_sap` / `post_to_coupa` post; duplicates go to `raise_duplicate_alert` (ServiceNow).

**Composition: 3 LLM agents + 16 deterministic FunctionNodes.** This is the single most important architectural point — see Q&A.

### Deterministic vs. LLM (know this cold)
- **LLM reasoning (3 places only):** screening, extraction, rejection-email drafting.
- **Everything else is deterministic Python:** all validation rules, thresholds, duplicate checks, currency conversion, PO lookup/classification, routing, and posting. **No LLM ever decides whether to pay, approve, or reject.** The model reads documents; rules and humans decide.

### Models actually assigned
All three agents run **`gemini-2.5-flash-lite`** (`app/agent.py:160, 210, 257`). Models are runtime-switchable across `{2.5-pro, 2.5-flash, 2.5-flash-lite}` via `POST /config/model` (`app/agent.py:101-106, 328-336`) — you can change the model live without a restart, which is a great demo moment for the cost card.

### Cost tracking is real (and defensible)
- Real token counts are captured per agent from `usage_metadata` via model callbacks (`app/agent.py:109-139`).
- When tokens aren't available (e.g. `MOCK_INVOICE=true`), it falls back to documented static estimates and **flags the figure as estimated** (`app/cost_calculator.py:56-62`).
- The Cost Projection card shows the live model's actual cost **and projects the same workload across Pro / Flash / Flash-Lite**, plus a per-1,000-invoice extrapolation (`frontend/.../CostProjectionCard.tsx`). Frontend pricing mirrors backend exactly — no discrepancy.
- Pricing constants (USD per 1M tokens): Pro `$1.25 in / $10.00 out`; Flash `$0.30 / $2.50`; Flash-Lite `$0.10 / $0.40` (`app/cost_calculator.py:30-46`).

### Confidence & thresholds (verified in `app/config.py:77-85`)
- Field confidence floor **0.75**; overall extraction floor **0.70**.
- Invoice-signal floor (screening) **0.5**.
- Auto-approval ceiling **$4,000** USD-equivalent; hard HITL escalation **$10,000**.
- Amounts normalized to USD via a **static demo FX table** (`config.py:90-105`) — not live FX. Say "indicative FX" if asked.

### Validation rules actually implemented (`app/nodes.py:638-701`)
Duplicate invoice # / duplicate PO # (→ ServiceNow), required-field presence (`vendor, invoice_no, po_ref, total`), total > 0 sanity, overall-confidence floor, per-field-confidence floor, $4k auto-approval limit, $10k HITL escalation. Covered by named unit tests S1–S8 (`tests/unit/test_scenarios.py`) — point engineers here; it signals real engineering rigor.

### PO matching — be precise with words
`classify_spend` is a **PO lookup + spend classification** (Direct vs Indirect), **not a 2-way/3-way match**. It checks the PO exists in a ledger and reads its type; it does **not** validate amount/qty against the PO. Unmatched POs **default to Indirect/Coupa** (`app/nodes.py:868-876`). Don't call it "three-way match" — an AP-literate engineer will catch it. Call it "PO classification and routing," with 3-way match as a clearly-named roadmap item.

### Prototype boundaries — REAL vs STUBBED (be candid internally)
| Capability | Status | Note |
|---|---|---|
| Gmail intake | **Real API**, mocked by default | `MOCK_INVOICE=true` serves a bundled PDF; flip to `false` for live inbox. Extraction is *always* real. |
| Screening (Gemini) | **Real** | Live model call. |
| Extraction (Gemini) | **Real** | Live multimodal call; confidence is genuine. |
| Validation / rules / routing | **Real** | Fully deterministic, tested. |
| HITL approval + email review/edit | **Real** | Genuine pause/resume; human edits persist. |
| Rejection email send | **Real** | Gmail compose API. |
| **SAP CIMS posting** | **Stubbed** | Returns synthetic doc ID; no real BAPI/OData. `app/nodes.py:910-956`. |
| **Coupa AP posting** | **Stubbed** | Synthetic doc ID; no real REST call. `:963-1006`. |
| **ServiceNow escalation** | **Stubbed** | Synthetic ticket ID. `:1013-1058`. |
| **S/4HANA PO ledger** | **Synthetic** | 40 hardcoded POs (`config.py:188-231`). |

**One-line honest framing for the room:** "The intelligence layer — reading, judging, and routing invoices with a human in the loop — is real and running live. The final writes into SAP, Coupa, and ServiceNow are connected as controlled stubs in this prototype; wiring them to your live system-of-record is a scoped integration step, deliberately last because that's where governance and credentials live."

### Gaps where narrative could outrun code (pre-empt these)
1. **"Five stages"** → say **six** (screening is live). Don't read off the old README.
2. **"Root Orchestrator agent"** (on the slide) → it's a **deterministic workflow graph**, which is *safer* than an LLM orchestrator. Frame as a strength (predictable, auditable control flow).
3. **"Three-way match"** → it's PO classification/routing today.
4. **"Posts to SAP/Coupa"** → posts to **stubbed connectors**; real writes are the next integration.
5. **Model names on slide** (3.5 Flash / 3.1 Flash-Lite) → real model is **Gemini 2.5 Flash-Lite** across all agents; the others are shown only as cost comparisons.
6. **Live FX** → it's an indicative static table.

---

## Part 2 — Anticipated Q&A
*(Each: business-first answer, then technical backup for the engineers.)*

**Q1. Why did you build this? What's the problem?**
- *Business:* AP teams spend most of their time on low-value manual work — reading invoices, keying data, chasing POs, routing approvals. It's slow, error-prone, and doesn't scale with volume. This agent does the reading, checking, and routing automatically and only pulls a human in when judgment is genuinely needed.
- *Technical:* The workflow automates intake→extraction→validation→classification→posting with exception-based HITL, so straight-through-eligible invoices flow untouched and humans focus on the flagged minority.

**Q2. What's the ROI?**
- *Business:* Value comes from three levers: (1) labor reallocated from manual keying to exception handling, (2) faster cycle time (capture early-payment discounts, avoid late fees), and (3) fewer errors/duplicate payments. The cost to run the AI is a rounding error against those — see Q on cost.
- *Technical:* Per-invoice model cost on the live model is fractions of a cent (Q6). The economic case is dominated by labor and error-avoidance, not compute. We can model your specific ROI once we have your invoice volume, current touch-time, and exception rate.

**Q3. How do you ensure reliability / that it won't pay the wrong thing?**
- *Business:* The AI never decides to pay. It reads and proposes; deterministic business rules and a human approver make the decisions. Anything uncertain, high-value, duplicate, or incomplete is automatically routed to a person.
- *Technical:* Only 3 of 19 nodes are LLM-based, and all three are *read/draft* roles. Approve/reject/route/post are deterministic Python (`validate_invoice`, `classify_spend`) governed by explicit thresholds, with named unit tests (S1–S8). Confidence below 0.70 overall / 0.75 per-field, totals over $4k, missing fields, or duplicates all force human review.

**Q4. Why Gemini 2.5 Flash-Lite — why not the most powerful model (Pro)?**
- *Business:* We match the model to the job. The task is structured document reading, not open-ended reasoning, so the lightest capable model gives near-identical quality at a fraction of the cost. And anything the model is unsure about is caught by the confidence gate and sent to a human — so we don't need to "buy certainty" with a bigger model.
- *Technical:* All three agents run Flash-Lite. Models are hot-swappable per agent via `POST /config/model` across Pro/Flash/Flash-Lite — so we can dial up to Flash or Pro for harder document classes if eval data justifies it. The cost card quantifies that trade-off live.

**Q5. How did you choose Flash vs Flash-Lite vs Pro across stages?**
- *Business:* It's an evidence-based, per-stage decision, not one-size-fits-all. Today every stage uses the most economical model because the documents are well-structured; we can promote individual stages if accuracy data warrants.
- *Technical:* Architecture supports per-agent model assignment (`set_agent_model`). Our tuning loop (`agents-cli eval generate/grade/compare`) lets us A/B a stage on Flash vs Flash-Lite against a labeled set before committing. Flash-Lite is the floor; Pro is available for, e.g., low-quality scans or complex multi-page tax docs.

**Q6. What's the cost profile per stage / per invoice?**
- *Business:* On the live model, a typical invoice costs a fraction of a cent end-to-end. Even at thousands of invoices a day, the AI spend is negligible next to the labor it saves — and the screening stage means we don't spend a cent of extraction cost on spam/non-invoices.
- *Technical:* Real token counts are captured per agent (`usage_metadata`). At Flash-Lite rates ($0.10 in / $0.40 out per 1M tokens) and ~5k input / ~1k output tokens across the three agents, that's well under a cent/invoice. The cost card shows the live figure, projects Pro/Flash for the same tokens, and extrapolates to per-1,000-invoices. Estimated figures are explicitly flagged when running on mocked intake.

**Q7. What happens when extraction is wrong or low-confidence?**
- *Business:* The system knows what it doesn't know. Every extracted field carries a confidence score; anything below our bar is flagged and a human confirms before anything proceeds. Nothing low-confidence slips through silently.
- *Technical:* Per-field + overall confidence thresholds (0.75 / 0.70) in `_check_rules` route to `human_approval_gate`. There's no silent auto-correct or retry-with-bigger-model today (a candid roadmap item); low confidence deterministically becomes a human task.

**Q8. How does the human-in-the-loop actually work?**
- *Business:* When the system flags an invoice, it pauses and presents the approver a clean summary — extracted data, confidence, and exactly why it was flagged. The person approves or rejects in the chat UI. On rejection, it even drafts the vendor email for them to review and edit before it goes out.
- *Technical:* `human_approval_gate` and `review_email_draft` are resumable async nodes (`rerun_on_resume=True`) that emit A2UI surfaces and block on `RequestInput`. The pipeline genuinely suspends and resumes on the human's decision; email edits persist via data-model binding, with a revise loop back to the drafting agent.

**Q9. Direct vs Indirect — how does routing to SAP vs Coupa work?**
- *Business:* The system recognizes whether spend is direct (tied to production/materials, goes to the ERP) or indirect (overhead/services, goes to the procurement system) and routes each invoice to the right system automatically.
- *Technical:* `classify_spend` looks up the PO and reads its type → routes Direct to SAP CIMS, Indirect to Coupa AP; unmatched POs default to Indirect for human-safe handling. **Today this is PO classification + routing, not a 3-way (PO/GR/invoice) match — that's a named roadmap item.** The PO ledger is synthetic in the prototype.

**Q10. Is this really integrated with SAP / Coupa / ServiceNow?**
- *Business:* The decision and routing logic is live; the final write into your systems-of-record is connected through controlled stubs in this prototype. That last mile is a deliberate, scoped integration step — it's where your security, credentials, and change-control live, so it's done with your team, last.
- *Technical:* `post_to_sap`, `post_to_coupa`, `raise_duplicate_alert` return synthetic IDs today; swap-in points are isolated single functions. Production needs S/4HANA OData/BAPI, Coupa REST, ServiceNow REST credentials + the real duplicate-check query replacing the synthetic ledger.

**Q11. How are errors and retries handled?**
- *Business:* Failures don't get lost — they degrade safely. If something can't be processed, it surfaces to a person rather than guessing.
- *Technical:* Every node is try/except-wrapped, sets an `error` route, and emits telemetry. Intake has a fallback chain (mock → forced message → search). Non-fatal steps (labeling, send) degrade gracefully. Candid gap: no automatic retry/backoff or dead-letter queue yet — production hardening item.

**Q12. How do you screen out spam / non-invoices?**
- *Business:* A first-pass screen reads each email and only lets genuine invoices through, so we never waste processing on newsletters, replies, or spam.
- *Technical:* `noise_eliminator_agent` returns an `InvoiceSignalVerdict`; below 0.5 confidence → discarded before extraction. This also protects the cost profile at scale.

**Q13. Data security / privacy / where does data go?**
- *Business:* Invoice data is processed within your cloud environment and the enterprise Gemini service; the human approver sees only what they need to decide. Production would run under your tenancy, IAM, and data-residency rules.
- *Technical:* Runs on GCP (project/region per your governance; demo uses `us-west1`). No training on your data with enterprise Gemini. Deploy target options on the slide: Agent Runtime / Cloud Run / GKE. Honest note: prototype auth is ADC; production needs scoped service accounts + secret management.

**Q14. Can it scale / what about volume?**
- *Business:* The architecture is built to scale horizontally and the per-invoice cost stays flat, so volume is a capacity/throughput conversation, not a redesign.
- *Technical:* Stateless workflow nodes over shared session state; deployable to managed Agent Runtime, Cloud Run, or GKE. Throughput bounded by Gemini quota and the (future) real backend APIs, not the agent logic.

**Q15. Why agentic at all — why not RPA/OCR or a rules engine?**
- *Business:* Traditional OCR breaks on layout variation and needs templates per vendor; pure rules can't read a document. Combining a reasoning model for *reading* with deterministic rules for *deciding* gives the flexibility of AI and the predictability of rules — and a human safety net.
- *Technical:* Multimodal extraction handles arbitrary invoice layouts with no per-vendor templates; deterministic validation keeps decisions auditable and testable. Best of both, with clear separation of concerns.

**Q16. How do you know it's accurate — how is it evaluated?**
- *Business:* We measure it against labeled invoices and track quality before any change ships, so improvements are evidence-based, not anecdotal.
- *Technical:* `agents-cli eval generate/grade/compare/analyze/optimize` supports dataset runs, grading, regression diffs, failure clustering, and prompt tuning. Honest state: prototype hasn't been run against a large client-representative labeled set yet — that's an early production workstream.

**Q17. What would it take to go to production? Timeline?**
- *Business:* Three things: connect the real systems (SAP/Coupa/ServiceNow), validate accuracy on your invoice mix, and add production hardening (security, monitoring, retries). It's a scoped program, not a rebuild — the hard part, the intelligent workflow, is already working.
- *Technical:* (a) Replace 3 stub functions + synthetic PO ledger with real APIs; (b) eval against labeled client data, tune per-stage models; (c) retries/dead-letter, scoped IAM/secrets, observability/alerting, audit trail. Phased over a defined engagement.

**Q18. Why should we trust it?** *(the closing question)*
- *Business:* Because trust is built into the design, not bolted on. The AI only reads and suggests — it never decides to pay. Every decision is made by transparent rules or a human, every action is logged, and anything uncertain stops for a person. You get automation where it's safe and human control where it matters.
- *Technical:* Deterministic decisioning, explicit confidence gates, exception-based HITL with full pause/resume, tested rule engine, per-invoice cost transparency, and a clean separation between probabilistic reading and deterministic action.

---

## Part 3 — Live Demo Narrative (technology-agnostic, business-outcome framed)
*Tone: solution architect walking the room through an outcome they'll remember. No jargon.*

**Opening (set the frame, 20s):**
"Imagine your accounts-payable inbox on a Monday morning — hundreds of invoices, every one a little different, each needing to be read, checked, matched to a purchase order, and approved. Today that's mostly manual. What I'm about to show you is a digital AP teammate that handles that work end to end — and, importantly, knows exactly when to bring a human in. Let me show you it work on a real invoice, live."

**Stage 1 — Intake:** "The moment an invoice lands in the AP mailbox, the process triggers on its own. No one clicks 'start.' That's the first shift — from a queue people work through, to work that comes to you already in motion."

**Stage 2 — Screening:** "Before doing any real work, it does what an experienced clerk does — a quick glance to confirm 'yes, this is actually an invoice,' not a newsletter or a reply. Spam and noise are filtered out immediately, so effort and cost only go toward genuine invoices."

**Stage 3 — Extraction:** "Now it *reads* the invoice — vendor, amount, invoice number, PO — straight from the PDF, whatever the layout. And notice it tells you how confident it is in each field. It doesn't just extract; it knows how sure it is. That self-awareness is what makes the next steps safe."

**Stage 4 — Validation:** "Here's the control room. It runs the invoice through your AP rules — Is anything missing? Is this a duplicate we've already paid? Is the amount above the limit that needs sign-off? Is any reading too uncertain to trust? These checks are fixed, transparent business rules — not a guess. This is where the system decides: handle it automatically, or raise a hand for a human."

**Stage 5 — Human-in-the-loop (the memorable moment):** "Watch what happens with this one — it crossed an approval threshold, so the system *pauses itself* and turns to a person. It presents a clean summary and tells the approver exactly *why* it stopped. The human stays in control of the judgment call — approve, or reject. And if they reject, it even drafts the vendor email explaining why, ready for a quick review before it goes out. The machine does the work; the person makes the decision."

**Stage 6 — Classification & Posting:** "Once it's cleared, the system knows whether this is direct or indirect spend and sends it to the right system of record automatically — no manual sorting. The invoice is processed, routed, and recorded."

**Closer — the cost reveal:** "And here's the part the CFO will like. This entire journey — reading, checking, routing, drafting — costs a fraction of a cent per invoice. This panel shows it live, and even shows what it *would* cost on more powerful models, so the economics are a deliberate choice, not a guess. We get enterprise-grade automation at rounding-error cost, with a human firmly in control of every decision that matters."

**One honest line (have it ready, don't hide it):** "To be clear — this is a working prototype. The thinking and the human workflow you just saw are real and running. Connecting the final write-back into your SAP and Coupa is the next, scoped step we'd do together — deliberately last, because that's where your governance lives."

---

## Part 4 — Conceptual Architecture Slide: Separate Narration
*Use this when walking the diagram. It's a vision/conceptual artifact — narrate the intent, and keep the "safe framing" notes below in your back pocket for engineer probes.*

**The story (top to bottom, business framing):**
"This is the blueprint. Read it in layers. At the top — the **Experience Layer** — is how people interact: an enterprise chat assistant for approvals, and an alerts channel for exceptions. Below that, an **Orchestration Layer** that receives every incoming vendor invoice and hands it to the right specialist. Then the **Agent Layer** — a team of specialists, each with one job: take in the email, read the document, check it against the rules, classify the spend, and post it — with a dedicated **exception team** off to the side for anything that needs a human or a vendor follow-up. Underneath, a **Model Layer** provides the reasoning, a **Data Layer** connects to the real systems — the mailbox, SAP, Coupa, ServiceNow — and an **Infrastructure Layer** handles where it runs, how we observe it, and how we govern it. The shape to take away: specialists doing the routine work, a human in the loop by design, and enterprise systems wired in around them."

**Two patterns worth naming for leaders:** "It's *ambient* — it works in the background, triggered by events, not by someone starting a task. And it's *human-in-the-loop by design* — escalation isn't a failure mode, it's a built-in feature."

**Safe-framing notes (only if an engineer cross-checks the slide against the live system):**
- **"Root Orchestrator" / Coordinator:** In the running prototype this is implemented as a **deterministic workflow graph**, not an autonomous LLM orchestrator. Frame as a *strength*: "We deliberately keep control flow deterministic and auditable — the orchestration is a defined graph, which is safer and more predictable than letting a model decide the path."
- **Model labels (3.5 Flash / 3.1 Flash-Lite):** Diagram is indicative. The live system runs **Gemini 2.5 Flash-Lite** on all three reasoning steps, with Flash/Pro available as drop-in upgrades. "The diagram shows model *tiers* conceptually; in the build everything runs on the most economical tier today."
- **Five sequential nodes:** The live build actually has **six** functional stages — there's an added **screening** step before extraction. "We've since added a screening agent in front — the implementation is one step ahead of this slide."
- **Data Layer (SAP/Coupa/ServiceNow/Gmail) shown as connected:** Gmail + the reasoning are live; **SAP, Coupa, ServiceNow writes are controlled stubs** in the prototype. "These connections are architected and stubbed; activating them against your live instances is the scoped integration step."
- **Gmail "MCP":** Implemented via the Gmail REST API in the build (functionally equivalent for the story). Don't over-index on the MCP label.

---

## Verification / prep checklist (before you present)
- Run `uv run pytest tests/unit tests/integration` and confirm green — lets you say "it's tested" truthfully and point to S1–S8.
- Do a full dry-run of the live UI flow end-to-end (intake → screening → extraction → validation → HITL approve *and* a reject path → posting → cost card) so the HITL pause/resume and cost reveal behave on stage.
- Decide intake mode: keep `MOCK_INVOICE=true` (reliable bundled PDF) for a controlled demo, or flip to live inbox if you want the "drop an email, watch it trigger" moment — test whichever you choose beforehand.
- Have a high-value (>$4k) invoice ready to *guarantee* the HITL pause fires on cue, and optionally a duplicate to show the ServiceNow escalation path.
- Pre-load the model-switch trick (`POST /config/model`) if you want to demo the cost card recomputing across tiers.
