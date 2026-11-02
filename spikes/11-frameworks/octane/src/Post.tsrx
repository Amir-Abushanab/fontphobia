import type { RenderRouteProps } from "@octanejs/vite-plugin";
import { Layout } from "./Layout.tsrx";

export function Post(props: RenderRouteProps) @{
  <Layout>
    <section>
      <h1>{"Post " + props.params.id}</h1>
      <p>Dynamic route /posts/:id.</p>
    </section>
  </Layout>
}
