import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // 화면 조각 렌더 테스트(test/*.test.tsx): next 의 jsx: preserve 대신 React 자동 런타임으로 변환하고 @/ 별칭을 맞춘다.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
  },
});
