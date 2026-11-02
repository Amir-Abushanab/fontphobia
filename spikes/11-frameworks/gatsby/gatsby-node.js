const path = require("path")

// "Dynamic route": one template, two pages.
exports.createPages = ({ actions }) => {
  for (const id of ["1", "2"]) {
    actions.createPage({
      path: `/posts/${id}/`,
      component: path.resolve("src/templates/post.js"),
      context: { id },
    })
  }
}

// Probe the webpack `done` hook (Gatsby still uses webpack 5).
exports.onCreateWebpackConfig = ({ stage, actions }) => {
  actions.setWebpackConfig({
    plugins: [
      {
        apply(compiler) {
          compiler.hooks.done.tap("probe", () => console.log("[probe] webpack done", stage, compiler.name ?? "-"))
        },
      },
    ],
  })
}

// Gatsby lifecycle hook that runs after HTML is generated.
exports.onPostBuild = ({ store }) => {
  const { pages, program } = store.getState()
  console.log("[probe] onPostBuild", program.directory, JSON.stringify([...pages.keys()]))
}
