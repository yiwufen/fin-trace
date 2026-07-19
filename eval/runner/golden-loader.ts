// 加载 golden set YAML
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as yamlLoad } from "js-yaml";
import type { Scenario, GroundTruth } from "../types.js";

const GOLDEN_DIR = resolve(import.meta.dirname, "../golden");

export function loadScenarios(): Scenario[] {
  const raw = readFileSync(resolve(GOLDEN_DIR, "scenarios.yaml"), "utf-8");
  const doc = yamlLoad(raw) as { scenarios: Scenario[] };
  return doc.scenarios;
}

export function loadScenario(id: string): Scenario {
  const all = loadScenarios();
  const found = all.find((s) => s.id === id);
  if (!found) throw new Error(`[golden] scenario "${id}" not found; available: ${all.map((s) => s.id).join(", ")}`);
  return found;
}

export function loadGroundTruth(scenarioId: string): GroundTruth {
  const raw = readFileSync(resolve(GOLDEN_DIR, "ground-truth", `${scenarioId}.yaml`), "utf-8");
  return yamlLoad(raw) as GroundTruth;
}
