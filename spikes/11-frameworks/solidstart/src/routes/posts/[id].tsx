import { useParams } from "@solidjs/router";

export default function Post() {
  const params = useParams();
  return <main><h1>Post {params.id}</h1></main>;
}
