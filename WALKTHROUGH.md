# Frontend walkthrough

What to open, in what order, and what you are looking at. Written for a
review of the demo as it stands, not as a feature list.

Every link below is live. Nothing on any of them is synthesised: each
response was recorded from a real control plane running on a real Atlas
800I A2, and the `recorded` badge in the header says so on every page.

---

## Before you start

**Two controls in the header matter.**

- **Persona picker** (top right). Eight logins across four tenancy
  levels. Changing it reloads the page *as that person* — and the
  interesting thing is what disappears. A refusal on these pages is the
  product working, not the demo failing.
- **"Show me around"** (next to each page title). A guided walkthrough,
  four or five steps, pointing at real parts of the page. It runs by
  itself on a first visit and the button never goes away. Append
  `?notour` to any URL to suppress it.

**Terms with a dotted underline have a hover explanation.** vNPU,
device-second, PodGroup — the words a reader has no reason to know.

**The theme toggle** (◐) switches light and dark and remembers. Light
mode is a selected palette, not an inversion.

---

## 1. Start here — the pitch

**[npu-orchestration.pages.dev](https://npu-orchestration.pages.dev)**

What this is, who it is for, and where it honestly stands. Read it in
order: the problem, the value chain, the capability tiles, the audience
cards, then **Readiness** — which is the section to push on, because it
is the one that says what does not work yet.

*Five minutes.*

---

## 2. The hardware — what an operator sees

**[npu-console.pages.dev](https://npu-console.pages.dev)**  ·  persona: `fleet-operator`

The machines, their certified software stack, drift, and who is holding
each card right now.

Three things to look at:

1. **The answer strip.** Nodes ready, cards held, faulted, cordoned. The
   note under each number says what it *means*, not what it is called.
2. **Drift and self-healing** — the six-step strip. This is the loop that
   makes the product more than a scheduler: observe, compare, cordon,
   drain, remediate, return. The drift row reads
   `cannVersion 8.5.2 → 8.5.1`, which is the actionable fact.
3. **The callout under the node table.** A real gap, left visible: faults
   are raw `npu-smi` output and nothing parses them into a structured
   fault with a code and a severity. That is a hole in the control plane
   and it is on the page rather than hidden.

**Then switch the persona to `acme-engineer` and reload.** The page
refuses, with a reason. That refusal is the multi-tenancy story.

*Eight minutes.*

---

## 3. Serving — the one to demo

**[npu-serving.pages.dev](https://npu-serving.pages.dev)**  ·  persona: `maas-co-admin`

A model as a long-lived, addressable, autoscaled endpoint. **This is the
page to put in front of anyone evaluating the product.**

Press **"Replay the load test"**. It replays 80 frames of a real run:

| | |
|---|---|
| 1 → 4 replicas | at t+47s, once the in-flight batch crossed target |
| held at 4 | the quota ceiling, not the demand ceiling |
| second replica ready | only at t+258s — engine init dominates |
| settled back to 1 | at t+416s |
| served | 4535 requests OK, 12 failed, 11.92 req/s, 1501 tok/s |

Two things to say while it runs:

- **The chart is two panels on one time axis, never one chart with two
  scales.** Load rises below, replicas follow above. A dual-axis chart
  would invite a causal reading that is an artifact of the scaling.
- **Scaling is immediate; capacity is not.** The gap between "replicas
  held" and "serving" is the honest part of the demo — four to five
  minutes from scheduled to answering, because the image is 9GB and vLLM
  compiles graphs on first start. The callout says so.

*Ten minutes. The most important ten minutes in the deck.*

---

## 4. The engineer's desk

**[npu-workspace.pages.dev](https://npu-workspace.pages.dev)**  ·  persona: `acme-engineer`

Submit work, watch it schedule, read why it did not.

The point of this page is what the engineer **cannot** do: the same
person who can spend the tenancy's cards cannot read the tenancy's
invoices. Scroll to the refused panels.

*Four minutes.*

---

## 5. Reselling — the B2B2B tree

**[npu-tenant.pages.dev](https://npu-tenant.pages.dev)**  ·  persona: `dc-shanghai-admin`

Four levels: operator → data centre → AI company → its customers.

Every platform does one level. The difficulty is that usage has to roll
*up* without being counted twice, and a sub-tenant must not escape the
quota of the tenant that is liable for it. Quota here is **containment,
not a sum** — a child declaring no limit is unbounded, and one unbounded
child can take the whole parent's allowance while the declared numbers
add to almost nothing.

*Five minutes.*

---

## 6. The money

**[npu-finance.pages.dev](https://npu-finance.pages.dev)**  ·  persona: `dc-shanghai-admin`

Invoices, closed periods, and a reseller's statement.

Look at **Statement**: own usage, resold to customers, total. A real
closed period came to **720.89 USD** across three sub-tenants. Rolling a
sub-tenant's usage up to its payer may *move* it; it must never duplicate
it — a rollup counting a grandchild under both its parent and its
grandparent looks like a healthy business and is fraud.

Every figure is a difference between two meter readings. Nothing uses a
PromQL `rate()`.

*Five minutes.*

---

## 7. Why anyone should believe the numbers

**[npu-support.pages.dev](https://npu-support.pages.dev)**  ·  persona: `fleet-operator`

The audit trail: a hash chain with a signed Merkle head, anchored onto
every closed billing period.

The argument to make: an audit log the operator holds is worth nothing on
its own, because the operator holds the records, the tree *and* the key
and could rewrite all three consistently. What they cannot do is
reconcile a rewrite with a commitment already sitting in a customer's
records — which is why the signed head is anchored onto a closed period,
a document that is append-only and has already been sent.

Verification lives outside the server, in `cmd/audit-verify`.

*Six minutes.*

---

## What to be ready to be asked

| Question | The honest answer |
|---|---|
| Can I call an endpoint from outside the cluster? | Not yet. `spec.route` is validated — TLS and an API key are both mandatory — and nothing creates the Ingress. First item on the roadmap. |
| Can I get a notebook? | The shape is built and tested; the controller that turns it into a pod is not. The catalog says so itself: those templates come back with no submit route. |
| Does it scale past one node? | Measured to 8 cards on one node. Cross-cluster is refused in code until a second cluster validates it, rather than claimed. |
| Does self-healing work? | The loop runs and is visible on the console. It has not been proven against a second node, because there has only ever been one. |
| What about scale-to-zero? | Refused today, deliberately. It used to be accepted with a warning and it never came back — see the handbook. The activator that fixes it is designed and not deployed. |

---

## If something looks wrong

Run `node verify.mjs` (204 offline checks) and
`node smoke-deployed.mjs <url>` (37 against a deployment). Between them
they cover every recorded response, every refusal, the scope policy, the
stylesheet, and whether each surface still wires up its walkthrough.

A page that is **wrong** looks like a fleet that is **empty** — that is
the failure these checks exist to catch, and the one that has bitten
twice.
