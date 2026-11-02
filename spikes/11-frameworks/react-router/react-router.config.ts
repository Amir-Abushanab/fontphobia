import type { Config } from "@react-router/dev/config";

// RR_SPA=1 -> ssr: false (static: prerendered HTML + SPA fallback, no server build).
const ssr = process.env.RR_SPA !== "1";

export default {
  // Config options...
  // Server-side render by default, to enable SPA mode set this to `false`
  ssr,
  prerender: ["/", "/about", "/posts/1", "/posts/2"],
  // Framework build hook: runs once after the Vite builds AND prerendering.
  async buildEnd({ reactRouterConfig, viteConfig }) {
    console.log("[probe] buildEnd", reactRouterConfig.buildDirectory, "ssr=" + reactRouterConfig.ssr);
  },
} satisfies Config;
