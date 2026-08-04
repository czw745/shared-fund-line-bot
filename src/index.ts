import { createWorker } from "./app";
import { CloudProviders } from "./cloud-providers";
import { D1Store } from "./d1-store";
import type { CloudEnv } from "./types";

export default {
  async fetch(request: Request, env: CloudEnv): Promise<Response> {
    const providers = new CloudProviders(env);
    return createWorker({ store: new D1Store(env.DB), providers }).fetch(request, env);
  },
  async scheduled(event: ScheduledEvent, env: CloudEnv): Promise<void> {
    const providers = new CloudProviders(env);
    await createWorker({ store: new D1Store(env.DB), providers }).scheduled?.(event, env);
  },
};
