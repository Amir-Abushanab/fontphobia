---
"fontphobia": patch
---

pr: 9

The throwaway build copy includes every workspace package's `node_modules`, git submodules, and the build outputs of the workspace packages the project depends on. A project that its repository ignores is copied directly.
