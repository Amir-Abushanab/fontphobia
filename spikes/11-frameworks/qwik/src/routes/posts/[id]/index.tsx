import { component$ } from "@builder.io/qwik";
import { useLocation, type StaticGenerateHandler } from "@builder.io/qwik-city";

export default component$(() => {
  const loc = useLocation();
  return <h1>Post {loc.params.id}</h1>;
});

export const onStaticGenerate: StaticGenerateHandler = async () => ({
  params: [{ id: "1" }, { id: "2" }],
});
