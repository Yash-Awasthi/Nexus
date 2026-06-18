"use client";

import type { Route } from "./+types/infra-calculator";
import { useState, useMemo } from "react";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Cpu, HardDrive, Check, X, AlertTriangle, Layers, Zap } from "lucide-react";
import { FadeIn, TiltCard, DottedGrid, GlowOrbs } from "~/components/animations";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Infrastructure Calculator - JUDICA" },
    {
      name: "description",
      content:
        "Calculate GPU and hardware requirements for self-hosting LLMs with JUDICA. Estimate VRAM, GPU count, and compatibility.",
    },
  ];
}

interface ModelInfo {
  name: string;
  totalParams: number;
  activeParams?: number;
  isMoE: boolean;
  label: string;
  layers: number;
  hiddenDim: number;
}

const modelList: ModelInfo[] = [
  // Small dense
  { name: "Gemma 2 2B", totalParams: 2, isMoE: false, label: "Dense 2B", layers: 18, hiddenDim: 2304 },
  { name: "Phi-3.5 Mini 3.8B", totalParams: 4, isMoE: false, label: "Dense 3.8B", layers: 32, hiddenDim: 3072 },
  { name: "Llama 3.2 3B", totalParams: 3, isMoE: false, label: "Dense 3B", layers: 28, hiddenDim: 3072 },
  // Medium dense
  { name: "Llama 4 Nano 8B", totalParams: 8, isMoE: false, label: "Dense 8B", layers: 32, hiddenDim: 4096 },
  { name: "Gemma 4 12B", totalParams: 12, isMoE: false, label: "Dense 12B", layers: 36, hiddenDim: 4608 },
  { name: "Phi-4 14B", totalParams: 14, isMoE: false, label: "Dense 14B", layers: 40, hiddenDim: 5120 },
  { name: "Mistral Small 22B", totalParams: 22, isMoE: false, label: "Dense 22B", layers: 40, hiddenDim: 6144 },
  { name: "Gemma 2 27B", totalParams: 27, isMoE: false, label: "Dense 27B", layers: 46, hiddenDim: 4608 },
  { name: "Gemma 4 31B", totalParams: 31, isMoE: false, label: "Dense 31B", layers: 48, hiddenDim: 6144 },
  { name: "Qwen 3 32B", totalParams: 32, isMoE: false, label: "Dense 32B", layers: 64, hiddenDim: 5120 },
  { name: "Qwen 3.5 27B", totalParams: 27, isMoE: false, label: "Dense 27B", layers: 36, hiddenDim: 5120 },
  // Large dense
  { name: "Llama 3.1 70B", totalParams: 70, isMoE: false, label: "Dense 70B", layers: 80, hiddenDim: 8192 },
  { name: "Qwen 3 72B", totalParams: 72, isMoE: false, label: "Dense 72B", layers: 80, hiddenDim: 8192 },
  { name: "Command R+ 104B", totalParams: 104, isMoE: false, label: "Dense 104B", layers: 96, hiddenDim: 8192 },
  { name: "Llama 3.1 405B", totalParams: 405, isMoE: false, label: "Dense 405B", layers: 126, hiddenDim: 16384 },
  // MoE models
  { name: "Mixtral 8x7B", totalParams: 47, activeParams: 13, isMoE: true, label: "MoE 47B (13B active)", layers: 32, hiddenDim: 4096 },
  { name: "Mixtral 8x22B", totalParams: 176, activeParams: 39, isMoE: true, label: "MoE 176B (39B active)", layers: 56, hiddenDim: 6144 },
  { name: "Qwen 3.5 35B MoE", totalParams: 35, activeParams: 7, isMoE: true, label: "MoE 35B (7B active)", layers: 36, hiddenDim: 4096 },
  { name: "Qwen 3.5 122B MoE", totalParams: 122, activeParams: 22, isMoE: true, label: "MoE 122B (22B active)", layers: 48, hiddenDim: 7168 },
  { name: "DeepSeek V3", totalParams: 671, activeParams: 37, isMoE: true, label: "MoE 671B (37B active)", layers: 61, hiddenDim: 7168 },
  { name: "Llama 4 Scout", totalParams: 109, activeParams: 17, isMoE: true, label: "MoE 109B (17B active)", layers: 48, hiddenDim: 5120 },
  { name: "Llama 4 Maverick", totalParams: 400, activeParams: 17, isMoE: true, label: "MoE 400B (17B active)", layers: 96, hiddenDim: 8192 },
  { name: "Qwen 3 235B MoE", totalParams: 235, activeParams: 22, isMoE: true, label: "MoE 235B (22B active)", layers: 94, hiddenDim: 7168 },
  { name: "DeepSeek V3.2", totalParams: 800, activeParams: 37, isMoE: true, label: "MoE ~800B (37B active)", layers: 61, hiddenDim: 7168 },
];

const quantOptions: { name: string; bytesPerParam: number }[] = [
  { name: "FP32", bytesPerParam: 4 },
  { name: "FP16 / BF16", bytesPerParam: 2 },
  { name: "INT8 / FP8", bytesPerParam: 1 },
  { name: "INT4 / GPTQ", bytesPerParam: 0.5 },
  { name: "GGUF Q5_K_M", bytesPerParam: 0.65 },
  { name: "GGUF Q4_K_M", bytesPerParam: 0.5 },
  { name: "GGUF Q3_K_M", bytesPerParam: 0.4 },
  { name: "GGUF Q2_K", bytesPerParam: 0.3 },
];

interface GpuInfo {
  name: string;
  vram: number;
  category: "Laptop" | "Consumer" | "Datacenter";
}

const gpuList: GpuInfo[] = [
  // Laptop GPUs
  { name: "RTX 3050 Mobile", vram: 4, category: "Laptop" },
  { name: "RTX 3060 Mobile", vram: 6, category: "Laptop" },
  { name: "RTX 3070 Ti Mobile", vram: 8, category: "Laptop" },
  { name: "RTX 3080 Ti Mobile", vram: 16, category: "Laptop" },
  { name: "RTX 4060 Mobile", vram: 8, category: "Laptop" },
  { name: "RTX 4070 Mobile", vram: 8, category: "Laptop" },
  { name: "RTX 4080 Mobile", vram: 12, category: "Laptop" },
  { name: "RTX 4090 Mobile", vram: 16, category: "Laptop" },
  { name: "RTX 5070 Mobile", vram: 12, category: "Laptop" },
  { name: "RTX 5080 Mobile", vram: 16, category: "Laptop" },
  { name: "RX 7700M", vram: 12, category: "Laptop" },
  // Consumer Desktop
  { name: "RTX 3060 12GB", vram: 12, category: "Consumer" },
  { name: "RTX 3090", vram: 24, category: "Consumer" },
  { name: "RTX 4060 Ti 16GB", vram: 16, category: "Consumer" },
  { name: "RTX 4070 Ti Super", vram: 16, category: "Consumer" },
  { name: "RTX 4080 Super", vram: 16, category: "Consumer" },
  { name: "RTX 4090", vram: 24, category: "Consumer" },
  { name: "RTX 5080", vram: 16, category: "Consumer" },
  { name: "RTX 5090", vram: 32, category: "Consumer" },
  { name: "RX 7900 XTX", vram: 24, category: "Consumer" },
  { name: "Apple M2 Ultra", vram: 192, category: "Consumer" },
  { name: "Apple M4 Max", vram: 128, category: "Consumer" },
  // Datacenter
  { name: "Tesla T4", vram: 16, category: "Datacenter" },
  { name: "A10G", vram: 24, category: "Datacenter" },
  { name: "L4", vram: 24, category: "Datacenter" },
  { name: "A40", vram: 48, category: "Datacenter" },
  { name: "L40S", vram: 48, category: "Datacenter" },
  { name: "A100 40GB", vram: 40, category: "Datacenter" },
  { name: "A100 80GB", vram: 80, category: "Datacenter" },
  { name: "H100 80GB", vram: 80, category: "Datacenter" },
  { name: "H200 141GB", vram: 141, category: "Datacenter" },
  { name: "B200 192GB", vram: 192, category: "Datacenter" },
  { name: "GB200 (NVL2)", vram: 384, category: "Datacenter" },
];

// Default index for RTX 4090 (index 17 in the new list)
const DEFAULT_GPU_IDX = 17;

const contextLengths = [1024, 4096, 8192, 16384, 32768, 65536, 131072];
const contextLabels: Record<number, string> = {
  1024: "1K",
  4096: "4K",
  8192: "8K",
  16384: "16K",
  32768: "32K",
  65536: "64K",
  131072: "128K",
};

interface CalcResult {
  modelVram: number;
  kvCacheVram: number;
  totalVram: number;
  vramPerGpu: number;
  gpusNeeded: number;
  fits: boolean;
  recommendation: string;
  estimatedTps: number;
}

function calculate(
  modelInfo: ModelInfo,
  bytesPerParam: number,
  gpu: GpuInfo,
  contextLength: number,
): CalcResult {
  const modelVram = modelInfo.totalParams * bytesPerParam;
  const effectiveParams = modelInfo.activeParams ?? modelInfo.totalParams;
  const kvCacheVram = (contextLength * 0.5 * effectiveParams) / (7 * 1024);
  const totalVram = modelVram + kvCacheVram;
  const vramAvailable = gpu.vram;
  const gpusNeeded = Math.max(1, Math.ceil(totalVram / vramAvailable));
  const fits = totalVram <= vramAvailable;
  const vramPerGpu = totalVram / gpusNeeded;

  let baseTps = 20;
  if (gpu.category === "Laptop") baseTps = 12;
  if (gpu.category === "Datacenter") baseTps = 60;
  if (gpu.name.includes("H100")) baseTps = 80;
  if (gpu.name.includes("H200")) baseTps = 90;
  if (gpu.name.includes("B200") || gpu.name.includes("GB200")) baseTps = 120;
  if (gpu.name.includes("M2 Ultra") || gpu.name.includes("M4 Max")) baseTps = 35;

  const activeB = modelInfo.activeParams ?? modelInfo.totalParams;
  let estimatedTps = baseTps * (7 / activeB);
  if (bytesPerParam <= 0.5) estimatedTps *= 1.8;
  else if (bytesPerParam <= 1) estimatedTps *= 1.4;
  if (gpusNeeded > 1) estimatedTps *= 0.8;
  if (gpusNeeded > 4) estimatedTps *= 0.7;
  if (gpu.category === "Laptop") estimatedTps *= 0.7; // thermal throttle penalty
  estimatedTps = Math.max(1, Math.round(estimatedTps));

  let recommendation = "";
  if (fits) {
    recommendation = `Fits on a single ${gpu.name}. Good to go!`;
  } else if (gpusNeeded <= 2) {
    recommendation = `Needs ${gpusNeeded}× ${gpu.name} with tensor parallelism. Practical setup.`;
  } else if (gpusNeeded <= 4) {
    recommendation = `Requires ${gpusNeeded}× ${gpu.name}. Consider stronger quantization or a higher-VRAM GPU.`;
  } else if (gpusNeeded <= 8) {
    recommendation = `Requires ${gpusNeeded}× ${gpu.name}. For production, consider datacenter GPUs (H100/H200/B200) or aggressive quantization.`;
  } else {
    recommendation = `Requires ${gpusNeeded}× ${gpu.name}. This is impractical. Use INT4/GGUF quantization or datacenter GPUs.`;
  }

  return { modelVram, kvCacheVram, totalVram, vramPerGpu, gpusNeeded, fits, recommendation, estimatedTps };
}

function statusGlowColor(fits: boolean, gpusNeeded: number) {
  if (fits) return "rgba(16,185,129,0.4)";
  if (gpusNeeded <= 4) return "rgba(234,179,8,0.4)";
  return "rgba(239,68,68,0.4)";
}

export default function InfraCalculator() {
  const [modelIdx, setModelIdx] = useState(7); // Llama 4 Nano default
  const [quantIdx, setQuantIdx] = useState(1);
  const [gpuIdx, setGpuIdx] = useState(DEFAULT_GPU_IDX);
  const [ctxIdx, setCtxIdx] = useState(2);

  const modelInfo = modelList[modelIdx];
  const quantInfo = quantOptions[quantIdx];
  const gpuInfo = gpuList[gpuIdx];
  const contextLength = contextLengths[ctxIdx];

  const result = useMemo(
    () => calculate(modelInfo, quantInfo.bytesPerParam, gpuInfo, contextLength),
    [modelInfo, quantInfo, gpuInfo, contextLength],
  );

  const laptopGpus = gpuList.map((g, i) => ({ g, i })).filter(({ g }) => g.category === "Laptop");
  const consumerGpus = gpuList.map((g, i) => ({ g, i })).filter(({ g }) => g.category === "Consumer");
  const datacenterGpus = gpuList.map((g, i) => ({ g, i })).filter(({ g }) => g.category === "Datacenter");
  const smallModels = modelList.map((m, i) => ({ m, i })).filter(({ m }) => !m.isMoE && m.totalParams <= 15);
  const mediumModels = modelList.map((m, i) => ({ m, i })).filter(({ m }) => !m.isMoE && m.totalParams > 15 && m.totalParams < 100);
  const largeModels = modelList.map((m, i) => ({ m, i })).filter(({ m }) => !m.isMoE && m.totalParams >= 100);
  const moeModels = modelList.map((m, i) => ({ m, i })).filter(({ m }) => m.isMoE);

  return (
    <div className="min-h-screen">
      <style>
        {`
          @keyframes statusGlow {
            0%, 100% { box-shadow: 0 0 8px var(--status-glow); }
            50% { box-shadow: 0 0 20px var(--status-glow); }
          }
        `}
      </style>

      {/* Hero */}
      <section className="relative border-b border-border/40 bg-gradient-to-b from-background to-muted/20 px-6 py-24 text-center overflow-hidden">
        <DottedGrid />
        <GlowOrbs />
        <FadeIn>
          <Badge variant="secondary" className="mb-4">
            <Cpu className="mr-1 h-3 w-3" />
            Calculator
          </Badge>
          <h1 className="font-display mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
            Infrastructure Calculator
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
            Estimate GPU and hardware requirements for self-hosting open-source LLMs with JUDICA.
            Supports laptop, desktop, and datacenter GPUs with dense and MoE architectures.
          </p>
        </FadeIn>
      </section>

      {/* Calculator */}
      <section className="mx-auto max-w-5xl px-6 py-20">
        <div className="grid gap-8 lg:grid-cols-2">
          {/* Input */}
          <FadeIn direction="left">
            <TiltCard className="rounded-xl" tiltAmount={4}>
              <Card>
                <CardHeader>
                  <CardTitle className="font-display">Configuration</CardTitle>
                  <CardDescription>
                    Select your model, quantization level, target GPU, and context length.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Model select */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Model</label>
                    <Select value={String(modelIdx)} onValueChange={(v) => setModelIdx(Number(v))}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">Small (≤15B)</div>
                        {smallModels.map(({ m, i }) => (
                          <SelectItem key={i} value={String(i)}>{m.name}</SelectItem>
                        ))}
                        <div className="mt-1 px-2 py-1 text-xs font-semibold text-muted-foreground">Medium (15B–100B)</div>
                        {mediumModels.map(({ m, i }) => (
                          <SelectItem key={i} value={String(i)}>{m.name}</SelectItem>
                        ))}
                        <div className="mt-1 px-2 py-1 text-xs font-semibold text-muted-foreground">Large (100B+)</div>
                        {largeModels.map(({ m, i }) => (
                          <SelectItem key={i} value={String(i)}>{m.name}</SelectItem>
                        ))}
                        <div className="mt-1 px-2 py-1 text-xs font-semibold text-muted-foreground">MoE Models</div>
                        {moeModels.map(({ m, i }) => (
                          <SelectItem key={i} value={String(i)}>{m.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>{modelInfo.label}</span>
                      <span>&middot;</span>
                      <span>{modelInfo.totalParams}B total params</span>
                      {modelInfo.isMoE && modelInfo.activeParams && (
                        <>
                          <span>&middot;</span>
                          <span className="text-blue-400">Active: {modelInfo.activeParams}B</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Quantization select */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Quantization</label>
                    <Select value={String(quantIdx)} onValueChange={(v) => setQuantIdx(Number(v))}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {quantOptions.map((q, i) => (
                          <SelectItem key={i} value={String(i)}>
                            {q.name} ({q.bytesPerParam} bytes/param)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* GPU select */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">GPU</label>
                    <Select value={String(gpuIdx)} onValueChange={(v) => setGpuIdx(Number(v))}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">
                          💻 Laptop GPUs
                        </div>
                        {laptopGpus.map(({ g, i }) => (
                          <SelectItem key={i} value={String(i)}>
                            {g.name} ({g.vram} GB)
                          </SelectItem>
                        ))}
                        <div className="mt-1 px-2 py-1 text-xs font-semibold text-muted-foreground">
                          🖥 Consumer Desktop
                        </div>
                        {consumerGpus.map(({ g, i }) => (
                          <SelectItem key={i} value={String(i)}>
                            {g.name} ({g.vram} GB)
                          </SelectItem>
                        ))}
                        <div className="mt-1 px-2 py-1 text-xs font-semibold text-muted-foreground">
                          🏢 Datacenter
                        </div>
                        {datacenterGpus.map(({ g, i }) => (
                          <SelectItem key={i} value={String(i)}>
                            {g.name} ({g.vram} GB)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {gpuInfo.category === "Laptop" && (
                      <p className="text-xs text-yellow-400/80">
                        ⚠ Laptop GPUs may thermal-throttle during extended inference. Speeds are estimated conservatively.
                      </p>
                    )}
                  </div>

                  {/* Context length slider */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Context Length:{" "}
                      <span className="text-primary">{contextLabels[contextLength]}</span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={contextLengths.length - 1}
                      value={ctxIdx}
                      onChange={(e) => setCtxIdx(Number(e.target.value))}
                      className="w-full accent-primary"
                    />
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      {contextLengths.map((cl) => (
                        <span key={cl}>{contextLabels[cl]}</span>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TiltCard>
          </FadeIn>

          {/* Results */}
          <FadeIn direction="right">
            <TiltCard className="rounded-xl" tiltAmount={4}>
              <Card>
                <CardHeader>
                  <CardTitle className="font-display">Results</CardTitle>
                  <CardDescription>
                    Estimated hardware requirements for your configuration.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="rounded-lg border border-border/50 bg-muted/10 p-4">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <HardDrive className="h-4 w-4" />
                        Total VRAM
                      </div>
                      <p className="font-display mt-1 text-2xl font-bold">
                        {result.totalVram.toFixed(1)} GB
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Model: {result.modelVram.toFixed(1)} GB + KV: {result.kvCacheVram.toFixed(1)} GB
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/50 bg-muted/10 p-4">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Cpu className="h-4 w-4" />
                        GPUs Needed
                      </div>
                      <p className="font-display mt-1 text-2xl font-bold">
                        {result.gpusNeeded}× {gpuInfo.name.split(" ").slice(0, 2).join(" ")}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {result.vramPerGpu.toFixed(1)} GB / GPU
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/50 bg-muted/10 p-4">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Zap className="h-4 w-4" />
                        Est. Speed
                      </div>
                      <p className="font-display mt-1 text-2xl font-bold">~{result.estimatedTps} tok/s</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">Single user, rough estimate</p>
                    </div>
                    {result.gpusNeeded > 1 && (
                      <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
                        <div className="flex items-center gap-2 text-sm text-blue-400">
                          <Layers className="h-4 w-4" />
                          Multi-GPU
                        </div>
                        <p className="mt-1 text-sm font-medium text-blue-300">
                          Tensor parallelism across {result.gpusNeeded} GPUs
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Requires NVLink / PCIe for best performance
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Status */}
                  <div
                    className={`flex items-start gap-3 rounded-lg border p-4 transition-all duration-500 ${
                      result.fits
                        ? "border-emerald-500/30 bg-emerald-500/5"
                        : result.gpusNeeded <= 4
                          ? "border-yellow-500/30 bg-yellow-500/5"
                          : "border-red-500/30 bg-red-500/5"
                    }`}
                    style={
                      {
                        "--status-glow": statusGlowColor(result.fits, result.gpusNeeded),
                        animation: "statusGlow 2.5s ease-in-out infinite",
                      } as React.CSSProperties
                    }
                  >
                    {result.fits ? (
                      <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
                    ) : result.gpusNeeded <= 4 ? (
                      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-yellow-500" />
                    ) : (
                      <X className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
                    )}
                    <div>
                      <p className="text-sm font-medium">
                        {result.fits ? "Fits on a single GPU" : `Requires ${result.gpusNeeded} GPUs`}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">{result.recommendation}</p>
                    </div>
                  </div>

                  {modelInfo.isMoE && (
                    <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4">
                      <p className="text-xs text-blue-300">
                        <span className="font-semibold">MoE Note:</span> All {modelInfo.totalParams}B
                        parameters must be loaded into VRAM, but only {modelInfo.activeParams}B are
                        active per token. Inference speed scales with active parameters, not total.
                      </p>
                    </div>
                  )}

                  <div className="rounded-lg border border-border/50 bg-muted/10 p-4">
                    <p className="text-xs text-muted-foreground">
                      Estimates include KV cache for the selected context length. Actual requirements
                      vary based on batch size, framework overhead, and attention implementation (GQA,
                      MQA). For production deployments, add 10-20% additional headroom. Speed
                      estimates are approximate and depend on hardware configuration and serving
                      framework.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </TiltCard>
          </FadeIn>
        </div>
      </section>
    </div>
  );
}
