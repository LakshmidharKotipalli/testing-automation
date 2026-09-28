import { existsSync } from "node:fs";
import type { BrowserConfig } from "@browserswarm/core";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
} from "playwright";

/**
 * Browser launch abstraction. The orchestrator receives a launcher by injection so tests can prove that no
 * browser is launched before approval (a counting launcher) and so alternative runtimes can be plugged in.
 */
export interface BrowserLauncher {
  launch(config: BrowserConfig): Promise<BrowserHandle>;
}

export interface BrowserHandle {
  newContext(options: BrowserContextOptions): Promise<BrowserContext>;
  close(): Promise<void>;
}

function resolveExecutable(engine: BrowserConfig["engine"]): string | undefined {
  const explicit = process.env.BROWSERSWARM_CHROMIUM_EXECUTABLE;
  if (engine === "chromium" && explicit && existsSync(explicit)) return explicit;
  return undefined;
}

export class PlaywrightLauncher implements BrowserLauncher {
  launches = 0;

  async launch(config: BrowserConfig): Promise<BrowserHandle> {
    this.launches++;
    const type = config.engine === "firefox" ? firefox : config.engine === "webkit" ? webkit : chromium;
    const executablePath = resolveExecutable(config.engine);
    const browser: Browser = await type.launch({
      headless: config.headless,
      ...(executablePath ? { executablePath } : {}),
    });
    return {
      newContext: (options) => browser.newContext(options),
      close: () => browser.close(),
    };
  }
}

/** Wraps a launcher and records every launch; used by tests and by the approval-gate audit. */
export class CountingLauncher implements BrowserLauncher {
  launches = 0;
  contexts = 0;
  constructor(private readonly inner: BrowserLauncher = new PlaywrightLauncher()) {}
  async launch(config: BrowserConfig): Promise<BrowserHandle> {
    this.launches++;
    const handle = await this.inner.launch(config);
    return {
      newContext: async (options) => {
        this.contexts++;
        return handle.newContext(options);
      },
      close: () => handle.close(),
    };
  }
}
