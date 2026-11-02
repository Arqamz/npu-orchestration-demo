/* The workload catalog, as the control plane serves it.
 *
 * WHY THIS IS HERE AND NOT A RECORDING.
 *
 * Every other response in this demo was captured from the running
 * control plane. The catalog was built after the pilot node's cards were
 * released, so there is no capture of it -- and unlike a node list or an
 * invoice, a catalog is not a reading of a cluster. It is a description
 * of what the platform can run, which is the same whether a cluster is
 * attached or not.
 *
 * So it is held here, mirroring internal/catalog in the control plane,
 * and served on the same route (/fleet/catalog) with the same shape. The
 * `availability` field is the real one: a template that cannot yet run is
 * served with NO submitTo, so a console has nowhere to post it and cannot
 * offer a button that does nothing.
 *
 * If this drifts from the Go catalog, the Go catalog is right.
 */

export const SHAPES = [
  {
    id: 'card', resource: 'huawei.com/Ascend910',
    title: 'Full card — Ascend 910B3',
    help: '20 AI cores, 64GB. The unit for training, for any model that does not fit in '
      + 'a slice, and for serving at throughput.',
    aiCores: 20, memoryGi: 64, perCard: 1,
  },
  {
    id: 'quarter', resource: 'huawei.com/Ascend910-5c.1cpu.16g',
    title: 'Quarter card — 5 cores, 16GB',
    help: 'A hardware-isolated slice. Right for a notebook, a model under 7B, or a '
      + 'development endpoint. Four fit on one card.',
    aiCores: 5, memoryGi: 16, perCard: 4,
  },
];

const T = (o) => ({ requires: [], measured: {}, ...o });

export const TEMPLATES = [
  T({
    name: 'vllm-serve', title: 'Serve a model (vLLM)', kind: 'Endpoint',
    category: 'Serving', availability: 'available', submitTo: '/fleet/endpoints',
    summary: 'An OpenAI-compatible endpoint that autoscales with load and bills by the second.',
    description: 'Runs vLLM on Ascend behind a stable address. Serves /v1/chat/completions, '
      + 'so any OpenAI client works by changing one base URL.',
    asks: ['model', 'NPU shape', 'cards per replica', 'always-on replicas',
      'max replicas', 'concurrent requests per replica'],
    measured: {
      throughput: '1501 tok/s sustained on one 910B3',
      'cold start': '4–5 minutes from scheduled to serving',
    },
  }),
  T({
    name: 'sft-lora', title: 'Fine-tune with LoRA', kind: 'Batch',
    category: 'Training', availability: 'available', submitTo: '/fleet/jobs',
    summary: 'Supervised fine-tuning with low-rank adapters on one card or a few.',
    description: 'A base model, a dataset of instruction pairs, and adapters written to '
      + 'your checkpoint volume. Runs to completion and stops billing when it does.',
    requires: ['a volume holding your dataset', 'a volume to write checkpoints to'],
    asks: ['base model', 'dataset volume', 'checkpoint volume', 'cards', 'epochs',
      'learning rate', 'LoRA rank'],
  }),
  T({
    name: 'batch-inference', title: 'Score a dataset offline', kind: 'Batch',
    category: 'Serving', availability: 'available', submitTo: '/fleet/jobs',
    summary: 'Run a model over a file of prompts and write the results, with no endpoint.',
    description: 'Cheaper than an endpoint for work with no latency requirement: cards are '
      + 'held only while the file is processed.',
    requires: ['an input volume', 'an output volume'],
    asks: ['model', 'input volume', 'output volume', 'cards'],
  }),
  T({
    name: 'full-finetune', title: 'Full fine-tune (multi-card)', kind: 'Batch',
    category: 'Training', availability: 'preview', submitTo: '/fleet/jobs',
    blocker: 'Run on the pilot at 4 cards on one node. Multi-node gang scheduling across '
      + 'clusters is refused until a second cluster validates it.',
    summary: 'All weights updated, sharded across cards with DeepSpeed ZeRO-3.',
    description: 'Every card holds a shard of the optimiser state, so the run needs all of '
      + 'its cards simultaneously and is gang-scheduled accordingly.',
    requires: ['a dataset volume', 'a checkpoint volume'],
    asks: ['base model', 'dataset volume', 'checkpoint volume', 'cards', 'ZeRO stage'],
  }),
  T({
    name: 'scaling-benchmark', title: 'Scaling benchmark', kind: 'Batch',
    category: 'Validation', availability: 'preview', submitTo: '/fleet/jobs',
    blocker: 'The harness runs; the published curve is from a single 8-card node, so it '
      + 'measures intra-node scaling only.',
    summary: 'Run the same workload at 1, 2, 4 … cards and report the scaling you got.',
    description: 'An acceptance test for a cluster rather than a product feature: it answers '
      + '"does this hardware scale" with a number instead of a claim.',
    asks: ['workload', 'model', 'scale up to', 'seconds per step'],
  }),
  T({
    name: 'notebook', title: 'Jupyter notebook on an NPU', kind: 'Workspace',
    category: 'Interactive', availability: 'designed', submitTo: '',
    blocker: 'The Workspace controller is not written. The shape, its validation and its '
      + 'expansion are tested; nothing yet creates the pod, the service or the idle reaper.',
    summary: 'A browser notebook with a card attached, billed while it is running.',
    description: 'The shortest path from an allocation to running code on an NPU. Opens in '
      + 'a browser with CANN and PyTorch present and the device visible to torch_npu. '
      + 'Idles out on its own so a forgotten notebook does not hold a card all weekend.',
    asks: ['name', 'NPU shape', 'work volume', 'stop when idle for'],
  }),
  T({
    name: 'devbox', title: 'Development box (SSH)', kind: 'Workspace',
    category: 'Interactive', availability: 'designed', submitTo: '',
    blocker: 'The Workspace controller is not written, and the SSH path needs a TCP route '
      + 'that the HTTP ingress does not provide.',
    summary: 'A long-lived container with an NPU and an SSH address, for people whose tools '
      + 'expect a machine.',
    description: 'NOT a virtual machine: a container with a shell, your keys, your volumes '
      + 'and a card. It is what VS Code Remote, rsync and a Makefile expect to find, which '
      + 'is what most teams actually have. A real VM with device passthrough means KubeVirt '
      + 'and a kernel per tenant, and is a separate thing that does not exist here.',
    asks: ['name', 'NPU shape', 'SSH public key', 'work volume', 'stop when idle for'],
  }),
];

export function catalogBody() {
  return {
    templates: TEMPLATES,
    categories: [...new Set(TEMPLATES.map((t) => t.category))],
    shapes: SHAPES,
  };
}
