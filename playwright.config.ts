import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const chromiumExecutablePath = [
  process.env.PW_CHROMIUM_EXECUTABLE_PATH,
  "/chromium_headless_shell-1194/chrome-linux/headless_shell",
  "/chromium-1194/chrome-linux/chrome",
].find((path): path is string => Boolean(path && existsSync(path)));

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8080",
    trace: "on-first-retry",
    viewport: { width: 1280, height: 1800 },
    launchOptions: chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : undefined,
  },
  webServer: {
    command: "bun run dev -- --host 0.0.0.0 --port 8080",
    url: "http://localhost:8080",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});