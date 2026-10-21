import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/client.ts", "src/testing.ts"],
  format: ["esm"],
  platform: "neutral",
  dts: true,
  clean: true,
  sourcemap: false,
});
