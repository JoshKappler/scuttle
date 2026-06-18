import { defineConfig } from "vitest/config";
import { execSync } from "node:child_process";

// Dev-only build badge feed. Serves the current git commit (read FRESH per request, so it reflects
// HEAD even after you commit without restarting the server) at /__build. index.html shows it top-left
// so you can SEE - at a glance - that the running build IS the latest committed one (the recurring
// "is this even the new version?" trap). Inert in `vite build` (apply:"serve") so the packaged EXE
// simply 404s it and the badge stays hidden.
function buildStamp() {
  return {
    name: "scuttle-build-stamp",
    apply: "serve" as const,
    configureServer(server: any) {
      server.middlewares.use("/__build", (_req: any, res: any) => {
        let hash = "unknown";
        let dirty = false;
        try { hash = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { /* not a repo / no git */ }
        try { dirty = execSync("git status --porcelain", { encoding: "utf8" }).toString().trim().length > 0; } catch { /* ignore */ }
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ hash, dirty }));
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [buildStamp()],
  // ONE canonical dev port. strictPort makes Vite FAIL (not silently hop to 5174,
  // 5175, …) if 5173 is already taken, so you can never accidentally run two servers
  // and end up playing a stale one. If a launch errors with "Port 5173 is in use",
  // close the other SCUTTLE window (or kill the old `vite` process) and relaunch.
  server: { port: 5173, strictPort: true },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The big-hull "port/starboard symmetric" scans run hundreds of thousands of
    // per-cell expect()s (frigate/man-o'-war), which legitimately take ~10s and
    // FALSE-FAIL the 5s default under any CPU contention (a known load flake).
    // 20s gives headroom without masking a genuinely hung test.
    testTimeout: 20000,
  },
});
