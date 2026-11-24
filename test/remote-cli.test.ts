import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { restoreProcessEnv } from './helpers/query-state.js';
import { startRemoteCliDaemon } from './helpers/remote-cli-daemon.js';

const REMOTE_CLI = fileURLToPath(new URL('helpers/remote-cli-main.ts', import.meta.url));
const CommandSchema = z.object({ name: z.string() });
const HelpDataSchema = z.object({ commands: z.array(CommandSchema) });
const HelpEnvelopeSchema = z.object({ data: HelpDataSchema });
const remote = await startRemoteCliDaemon();

async function execRemoteCli(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const child = spawn(process.execPath, ['--import', 'tsx', REMOTE_CLI, ...args], { env: { ...process.env, ...remote.cliEnv }, stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      resolve(code ?? 1);
    });
  });
  return { stdout, exitCode };
}

async function runRemoteCli(args: string[]): Promise<{ lines: string[]; json: unknown; exitCode: number }> {
  const { stdout, exitCode } = await execRemoteCli(args);
  const lines = stdout.trim().split('\n');
  const json: unknown = JSON.parse(lines[0]);
  return { lines, json, exitCode };
}

describe('a CLI built with the remote executor', () => {
  afterAll(async () => {
    await remote.daemon.stop();
    restoreProcessEnv();
  });

  it('lists only the commands it was built with', async () => {
    // act
    const { json } = await runRemoteCli(['--help']);

    // assert
    const { commands } = HelpEnvelopeSchema.parse(json).data;
    expect(commands.map((command) => command.name.split(' ')[0])).toStrictEqual(['datasource', 'schema', 'query', 'help']);
  });

  it.each([
    [['schema', '--table', 'orders'], "error: required option '--datasource <name>' not specified"],
    [['datasource', 'list', '--bogus'], "error: unknown option '--bogus'"],
    [['doctor'], "error: unknown command 'doctor'"],
  ])('answers %j with one line of JSON', async (args, message) => {
    // act
    const { lines, json } = await runRemoteCli(args);

    // assert
    expect(lines).toHaveLength(1);
    expect(json).toStrictEqual({ ok: false, error: { code: 'CLI_ERROR', message } });
  });

  it('runs a query on the daemon', async () => {
    // act
    const { json } = await runRemoteCli(['query', '--datasource', 'qa-fake', '--sql', 'SELECT table_name FROM orders', '--pluck', 'data.rows']);

    // assert
    expect(json).toStrictEqual([['orders', 'id']]);
  });

  it('lists the daemon datasources', async () => {
    // act
    const { json } = await runRemoteCli(['datasource', 'list', 'fake', '--pluck', 'data.rows']);

    // assert
    expect(json).toStrictEqual([['qa-fake', 'mysql', 'qa', 'fake', '127.0.0.1', 'fake']]);
  });

  it('exits 5 with the refusal alone for a datasource the daemon refuses', async () => {
    // act
    const { json, exitCode } = await runRemoteCli(['schema', '--datasource', 'qa-closed']);

    // assert
    expect(json).toStrictEqual({ ok: false, error: { code: 'DATASOURCE_REFUSED', message: "DATASOURCE_REFUSED: 'qa-closed' is not served here." } });
    expect(exitCode).toBe(5);
  });

  it('names itself in the query help', async () => {
    // act
    const { json } = await runRemoteCli(['query', '--help']);

    // assert
    const help = JSON.stringify(json);
    expect(help).toContain('Example: remote query --datasource');
    expect(help).not.toContain('taproot query');
  });

  it('reads table names from the daemon schema cache', async () => {
    // act
    const { json } = await runRemoteCli(['schema', '--datasource', 'qa-fake']);

    // assert
    expect(json).toStrictEqual({ ok: true, data: { tables: ['orders'] } });
  });
});
