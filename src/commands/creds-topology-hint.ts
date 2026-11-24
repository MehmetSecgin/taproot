const TOPOLOGY_FLAG_PATTERN = /(?:--host|--port|--database|--target)/u;

export function credsTopologyHint(message: string, argv: string[]): string | undefined {
  const lower = message.toLowerCase();
  const isTopologyFlagOnCredsSet = lower.includes('unknown option') && TOPOLOGY_FLAG_PATTERN.test(lower) && argv.includes('creds') && argv.includes('set');
  return isTopologyFlagOnCredsSet
    ? `${message}. Connection topology (--host, --port, --database, --target) belongs on the datasource profile ('taproot datasource add'), not on credentials.`
    : undefined;
}
