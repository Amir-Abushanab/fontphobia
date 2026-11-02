export function generateStaticParams() {
  return [{ id: "1" }, { id: "2" }];
}


export default async function Post({ params }: PageProps<"/posts/[id]">) {
  const { id } = await params;
  return <h1>Post {id}</h1>;
}
