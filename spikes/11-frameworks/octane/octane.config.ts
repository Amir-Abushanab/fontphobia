import { defineConfig, RenderRoute, ServerRoute } from "@octanejs/vite-plugin";
import { health } from "./src/server/health.ts";

export default defineConfig({
  router: {
    routes: [
      new RenderRoute({ path: "/", entry: ["App", "/src/App.tsrx"] }),
      new RenderRoute({ path: "/counter", entry: ["Counter", "/src/Counter.tsrx"] }),
      new RenderRoute({ path: "/about", entry: ["About", "/src/About.tsrx"] }),
      new RenderRoute({ path: "/posts/:id", entry: ["Post", "/src/Post.tsrx"] }),
      new ServerRoute({ path: "/api/health", handler: health }),
    ],
  },
});
