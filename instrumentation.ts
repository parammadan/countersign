export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // before anything else, and before the worker sends reminders: no APP_SECRET in production, no server. Next.js
    // logs an error thrown here and keeps serving (every request then fails with a 500), so the process exits
    // itself: a deploy's health check fails at once and nothing half-starts.
    const { checkSecretAtBoot } = await import("./lib/secret");
    try {
      checkSecretAtBoot();
    } catch (e) {
      console.error(`[boot] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    const { startWorker } = await import("./lib/worker");
    startWorker();
  }
}
