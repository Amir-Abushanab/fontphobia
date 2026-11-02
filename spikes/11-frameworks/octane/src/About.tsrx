import { Layout } from "./Layout.tsrx";

export function About() @{
  <Layout>
    <style>
      .about h1 { font-family: "Fraunces", serif; }
    </style>
    <section class="about">
      <title>About · Octane app</title>
      <h1>About</h1>
      <p>Static page set in Fraunces (Google Fonts) and Inter (fontsource).</p>
      <p><a href="/posts/1">Post 1</a> · <a href="/posts/2">Post 2</a></p>
    </section>
  </Layout>
}
