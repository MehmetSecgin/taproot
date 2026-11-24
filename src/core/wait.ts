export async function waitMs(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
