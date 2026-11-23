---
'fontphobia': minor
---

The plan says when a page would get heavier, and a plan made over an already split site is compared with the unsplit one.

- **Pages that would download more than before.** A page pays for a whole extended file as soon as it draws one of its characters, and the core choice counts every page the same, so one page can end up loading more than it did unsplit. The plan now lists those pages, with the file and the characters that cause it, and `build --json` carries them as `heavier`.
- **Before means before fontphobia.** Rerunning over a site an earlier build had split compared the new plan with that build's core files, and printed lines like "median 84.7 KB → 87.0 KB (-3% less)". The baseline is now each face's source file, the first column is headed `Before`, and a median that grows reads "3% more".
- **Page counts in every plan.** Each split face records `pages: { drawn, coreOnly }`. Until now only `coreThreshold: 'auto'` reported how many pages load the core file alone, so a fixed share had no record of what it costs.
