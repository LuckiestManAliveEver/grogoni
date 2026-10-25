import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __APP_NAME__: JSON.stringify("Grogoni"),
    __APP_VERSION__: JSON.stringify("test"),
    __BUILD_TIMESTAMP__: JSON.stringify("test"),
    __DEPLOYMENT_ENV__: JSON.stringify("test"),
    __DEBUG_UI__: "false",
    __GIT_COMMIT_SHA__: JSON.stringify("test")
  },
  resolve: {
    alias: {
      react: fileURLToPath(new URL("./apps/web/node_modules/react", import.meta.url)),
      "react-dom": fileURLToPath(new URL("./apps/web/node_modules/react-dom", import.meta.url))
    }
  },
  test: {
    environment: "node",
    setupFiles: [fileURLToPath(new URL("./tests/setup/jsdom-shims.ts", import.meta.url))],
    include: [
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "packages/**/*.test.ts",
      "services/**/*.test.ts"
    ]
  }
});
