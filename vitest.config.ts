import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

// Workspace packages resolve to their TypeScript sources during tests so no build step is needed.
const alias = [
  {
    find: /^@browserswarm\/([a-z-]+)$/,
    replacement: path.join(root, "packages/$1/src/index.ts"),
  },
];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["packages/*/tests/**/*.test.ts", "apps/*/tests/**/*.test.ts"],
          exclude: ["**/tests/integration/**"],
          environment: "node",
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["packages/*/tests/integration/**/*.test.ts", "apps/*/tests/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 90_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
