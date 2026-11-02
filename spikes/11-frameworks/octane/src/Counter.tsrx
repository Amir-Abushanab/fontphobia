import { useState } from "octane";
import { Layout } from "./Layout.tsrx";

export function Counter() @{
  const [count, setCount] = useState(0);

  <Layout>
    <style>
      .counter {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1.25rem;
        text-align: center;
      }
      .title {
        margin: 0;
        font-size: 2rem;
        line-height: 1.1;
        letter-spacing: -0.02em;
      }
      .lede {
        max-width: 34rem;
        margin: 0;
        color: var(--text-secondary);
        font-size: 1.25rem;
      }
      /* The site's primary action: an accent pill. */
      .button {
        padding: 0.7rem 1.4rem;
        border: none;
        border-radius: 9999px;
        background: var(--accent);
        color: var(--on-accent);
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s;
      }
      .button:hover {
        background: var(--accent-hover);
      }
    </style>
    <section class="counter">
      <h1 class="title">Server-rendered, then interactive</h1>
      <p class="lede">
        This page was rendered on the server and hydrated in the browser. View
        source to see the markup arrive complete, then press the button.
      </p>
      <button class="button" onClick={() => setCount(count + 1)}>
        {"Pressed " + count + " times"}
      </button>
    </section>
  </Layout>
}
