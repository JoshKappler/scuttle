import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  // ONE canonical dev port. strictPort makes Vite FAIL (not silently hop to 5174,
  // 5175, …) if 5173 is already taken, so you can never accidentally run two servers
  // and end up playing a stale one. If a launch errors with "Port 5173 is in use",
  // close the other SCUTTLE window (or kill the old `vite` process) and relaunch.
  server: { port: 5173, strictPort: true },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
