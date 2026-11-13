import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/about')({ component: About });

function About() {
  return <h1 style={{ fontFamily: 'Fraunces, serif' }}>About (Fraunces)</h1>;
}
