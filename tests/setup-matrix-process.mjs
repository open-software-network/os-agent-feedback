import { createServer } from "node:net";

export async function assertPortAvailable(port, label) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error) => {
      reject(
        new Error(
          `${label} cannot start because 127.0.0.1:${port} is already in use; stop the stale process before rerunning the setup matrix (${error.code || error.message})`,
        ),
      );
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
  });
}
