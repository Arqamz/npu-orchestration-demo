# Ascend Fleet — demo stack

The product demo, separate from the control plane it demonstrates.

Everything here replays **real responses from a real control plane** running on
a real Atlas 800I A2 with eight Ascend 910B3 cards, captured through each
persona's own Keycloak token. The cluster is gone; these recordings are what is
left of it.

What is replayed is the **data**. Everything else is real logic: the routes,
the bearer authentication, the closed-list scope policy, the status codes, the
refusals, and the state a mutation leaves behind. `server/policy.mjs` mirrors
`internal/authz/scope.go`. A flow that works here works against the Go API,
because the parts that decide whether it works are the same parts.

Nothing is invented. Where a field was never captured it is absent here too,
and that absence is a finding — see [`docs/WHAT-IS-MISSING.md`](docs/WHAT-IS-MISSING.md).

---

## Run it

```bash
node server/server.mjs          # http://127.0.0.1:8082
```

No dependencies and no build step, deliberately: this has to still run in a
year, on a laptop nobody prepared, in front of people who will not wait for an
install to fail.

```bash
node verify.mjs                       # 173 checks against the stub, offline
node smoke-deployed.mjs <url>         # 37 checks against a deployed copy
node describe-api.mjs > docs/API-SURFACE.md   # regenerate the API contract
node build.mjs                        # -> dist/, deployable to Pages
```

## Opening a link is enough

Every surface opens with a **lede** that says what it is and who it is for, an
**answer strip** of the few numbers the page is actually about, and a
**guided walkthrough** that runs on a first visit and can be replayed from the
"Show me around" button in the header. Terms a reader has no reason to know --
vNPU, device-second, PodGroup -- carry a hover explanation rather than living
in a glossary nobody opens.

Add `?notour` to any URL to suppress the walkthrough, which is what the
screenshots use.

## Deployed

| URL | Surface | Show it to |
|---|---|---|
| [npu-orchestration.pages.dev](https://npu-orchestration.pages.dev) | **Start here** — what this is, who it serves, where it stands | anyone, first |
| [npu-console.pages.dev](https://npu-console.pages.dev) | Fleet console — nodes, drift, who holds what | Huawei; data-centre ops |
| [npu-serving.pages.dev](https://npu-serving.pages.dev) | **Serving — the autoscaling endpoint** | AI factories, MaaS platforms |
| [npu-workspace.pages.dev](https://npu-workspace.pages.dev) | Workspace — submit work, read logs | enterprise / research teams |
| [npu-tenant.pages.dev](https://npu-tenant.pages.dev) | Tenancy — the four-level tenant tree | resellers, channel partners |
| [npu-finance.pages.dev](https://npu-finance.pages.dev) | Finance — invoices, periods, resale statements | whoever signs the contract |
| [npu-support.pages.dev](https://npu-support.pages.dev) | Audit — the trail, proofs, signed checkpoints | security and compliance |

Each subdomain is its own Pages project carrying the whole app and its own
backend, so every link in the nav works from any of them. A `*.pages.dev`
subdomain *is* a project — there is no way to put `serving.npu-orchestration.pages.dev`
under one. Real per-surface subdomains of a domain you own need a custom domain
on each project, which is a dashboard step.

## The one to show first

**[npu-serving.pages.dev](https://npu-serving.pages.dev)** → *Replay the load test*.

A real run, frame by frame: 64 concurrent clients against Qwen2-0.5B on one
910B3. The endpoint goes 1 → 4 replicas in 47 seconds, holds exactly the 4
cards the tenant bought, and settles back to 1. 4535 requests at 1501 tok/s.

Watch the second replica: it becomes ready at **t+258 s**, 211 seconds after
the autoscaler asked for it. The image is 9 GB and vLLM compiles graphs on
first start. Scaling is immediate; capacity is not. That gap is the most
honest thing in the demo and it is left visible on purpose.

## Personas

Switch with the picker in the header, or `?as=maas-co-admin`.

| Login | Shows |
|---|---|
| `fleet-operator` | The whole fleet. The only one who sees nodes and the timeline. |
| `dc-shanghai-admin` | A data centre reselling to acme and globex — the recursive-billing story. |
| `acme-admin` | Buys from dc-shanghai, resells again to acme-research. |
| `acme-engineer` | Same tenancy as acme-admin, **refused the billing pages**. |
| `acme-research-admin` | Three levels down. |
| `maas-co-admin` | The autoscaling inference endpoint. |
| `lab-co-admin` | Multi-card training, sharing the fleet with MaaS Co. |

The refusals are the point. `acme-engineer` on Finance, or `lab-co-admin`
asking for a maas-co pod's logs, is the evidence that the scoping is real
rather than a UI that hides buttons.

## Layout

```
server/policy.mjs     the scope policy, mirrored from internal/authz/scope.go
server/core.mjs       the whole API: routing, auth, scoping, mutations, audit
server/server.mjs     local HTTP wrapper
functions/            Cloudflare Pages wrapper around the same core
web/                  the surfaces, one directory each
sessions/baseline/    every route × every persona, with statuses and latency
sessions/autoscale/   80 frames of a real autoscaling run
verify.mjs            offline checks
smoke-deployed.mjs    checks that only fail once deployed
describe-api.mjs      generates docs/API-SURFACE.md from the recordings
```

### Why two test files

`verify.mjs` drives the API object directly against a filesystem. That is the
right test for the policy and the field shapes, and it is structurally blind to
the bug that actually reached production: on Cloudflare Pages a missing asset
is answered with the project's HTML and a **200**, so "this recording is
absent" and "here is a page of markup" were the same value — and a tenant
asking for another tenant's logs got 200 and HTML instead of 404.

Anything that only exists once deployed belongs in `smoke-deployed.mjs`.

## Documents

- [`docs/API-SURFACE.md`](docs/API-SURFACE.md) — every route, field, type and
  status, **generated** from the recordings. Written for a design team: if a
  field is not in there it was not captured, and if it was not captured it does
  not exist.
- [`docs/WHAT-IS-MISSING.md`](docs/WHAT-IS-MISSING.md) — what the platform does
  not do, checked against the code rather than remembered.

## Re-recording

If a cluster becomes available again, the recorders live in the control-plane
repo and write the directories this reads:

```bash
scripts/capture-deep-session.sh baseline        # every route × every persona
scripts/capture-supplement.sh baseline          # drill-downs, logs, proofs
scripts/capture-autoscale-timeline.sh maas-co qwen-chat 300
```

## What is in these files

Node names and labels, tenant names, billing account identifiers, every priced
line item, and pod logs. They were scanned for credentials before publishing —
no JWTs, no keys, no passwords — and the audit trail redacts bearer tokens from
its query column. The tenants are fictional. Read a file before publishing it
anywhere new.
