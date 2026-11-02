import { Layout } from "./Layout.tsrx";

const LINKS = [
  {
    href: "https://octanejs.dev/docs/quick-start",
    title: "Quick start",
    body: "Scaffold an app, mount a component, and the .tsrx essentials.",
  },
  {
    href: "https://octanejs.dev/docs/core-apis",
    title: "Core APIs",
    body: "State, events, context, effects, async UI, and server rendering.",
  },
  {
    href: "https://octanejs.dev/docs/tsrx-vs-tsx",
    title: "TSRX vs TSX",
    body: "What the .tsrx dialect adds on top of ordinary JSX.",
  },
  {
    href: "https://octanejs.dev/docs/differences-from-react",
    title: "Differences from React",
    body: "The deliberate divergences. Everything else matching is the point.",
  },
];

// The documentation cards. An assigned <style> is a theme: the page's own
// <style apply={linkTheme}> block below applies it, so its rules reach the
// items beside that block and everything below them.
const linkTheme = <style>
  .links {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: 0.75rem;
    width: 100%;
    max-width: 42rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .link {
    display: block;
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: 0.9rem;
    background: var(--surface-subtle);
    color: var(--text);
    text-align: left;
    text-decoration: none;
    transition:
      background 0.15s,
      border-color 0.15s,
      transform 0.15s;
  }
  .link:hover {
    border-color: var(--card-hover-border);
    background: var(--card-hover-bg);
    transform: translateY(-1px);
  }
  .link-title {
    display: block;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .link-body {
    display: block;
    margin-top: 0.15rem;
    color: var(--text-secondary);
    font-size: 0.82rem;
    line-height: 1.4;
  }
</style>;

export function App() @{
  <Layout>
    <section class="hero">
      <svg class="mark" viewBox="0 0 84 108" fill="none" aria-hidden="true">
        <path
          d="M71.0265 37.6009L65.8601 32.48C57.4266 24.1187 52.5193 13.6179 49.6691 1.55156C49.1892 -0.480713 46.2849 -0.534311 45.796 1.49572C43.135 12.5571 39.0884 21.441 31.9122 28.5539L29.1656 31.2763L32.1217 32.6051C34.5258 33.686 36.646 34.9098 38.604 36.3458C40.1609 37.487 41.4587 38.751 42.5898 40.0798L46.9068 35.8031L59.8758 48.6555C67.025 55.7439 67.025 67.2742 59.8758 74.3626L47.0622 87.0609C43.5969 90.4957 38.9915 92.385 34.0932 92.385C29.1949 92.385 24.5895 90.4935 21.1242 87.0609C13.975 79.9726 13.975 68.4422 21.1242 61.3539L26.4529 56.0722C27.6921 53.5084 29.6118 50.1138 31.1844 45.7858C32.4101 42.4136 31.8266 38.8649 29.4653 36.0733L27.1198 33.3041L9.97348 50.2992C-3.32449 63.4822 -3.32449 84.9304 9.97348 98.1133C16.6225 104.706 25.3578 108 34.0932 108C42.8286 108 51.564 104.704 58.213 98.1133L71.0265 85.415C84.3245 72.2321 84.3245 50.7838 71.0265 37.5986V37.6009Z"
          fill="currentColor"
        />
        <path
          d="M53.682 51.4605C56.0095 56.1079 55.4237 66.6802 46.9654 65.3715C45.0232 65.07 43.2928 64.0941 42.7183 61.8943C42.3578 60.5097 43.3131 58.2697 43.7705 56.9387C46.481 49.0441 43.0923 42.4136 37.2657 38.1413C35.5736 36.9019 33.6314 35.7384 31.1913 34.6396C34.0595 38.0274 34.8684 42.3801 33.2732 46.6277C32.3224 48.9481 31.0606 51.3958 29.9543 53.6514C27.9671 57.7047 26.3178 62.504 27.575 69.1591C28.1879 72.4063 30.2743 75.0706 32.2503 76.9532C26.4259 77.6522 24.1886 73.811 23.0305 72.1986C21.7935 70.4767 20.9328 66.0973 22.7173 62.935C16.4491 69.1502 16.4491 79.2669 22.7173 85.4843C25.759 88.4969 29.7989 90.154 34.0933 90.154C38.3878 90.154 42.4276 88.4969 45.4694 85.4843L56.6562 74.3984C63.0663 67.8527 61.0543 58.7722 53.6798 51.4628L53.682 51.4605Z"
          fill="#FF415A"
        />
      </svg>
      <h1 class="title">octane</h1>
      <p class="lede">
        React’s programming model, compiled. Edit src/App.tsrx and save — the page
        updates without a reload.
      </p>
      <ul class="links">
        @for (const link of LINKS; key link.href) {
          <li>
            <a class="link" href={link.href} target="_blank" rel="noreferrer">
              <span class="link-title">{link.title as string}</span>
              <span class="link-body">{link.body as string}</span>
            </a>
          </li>
        }
      </ul>
    </section>

    <style apply={linkTheme}>
      .hero {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1.25rem;
        text-align: center;
      }
      .mark {
        width: 5rem;
        height: auto;
      }
      .title {
        margin: 0;
        font-size: 3rem;
        line-height: 1.1;
        letter-spacing: -0.03em;
      }
      .lede {
        max-width: 34rem;
        margin: 0;
        color: var(--text-secondary);
        font-size: 1.25rem;
      }
    </style>
  </Layout>
}
