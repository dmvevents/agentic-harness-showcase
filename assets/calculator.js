/* ---------------------------------------------------------------------------
 * agentic-harness — directional GPU-cluster sizing calculator
 *
 * DETERMINISTIC by construction: every function below is PURE. Same input
 * always produces the same output. No network calls, no randomness, no state.
 * This is the public, client-side embodiment of the "deterministic tool"
 * pattern — the same property the cluster_ops backend enforces server-side.
 *
 * EVERY number this produces is a DIRECTIONAL, PUBLIC-SPEC estimate, NOT a
 * benchmark. Real benchmark numbers live in a PR-gated repo with provenance
 * and a validation status. Nothing here is a measured result.
 *
 * Sources for the constants below are all publicly published vendor specs /
 * public list prices. No negotiated pricing, no customer data.
 * ------------------------------------------------------------------------- */

"use strict";

/* ---- GPU / instance spec table (PUBLIC specs only) ---------------------- */
/* VRAM in GB per GPU; gpus_per_instance fixed at 8 for these P-family nodes.
 * on_demand_usd_hr is a PUBLIC list-price DIRECTIONAL figure for the whole
 * instance (8 GPUs) — clearly an estimate, not a quote, not negotiated. */
/* bf16_tflops is PER-GPU dense BF16 (a node has 8x this). od_usd_hr_instance
 * is the whole-instance (8-GPU) on-demand figure; price_verified flags whether
 * it is a confirmed public list price (us-east-1, Linux/UNIX, on-demand,
 * default tenancy) or an UNVERIFIED placeholder that must not be quoted. */
const GPU_TABLE = {
  H100: {
    label: "H100 (p5.48xlarge)",
    instance_type: "p5.48xlarge",
    vram_gb: 80,
    gpus_per_instance: 8,
    bf16_tflops_per_gpu: 989,    // public dense BF16, sparsity off, directional
    od_usd_hr_instance: 98.32,   // public on-demand list (us-east-1, Linux), directional
    price_verified: true,
  },
  H200: {
    label: "H200 (p5en.48xlarge)",
    instance_type: "p5en.48xlarge",
    vram_gb: 141,
    gpus_per_instance: 8,
    bf16_tflops_per_gpu: 989,
    od_usd_hr_instance: 110.0,   // UNVERIFIED placeholder — do not quote
    price_verified: false,
  },
  B200: {
    label: "B200 (p6-b200.48xlarge)",
    instance_type: "p6-b200.48xlarge",
    vram_gb: 192,
    gpus_per_instance: 8,
    bf16_tflops_per_gpu: 2250,   // public dense BF16, directional
    od_usd_hr_instance: 140.0,   // UNVERIFIED placeholder — do not quote
    price_verified: false,
  },
};

/* Working-set multipliers — DIRECTIONAL, deliberately conservative to avoid
 * false "fits". Reviewers (GPT-5.4 + Gemini-3-Pro consensus, 2026-06-25):
 *   - inference: 1.25x is too low; KV cache + activations under real batch /
 *     long context routinely push past it. Use 2.0x general-purpose default.
 *   - training: weights+grad+Adam ~= 16 bytes/param EXCLUDES activations,
 *     which guarantees OOM; use ~20 bytes/param as a safe directional floor. */
const INFERENCE_WORKING_SET_MULT = 2.0;
const TRAIN_BYTES_PER_PARAM = 20;
const HOURS_PER_MONTH = 730;   // cloud-standard (365*24/12), not 24*30=720

/* Bytes per parameter by precision (weights only). */
const BYTES_PER_PARAM = { fp16: 2, bf16: 2, fp8: 1, int8: 1 };

/* ---- pure helpers ------------------------------------------------------- */

/** Total GPUs = instances x gpus/instance. Pure. */
function totalGpus(spec, instanceCount) {
  return spec.gpus_per_instance * instanceCount;
}

/** Aggregate cluster VRAM in GB. Pure. */
function aggregateVramGb(spec, instanceCount) {
  return spec.vram_gb * totalGpus(spec, instanceCount);
}

/* Training-strategy memory profiles. "DP shouldn't be the only one" — different
 * mechanisms have very different per-GPU footprints. bytes_per_param is the
 * per-trainable-param state; shardable says whether optimizer+grad state is
 * sharded across the data-parallel group (FSDP/ZeRO-3 do; plain DDP/DP do not).
 * All DIRECTIONAL public rules of thumb, NOT benchmarks. */
const TRAIN_STRATEGY = {
  full_ddp:   { label: "Full fine-tune · DDP/DP",      bytes: 20, shardable: false,
                note: "weights+grad+Adam+activation floor, replicated per GPU (data-parallel)" },
  full_fsdp:  { label: "Full fine-tune · FSDP / ZeRO-3", bytes: 20, shardable: true,
                note: "same state, but sharded across the data-parallel group" },
  full_zero2: { label: "Full fine-tune · ZeRO-2",       bytes: 20, shardable: true, shardFraction: 0.6,
                note: "optimizer+grad sharded, params replicated (~60% shardable)" },
  lora:       { label: "LoRA",                          bytes: 2.4, shardable: false,
                note: "frozen weights (2B/param) + tiny trainable adapters+states" },
  qlora:      { label: "QLoRA (4-bit base)",            bytes: 0.9, shardable: false,
                note: "4-bit frozen base (~0.5B/param) + small adapter states" },
};

/**
 * Directional memory footprint, in GB. Now models the real strategy space —
 * dense vs MoE, full vs LoRA/QLoRA, and sharded (FSDP/ZeRO) vs replicated —
 * not just dense full-finetune.
 *
 * cfg: {paramsB, workload, precision, modelType?, activeParamsB?, strategy?, dpGroup?}
 *   modelType: "dense" | "moe"  (MoE: VRAM holds ALL experts, but compute/KV
 *              tracks only the ACTIVE params — e.g. Mixtral 8x7B = 47B total, ~13B active)
 *   strategy: a key of TRAIN_STRATEGY (training/finetune only)
 *   dpGroup:  data-parallel world size the optimizer state is sharded over (FSDP/ZeRO)
 */
function modelFootprintGb(cfg) {
  const { paramsB, workload, precision } = cfg;
  const bytes = BYTES_PER_PARAM[precision] || 2;
  // MoE: all experts must be RESIDENT in VRAM (memory tracks total params),
  // even though only active params do compute.
  const memParamsB = paramsB;

  if (workload === "train" || workload === "finetune") {
    const strat = TRAIN_STRATEGY[cfg.strategy] || TRAIN_STRATEGY.full_ddp;
    let gb = memParamsB * strat.bytes;
    if (strat.shardable) {
      // FSDP/ZeRO-3 shard the full state across the DP group; ZeRO-2 shards a fraction.
      const dp = Math.max(1, cfg.dpGroup || 1);
      const frac = strat.shardFraction != null ? strat.shardFraction : 1.0;
      gb = gb * (1 - frac) + (gb * frac) / dp;
    }
    return gb;
  }
  // inference: weights (ALL experts resident) + working set (KV+activations).
  // KV cache scales with the ACTIVE path, but weights dominate residency.
  const weightsGb = memParamsB * bytes;
  return weightsGb * INFERENCE_WORKING_SET_MULT;
}

/**
 * Memory-fit verdict vs aggregate VRAM. Pure. Returns {level, ratio, text}.
 * level in {fit, tight, over}. Uses an 0.85 usable-fraction haircut for
 * fragmentation / framework overhead (directional).
 */
function fitVerdict(footprintGb, aggVramGb) {
  const usable = aggVramGb * 0.85;
  const ratio = footprintGb / usable;
  if (ratio <= 0.7) {
    return { level: "fit", ratio,
      text: "Comfortable fit — the directional footprint is well under usable VRAM." };
  }
  if (ratio <= 1.0) {
    return { level: "tight", ratio,
      text: "Tight fit — directional footprint is near usable VRAM. Leave headroom for KV cache growth / longer sequences." };
  }
  return { level: "over", ratio,
    text: "Over budget — the directional footprint exceeds usable VRAM. Add instances, shard further, or quantize." };
}

/**
 * Parallelism suggestion (TP/PP/DP). Pure heuristic, DIRECTIONAL.
 * Reworked per reviewer consensus (2026-06-25) to (a) NOT force TP=8 when the
 * model fits on fewer GPUs, and (b) NOT strand GPUs.
 *
 *   - TP = smallest power-of-two (<= gpus/node) of GPUs whose combined usable
 *     VRAM holds the model. Models that fit on 1 GPU get TP=1. TP stays inside
 *     one node (NVLink domain).
 *   - PP = nodes needed when even a full node can't hold the model; else 1.
 *   - DP = replicas across the remaining whole model-shards.
 * Returns used/stranded GPUs so the UI can be honest about waste.
 */
function parallelismSuggestion(spec, instanceCount, footprintGb) {
  const perGpuUsable = spec.vram_gb * 0.85;
  const G = spec.gpus_per_instance;          // GPUs per node (NVLink domain)
  const gpus = totalGpus(spec, instanceCount);

  // TP: fewest GPUs (power of two, <= node size) whose usable VRAM holds model.
  let tp = 1;
  while (tp < G && perGpuUsable * tp < footprintGb) tp *= 2;
  // PP: nodes needed when one full node can't hold the model.
  const perNodeUsable = perGpuUsable * G;
  const nodesNeeded = footprintGb > perNodeUsable
    ? Math.ceil(footprintGb / perNodeUsable) : 1;
  // The model does NOT fit if it needs more nodes than we have. Surface that
  // honestly instead of emitting a config that over-allocates GPUs.
  const fits = nodesNeeded <= instanceCount;
  const pp = Math.min(nodesNeeded, instanceCount);   // never exceed real nodes
  const gpusPerReplica = tp * pp;
  const dp = fits ? Math.max(1, Math.floor(gpus / gpusPerReplica)) : 1;
  const usedGpus = Math.min(gpus, gpusPerReplica * dp);  // clamp; never negative
  const strandedGpus = Math.max(0, gpus - usedGpus);

  let note;
  if (!fits) {
    note = `Model does not fit on ${instanceCount} node(s): it needs ~${nodesNeeded} nodes (${G * nodesNeeded} GPUs) just to hold the footprint. Add nodes, shard further, or quantize.`;
  } else if (pp > 1) {
    note = `Model exceeds a single node — pipeline across ${pp} nodes (PP=${pp}), tensor-parallel ${tp}-way within each node.`;
  } else if (tp === 1) {
    note = "Model fits on a single GPU — pure data-parallel (TP=1); scale replicas with DP.";
  } else {
    note = `Model fits within one NVLink domain — tensor-parallel ${tp}-way inside the node, data-parallel across the rest.`;
  }
  if (fits && strandedGpus > 0) {
    const nodesPerReplica = gpusPerReplica / G;
    note += ` ${strandedGpus} GPU(s) idle at this count — use an instance count that is a multiple of ${nodesPerReplica < 1 ? 1 : nodesPerReplica} node(s)/replica to avoid stranding.`;
  }
  return { tp, pp, dp, usedGpus, strandedGpus, fits, note };
}

/**
 * Directional on-demand cost. Pure.
 * Returns {usdPerHr, usdPerDay, usdPerMonth} for the whole cluster, using the
 * PUBLIC list price. NOT a quote, NOT negotiated, NOT including storage/egress.
 */
function directionalCost(spec, instanceCount) {
  const usdPerHr = spec.od_usd_hr_instance * instanceCount;
  return {
    usdPerHr,
    usdPerDay: usdPerHr * 24,
    usdPerMonth: usdPerHr * HOURS_PER_MONTH,   // 730h cloud-standard, not 720
    verified: spec.price_verified,
  };
}

/**
 * The single deterministic entry point: config in → structured result out.
 * Pure. This is the shape a server-side typed `size_cluster` tool would return.
 */
function sizeCluster(cfg) {
  const spec = GPU_TABLE[cfg.gpuType];
  const gpus = totalGpus(spec, cfg.instanceCount);
  const aggVram = aggregateVramGb(spec, cfg.instanceCount);

  // Step 1: replicated (un-sharded) footprint to derive the parallelism shape.
  const footprint0 = modelFootprintGb({ ...cfg, dpGroup: 1 });
  const par = parallelismSuggestion(spec, cfg.instanceCount, footprint0);
  // Step 2: for sharded strategies (FSDP/ZeRO), recompute with the real DP group
  // (the optimizer/grad state shards across the dp replicas).
  const footprint = modelFootprintGb({ ...cfg, dpGroup: par.dp });
  const verdict = fitVerdict(footprint, aggVram);
  const cost = directionalCost(spec, cfg.instanceCount);
  const aggTflops = spec.bf16_tflops_per_gpu * gpus;
  return { spec, gpus, aggVram, footprint, footprint0, verdict, par, cost, aggTflops,
           strategy: cfg.strategy || (cfg.workload === "inference" ? "inference" : "full_ddp") };
}

/* ---- DOM glue (impure boundary; the math above stays pure) -------------- */

function fmtUsd(n) {
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function fmtNum(n, d = 0) {
  return n.toLocaleString("en-US", { maximumFractionDigits: d });
}

function _val(id, dflt) {
  const el = document.getElementById(id);
  return el ? el.value : dflt;
}

function readConfig() {
  return {
    paramsB: Math.max(0.1, parseFloat(document.getElementById("params").value) || 8),
    workload: document.getElementById("workload").value,
    gpuType: document.getElementById("gpu").value,
    instanceCount: Math.max(1, parseInt(document.getElementById("instances").value, 10) || 1),
    precision: document.getElementById("precision").value,
    modelType: _val("modelType", "dense"),
    strategy: _val("strategy", "full_ddp"),
  };
}

function render() {
  const cfg = readConfig();
  const r = sizeCluster(cfg);

  const costNote = r.cost.verified ? "" : " <span class=\"warn\">(unverified placeholder price — do not quote)</span>";
  const strandTxt = r.par.strandedGpus > 0
    ? `${fmtNum(r.par.usedGpus)} used, <span class="warn">${fmtNum(r.par.strandedGpus)} idle</span>`
    : `${fmtNum(r.par.usedGpus)} used, 0 idle`;
  const stratLabel = (typeof TRAIN_STRATEGY !== "undefined" && TRAIN_STRATEGY[cfg.strategy])
    ? TRAIN_STRATEGY[cfg.strategy].label : "inference";
  const strat = cfg.workload === "inference" ? "inference (serving)" : stratLabel;
  const mt = cfg.modelType === "moe" ? "MoE (all experts resident)" : "dense";
  const shardNote = (r.footprint0 && r.footprint < r.footprint0 * 0.95)
    ? ` <span style="opacity:.7">(sharded from ${fmtNum(r.footprint0,0)} GB across DP=${r.par.dp})</span>` : "";
  const rows = [
    ["Instance type", r.spec.instance_type],
    ["Strategy", `${strat} &middot; ${mt}`],
    ["Total GPUs", `${fmtNum(r.gpus)} (${cfg.instanceCount} &times; ${r.spec.gpus_per_instance})`],
    ["Aggregate VRAM", `${fmtNum(r.aggVram)} GB`],
    ["Directional model footprint", `${fmtNum(r.footprint, 1)} GB${shardNote}`],
    ["Aggregate BF16 compute", `~${fmtNum(r.aggTflops)} TFLOP/s (dense per-GPU &times; GPUs, directional)`],
    ["Suggested parallelism", `TP=${r.par.tp} &middot; PP=${r.par.pp} &middot; DP=${r.par.dp} &nbsp; (${strandTxt})`],
    ["Est. on-demand cost", `${fmtUsd(r.cost.usdPerHr)}/hr &middot; ${fmtUsd(r.cost.usdPerDay)}/day &middot; ${fmtUsd(r.cost.usdPerMonth)}/mo${costNote}`],
  ];

  document.getElementById("results").innerHTML = rows.map(
    ([k, v]) => `<div class="result-row"><span class="rk">${k}</span><span class="rv">${v}</span></div>`
  ).join("");

  document.getElementById("verdict").className = "verdict " + r.verdict.level;
  document.getElementById("verdict").innerHTML =
    `Memory fit: ${r.verdict.text} <span style="opacity:.8">(footprint / usable VRAM &asymp; ${(r.verdict.ratio * 100).toFixed(0)}%)</span>`;

  document.getElementById("par-note").textContent = r.par.note;
}

document.addEventListener("DOMContentLoaded", function () {
  ["params", "workload", "gpu", "instances", "precision"].forEach(function (id) {
    const el = document.getElementById(id);
    el.addEventListener("input", render);
    el.addEventListener("change", render);
  });
  render();
});
