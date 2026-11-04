import { Links, Meta, Outlet, Scripts } from 'react-router';

export default function App() {
  return (
    <html lang="en">
      <head><Meta /><Links /></head>
      <body><Outlet /><Scripts /></body>
    </html>
  );
}
