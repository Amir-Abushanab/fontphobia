import type { Route } from './+types/post';

export function loader({ params }: Route.LoaderArgs) {
  return { id: params.id };
}

export default function Post({ loaderData }: Route.ComponentProps) {
  return <h1>Post {loaderData.id}</h1>;
}
