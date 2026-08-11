import fs from 'node:fs';
import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { printJson, printJsonPluck, renderTable } from '../core/output.js';
import { rpcCall } from '../daemon/client.js';
import { RpcMethod } from '../daemon/types.js';

interface BenchScenario {
  name?: string;
  datasource?: string;
  env?: string;
  service?: string;
  namespace?: string;
  query?: string;
  intent?: string;
  param?: string[];
  iterations?: number;
  allowMutate?: boolean;
}

interface BenchScenarioConfig {
  iterations?: number;
  scenarios: BenchScenario[];
}

export interface IterationSample {
  scenario: string;
  ok: boolean;
  totalMs: number;
  resolveMs?: number;
  connectMs?: number;
  executeMs?: number;
  errorCode?: string;
}

interface ScenarioSummary {
  scenario: string;
  iterations: number;
  successes: number;
  failures: number;
  total: PhaseStats;
  resolve: PhaseStats;
  connect: PhaseStats;
  execute: PhaseStats;
  errors: Record<string, number>;
}

interface PhaseStats {
  avg: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

export function percentile(sorted: number[], pct: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function phaseStats(values: number[]): PhaseStats {
  if (!values.length) return { avg: 0, p50: 0, p95: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    avg: Math.round(sum / sorted.length),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export function summarize(samples: IterationSample[], scenarioName: string): ScenarioSummary {
  const successes = samples.filter((s) => s.ok);
  const errors: Record<string, number> = {};
  for (const s of samples) {
    if (!s.ok && s.errorCode) errors[s.errorCode] = (errors[s.errorCode] || 0) + 1;
  }
  return {
    scenario: scenarioName,
    iterations: samples.length,
    successes: successes.length,
    failures: samples.length - successes.length,
    total: phaseStats(successes.map((s) => s.totalMs)),
    resolve: phaseStats(successes.map((s) => s.resolveMs || 0)),
    connect: phaseStats(successes.map((s) => s.connectMs || 0)),
    execute: phaseStats(successes.map((s) => s.executeMs || 0)),
    errors,
  };
}

function loadScenarioFile(file: string): BenchScenarioConfig {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as Partial<BenchScenarioConfig>;
  if (!parsed.scenarios || !Array.isArray(parsed.scenarios)) {
    throw new Error(`Invalid scenario file: missing scenarios[] in ${file}`);
  }
  return { iterations: parsed.iterations, scenarios: parsed.scenarios };
}

async function runScenario(scenario: BenchScenario, iterations: number, timeoutMs: number): Promise<IterationSample[]> {
  const out: IterationSample[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = Date.now();
    try {
      const rpc = await rpcCall({
        timeoutMs: Math.max(RUNTIME_CONSTANTS.rpc.requestTimeoutMs, timeoutMs + 1000),
        method: RpcMethod.QueryExecute,
        params: {
          datasource: scenario.datasource,
          env: scenario.env,
          service: scenario.service,
          namespace: scenario.namespace,
          query: scenario.query,
          intent: scenario.intent,
          allowMutate: Boolean(scenario.allowMutate),
          timeoutMs,
          param: scenario.param || [],
        },
      });
      const phases = (rpc.meta?.phases as Record<string, number> | undefined) || {};
      const totalMs = typeof phases.totalMs === 'number' ? phases.totalMs : Date.now() - start;
      if (rpc.ok) {
        out.push({
          scenario: scenario.name || scenario.datasource || 'scenario',
          ok: true,
          totalMs,
          resolveMs: phases.resolveMs,
          connectMs: phases.connectMs,
          executeMs: phases.executeMs,
        });
      } else {
        out.push({
          scenario: scenario.name || scenario.datasource || 'scenario',
          ok: false,
          totalMs,
          errorCode: rpc.error?.code || 'UNKNOWN',
        });
      }
    } catch (error) {
      out.push({
        scenario: scenario.name || scenario.datasource || 'scenario',
        ok: false,
        totalMs: Date.now() - start,
        errorCode: (error as Error & { code?: string }).code || 'TRANSPORT',
      });
    }
  }
  return out;
}

export function registerBench(program: Command, getCtx: () => AppContext): void {
  program
    .command('bench')
    .description('Benchmark query latency with phase timing breakdown (resolve/connect/execute)')
    .option('--datasource <name>', 'datasource to benchmark (alternative: --scenario <file>)')
    .option('--query <native>', 'query to run each iteration')
    .option('--intent <intent>', 'intent label recorded in the runs ledger')
    .option('--env <env>')
    .option('--service <service>')
    .option('--namespace <namespace>')
    .option('--param <key=value>', 'repeatable', (v, p: string[]) => (p || []).concat(v), [])
    .option('--iterations <n>', 'iterations per scenario', '10')
    .option('--scenario <file>', 'JSON file with { iterations, scenarios: [...] }')
    .option('--pluck <path>', 'return only the subtree at this dot-path of the JSON envelope')
    .option(
      '--timeout-ms <ms>',
      `per-query timeout (default ${RUNTIME_CONSTANTS.query.defaultTimeoutMs})`,
      String(RUNTIME_CONSTANTS.query.defaultTimeoutMs),
    )
    .action(async (opts) => {
      const ctx = getCtx();
      const timeoutMs = Math.max(1, Number(opts.timeoutMs) || RUNTIME_CONSTANTS.query.defaultTimeoutMs);
      const cliIterations = Math.max(1, Number(opts.iterations) || 10);

      let scenarios: BenchScenario[];
      let defaultIterations = cliIterations;
      if (opts.scenario) {
        const cfg = loadScenarioFile(String(opts.scenario));
        scenarios = cfg.scenarios;
        if (cfg.iterations) defaultIterations = Math.max(1, cfg.iterations);
      } else {
        if (!opts.datasource && !(opts.env && opts.service)) {
          throw new Error('Invalid argument: --datasource or --env+--service required (or use --scenario <file>).');
        }
        if (!opts.query) {
          throw new Error('Invalid argument: --query required.');
        }
        scenarios = [
          {
            name: opts.datasource ? `bench:${opts.datasource}` : `bench:${opts.env}-${opts.service}`,
            datasource: opts.datasource,
            env: opts.env,
            service: opts.service,
            namespace: opts.namespace,
            query: opts.query,
            intent: opts.intent,
            param: opts.param,
            iterations: cliIterations,
          },
        ];
      }

      const scenarioSummaries: ScenarioSummary[] = [];
      const startedAt = new Date().toISOString();
      for (const scenario of scenarios) {
        const iterations = Math.max(1, scenario.iterations || defaultIterations);
        const samples = await runScenario(scenario, iterations, timeoutMs);
        const summary = summarize(samples, scenario.name || scenario.datasource || 'scenario');
        scenarioSummaries.push(summary);
      }
      const endedAt = new Date().toISOString();

      const totalIterations = scenarioSummaries.reduce((acc, s) => acc + s.iterations, 0);
      const totalFailures = scenarioSummaries.reduce((acc, s) => acc + s.failures, 0);
      const allTotal = scenarioSummaries.flatMap((s) =>
        s.total.avg ? new Array(s.successes).fill(s.total.avg) : [],
      );

      const payload = {
        ok: totalFailures === 0,
        data: {
          startedAt,
          endedAt,
          totalIterations,
          totalFailures,
          aggregate: phaseStats(allTotal),
          scenarios: scenarioSummaries,
        },
      };

      if (ctx.jsonMode) {
        if (opts.pluck) printJsonPluck(payload, String(opts.pluck));
        else printJson(payload);
        if (totalFailures) process.exitCode = 1;
        return;
      }

      console.log(`bench started=${startedAt} ended=${endedAt} iterations=${totalIterations} failures=${totalFailures}`);
      const tableRows = scenarioSummaries.map((s) => ({
        scenario: s.scenario,
        iter: s.iterations,
        ok: s.successes,
        fail: s.failures,
        total_p50: s.total.p50,
        total_p95: s.total.p95,
        resolve_p50: s.resolve.p50,
        connect_p50: s.connect.p50,
        execute_p50: s.execute.p50,
      }));
      console.log(renderTable(tableRows as unknown as Record<string, unknown>[]));
      for (const s of scenarioSummaries) {
        if (Object.keys(s.errors).length) {
          const detail = Object.entries(s.errors).map(([code, count]) => `${code}=${count}`).join(' ');
          console.log(`[${s.scenario}] errors: ${detail}`);
        }
      }
      if (totalFailures) process.exitCode = 1;
    });
}
