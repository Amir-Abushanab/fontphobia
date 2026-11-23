---
'fontphobia': patch
---

`verify`, after a run on a site with live widgets and a 44,000 px essay:

- **An unexplained font load names its character.** "Loaded, but the page uses none of its characters" was wrong when a script had added the text after the audit read the page. The message now looks at the text of the page as verify loaded it and names the characters the audit never recorded there, with the words around them, and says to declare them with `extraText`. When the text has none either, it says that: canvas text, or a script asking for the font.
- **The walk down the page ends in the same state every time.** Each scroll stop was held for one frame, so which IntersectionObserver callback ran last depended on how fast the frames came, and a scroll-spy that keeps the last heading it saw left a label in a different place on each load. That was reported as a regression in text. Each stop is now held for two frames and a task, and so is the return to the top.
- **A box that moved sideways at the same width says so,** instead of "width changed (shaping or advance widths)".
- **Long pages are captured in strips.** A full-page screenshot is one GPU surface; past its largest size Chrome drew the top of the page again, so the lower part of a long page at 2× was compared with copies of the header, and the diff image showed the header 18 times.
