export function parseJson(stdout: string): unknown {
  return JSON.parse(stdout);
}
