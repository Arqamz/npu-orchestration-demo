# What is missing

Written against the code as it stands on `6245279`, not from memory. Every
"works" below was run on the pilot; every "missing" was checked by looking for
the code that would do it and not finding it.

The question that prompted this: *"API-driven calls over Volcano scheduler jobs
doesn't seem close to enough as a polished product — we only support Volcano
scheduler jobs?"*

The short answer is **no, but not by much, and the gap is narrower than the
list below makes it look.** There are now two workload shapes, not one. What is
genuinely thin is everything around them.

---

## 1. What a tenant can actually run today

| Shape | Object created | API | State |
|---|---|---|---|
| Batch / training job | `batch/v1` Job + Volcano PodGroup | `POST /fleet/jobs` | Run on hardware, gang-scheduled, metered |
| Long-running inference endpoint | `apps/v1` Deployment + Service + PodGroup | `POST /fleet/endpoints` | Run on hardware, autoscaled 1→4→1, metered |

Those are the two. The second one did not have an API until this week — it was
a CRD you applied with `kubectl`, which is why it was invisible to every
surface.

**Everything a tenant can set on a job**, in full: `name`, `image`, `command`,
`args`, `env`, `replicas`, `resource`, `devicesPerReplica`, `cpu`, `memory`,
`runAsUser`, `ttlSecondsAfterFinished`. That is the whole submission surface.

### What that list does not contain, and should

- **No volumes of any kind.** `grep -n 'Volume|PersistentVolumeClaim|ConfigMap|
  SecretRef|ImagePullSecret|EmptyDir' internal/jobs/submit.go` returns nothing.
  Not a PVC, not a ConfigMap, not a Secret — **not even an `emptyDir` for
  `/dev/shm`**, which PyTorch's DataLoader needs and whose absence shows up as
  a worker crash nobody attributes to the platform. A training job cannot mount
  a dataset or write a checkpoint anywhere that survives the pod.

  This is the single largest gap in the batch path and it is not a small
  feature: it needs storage classes, quota on capacity, and a decision about
  whether tenants share a filesystem. Note the asymmetry — the serving path
  *does* compose volumes (`ModelCache` and a sized shm), so the shape is known;
  it simply was never extended to jobs.
- **No secrets.** A job that needs a HuggingFace token or an S3 credential has
  nowhere to get one. `env` is plaintext in the Job spec and readable by
  anything that can read the Job.
- **No image pull secrets**, so a tenant cannot run a private image.
- **No node or topology selection.** A tenant cannot ask for two cards on the
  same NUMA node, or avoid a node, or spread across nodes.
- **No priority or preemption.** Every job in a tenant's queue is equal.
- **No retries or backoff policy**, no `completions`/`parallelism` for
  embarrassingly parallel sweeps — so an HPO sweep of 200 trials is 200 API
  calls the tenant orchestrates themselves.
- **No dependencies.** No "run B after A".
- **No cron.** Nothing recurring.

### Workload kinds that do not exist at all

StatefulSet (so no distributed training with stable identities beyond what a
Job gives), DaemonSet, CronJob, Argo/Kubeflow-style DAGs, Ray, Spark, and
notebooks. For a platform whose customers run "an AI token factory or an
HPO/SFT fine-tune", **the fine-tune half is served by a bare Job with no
storage**, which is not enough.

---

## 2. The serving path

Works, measured, recorded: `InferenceEndpoint` → Deployment + Service +
PodGroup, autoscaled on vLLM's `num_requests_running`, bounded by the tenant's
ResourceQuota. The recorded run reaches 4 replicas in 47 s under 64-way load,
holds exactly the 4 cards the tenant bought, and settles back to 1.

Missing, in the order that matters for a MaaS customer:

1. **No public address.** The endpoint is a ClusterIP. No ingress, no TLS, no
   hostname, no routing. Nothing outside the cluster can call it. This is the
   difference between "an endpoint exists" and "a product", and it is first
   because nothing else on this list matters until it is done.
2. **No per-caller authentication.** Anything inside the cluster can call any
   endpoint. A MaaS customer reselling to their own users has no API keys to
   issue and no way to meter per key.
3. **Billing is device-seconds, not tokens.** vLLM reports prompt and
   completion tokens; the meter counts cards. For a token factory this is a
   structural mismatch, not a missing column — it needs a second meter with a
   different source and a different rate-card key.
4. **Cold start is 4–5 minutes** and nothing hides it. The recorded run shows
   only a second replica ever becoming ready, at t+258 s and for ten
   seconds, while replicas 3 and 4 never did -- 211 seconds after the
   autoscaler asked for it: the image is 9 GB and vLLM compiles graphs on first
   start. `minReplicas: 0` is permitted with nothing holding the first request.
   A model cache and a warm pool are the fix; neither exists.
5. **One endpoint, one model.** No shared router, so ten models mean ten cards
   held permanently.
6. **Multi-card replicas are untested.** `devicesPerReplica > 1` is implemented
   and has never been run. A 70B model needing tensor parallelism across four
   cards is unproven — and this is the case most likely to come up in a demo.
7. **Model staging is manual.** Models are copied into a PVC by hand on the
   node. There is no registry, no pull-through cache, no provenance.

---

## 3. Observability

- **Nothing scrapes the metrics.** The manager exposes Prometheus metrics and a
  ServiceMonitor exists. There is no Prometheus, no Grafana, no retention, no
  alerting. Every number on the dashboards is a point-in-time read of the API.
- **No log streaming.** `/fleet/logs` returns a bounded tail; there is no
  follow, so a live view is the UI polling.
- **No exec, no port-forward, no file transfer.** Logs are the only way into a
  running container. Debugging a wedged training run means asking the operator.
- **No per-job events for tenants.** `/fleet/events` is operator-only by
  design, so a tenant whose pods are being rejected by Pod Security sees
  `Running 0/2` and nothing else — the only record is on a `FailedCreate`
  event they cannot read.
- **NPU faults are unparsed.** `npu-smi` fault output reaches the node object
  as raw comma-split fragments. Nothing turns it into a fault with a code, a
  severity and an action, so the console cannot say "card 3 has a recoverable
  ECC fault".
- **No GPU/NPU utilisation time series at all.** Allocation is known; actual
  utilisation is not collected, so neither the operator nor the tenant can see
  whether a card is busy or idle.

---

## 4. Tenancy and commerce

Works: a four-level tenant tree with immutable parents, quota containment,
Pod Security and network containment, sticky billing identity, closed periods
as meter-reading differences, and statements that roll a sub-tenant's usage up
to its payer with the path recorded.

Missing:

- **No self-service sub-tenant creation.** A reseller cannot create its own
  customer through the API. Sub-tenants are YAML applied by the operator —
  which makes the whole reseller story a manual process.
- **No invitations, no self-signup.** Users exist because someone created them
  in Keycloak by hand. There is no onboarding flow of any kind.
- **No reseller rate cards.** One rate card, applied to everyone. A reseller
  bills its customers at the price it pays, which is not a business.
- **No credit limits, suspension, dunning or payment.** Invoices are produced
  and nothing collects them. Nothing stops a sub-tenant spending past what its
  parent will pay for.
- **No reservations or commitments.** "Rent 64 NPUs for three months" is
  unrepresentable: quota is a ceiling, not a guarantee, and nothing holds
  capacity for a future date. For a data centre selling capacity this is a
  significant commercial gap.
- **No kubeconfig issuance**, so anything not on this 25-route API is
  unreachable to a tenant.
- **No machine identity.** No service accounts or API keys for CI; every caller
  is a human in Keycloak.

---

## 5. Operations

- **Single cluster.** `FleetCluster` and `Placement` exist and cross-cluster
  scheduling is deliberately refused until validated. Everything recorded here
  is one node in one cluster.
- **Self-healing is armed, not proven.** Drift detection, cordon, drain and
  remediation all work; with one node there is nowhere to drain *to*, so the
  full cycle has never completed.
- **No PodDisruptionBudgets** on tenant namespaces, so a drain can take an
  endpoint to zero.
- **No checkpoint/resume convention.** A job running for months across node
  reboots has nothing to resume from — which, combined with no volumes, means
  long-horizon work is not really supported.
- **No backup of control-plane state.** The audit trail is on a PVC; closed
  periods are in ConfigMaps.
- **Third-party images are not digest-pinned.** A test enforces that they are
  not on a moving tag, but `@sha256:` pinning is not in place.

---

## 6. Things that were wrong and are now fixed

Recorded because they say something about where else to look.

- **`InferenceEndpoint` had no API.** The serving half of the platform was
  invisible to every surface. Fixed: `internal/serving`.
- **No way for a tenant to read logs.** Fixed: `internal/podlogs`, scoped so a
  pod from another tenancy is a 404 that does not say whose it is.
- **`/healthz` and `/fleet/openapi` were declared public in the policy, promised
  in the startup help text, and never registered.** A health check against the
  API port got a plain-text 404. There was a test that every served route has a
  scope and none for the converse. Fixed, with the converse test.
- **The device annotation was guessed.** `ascend.kubernetes.io/...` instead of
  the real `ascend.kubectl.kubernetes.io/...`, so the replica view had an empty
  device column. Fixed by reading it off a running pod — the same trap as the
  extended resource names.
- **On Cloudflare Pages, a missing asset is served as HTML with a 200**, so the
  demo's cross-tenant log check returned a page of markup instead of a 404.
  Fixed, and `smoke-deployed.mjs` exists because the local verifier has a
  filesystem and structurally cannot catch that class.

---

## 7. What to pick up first

In the order I would do them:

1. **Ingress + TLS + per-endpoint hostname.** Nothing about the MaaS story is
   real until a customer can call the endpoint from outside.
2. **Volumes and secrets on jobs.** Unblocks the entire training half.
3. **Token metering** alongside device-seconds.
4. **A second node.** Converts self-healing from armed to proven and makes
   cross-cluster testable.
5. **API keys per endpoint**, which is also what makes token metering
   attributable.
6. **Prometheus + Grafana**, because every number currently has no history.
7. **Self-service sub-tenant creation**, which is what makes the reseller
   story a product rather than a support ticket.

Items 1–3 are what a Huawei product team will ask about first, because they are
what separates this from a well-built internal tool.
