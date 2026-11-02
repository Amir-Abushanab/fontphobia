import { MetaProvider, Title } from "@solidjs/meta";
import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";
import "@fontsource-variable/inter";
import "./app.css";

export default function App() {
  return (
    <Router
      root={props => (
        <MetaProvider>
          <Title>SolidStart - Basic</Title>
          <a href="/">Index</a>
          <a href="/about">About</a>
          <a href="/posts/1">Post 1</a>
          <a href="/posts/2">Post 2</a>
          <Suspense>{props.children}</Suspense>
        </MetaProvider>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
