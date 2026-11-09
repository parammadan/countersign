export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // before anything else, and before the worker sends reminders: no APP_SECRET in production, no server
    const { checkSecretAtBoot } = await import("./lib/secret");
    checkSecretAtBoot();
    const { startWorker } = await import("./lib/worker");
    startWorker();
  }
}
