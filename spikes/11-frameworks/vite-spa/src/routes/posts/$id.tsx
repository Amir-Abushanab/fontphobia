import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/posts/$id')({
  component: Post,
})

function Post() {
  const { id } = Route.useParams()
  return <h1>Post {id}</h1>
}
