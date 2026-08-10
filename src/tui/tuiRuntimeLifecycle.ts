const MANAGED_PLUGIN_FINAL_CLOSE_ATTEMPTS = 2;
const MANAGED_PLUGIN_FINAL_CLOSE_TIMEOUT_MS = 35_000;

export function tuiErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function closeManagedPluginsForExit(close: () => Promise<void>): Promise<void> {
  const failures: unknown[] = [];
  for (let attempt = 1; attempt <= MANAGED_PLUGIN_FINAL_CLOSE_ATTEMPTS; attempt += 1) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        close(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(
              `managed plugin cleanup timed out after ${MANAGED_PLUGIN_FINAL_CLOSE_TIMEOUT_MS}ms`,
            ));
          }, MANAGED_PLUGIN_FINAL_CLOSE_TIMEOUT_MS);
        }),
      ]);
      return;
    } catch (error) {
      failures.push(error);
      process.stderr.write(
        `[hadamard-tui] warning: managed plugin cleanup attempt ${attempt}/` +
        `${MANAGED_PLUGIN_FINAL_CLOSE_ATTEMPTS} failed: ${tuiErrorMessage(error)}\n`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw new AggregateError(
    failures,
    'Managed plugin cleanup failed after bounded retries; an external sandbox may remain active and billing may continue.',
  );
}
