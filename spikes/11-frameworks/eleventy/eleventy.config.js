export default function (eleventyConfig) {
  // No bundler: fontsource is shipped by passthrough copy (CSS references ./files/*.woff2).
  eleventyConfig.addPassthroughCopy({ "node_modules/@fontsource-variable/inter/index.css": "fonts/inter/index.css" });
  eleventyConfig.addPassthroughCopy({ "node_modules/@fontsource-variable/inter/files/*-wght-normal.woff2": "fonts/inter/files" });

  // Build hooks.
  eleventyConfig.on("eleventy.before", ({ directories }) => console.log("[probe] eleventy.before", directories.output));
  eleventyConfig.on("eleventy.after", ({ results, directories }) =>
    console.log("[probe] eleventy.after", directories.output, JSON.stringify(results.map((r) => [r.url, r.outputPath]))),
  );
}

export const config = {
  dir: { input: "src", output: "_site" },
};
