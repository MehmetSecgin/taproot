const DETAIL_MAX_CHARS = 400;

export function truncateDetail(text: string): string {
  return text.slice(0, DETAIL_MAX_CHARS);
}
