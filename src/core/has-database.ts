export function hasDatabase(database: unknown): boolean {
  return database !== undefined && database !== null && database !== '';
}
