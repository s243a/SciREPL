# Phone screenshots and editable callouts

These five PNGs were captured from the Free Android app on a Samsung S24-class
phone, 1080 × 2340 pixels, with a disposable workbook containing only the
synthetic `print("Hello from SciREPL")` example. They document the UI as seen
on 2026-09-23. The screenshots are kept intact; CSS crops them to the useful
regions. The corresponding `*-overlay.svg` files contain only editable yellow
highlight rectangles, never screenshot pixels. Each SVG uses the full-screen
`viewBox="0 0 1080 2340"`, so its coordinates match its PNG.

To change a callout, open the SVG in [SVG-Edit](https://svgedit.netlify.app/)
or another SVG editor and move/resize the rectangle. For a layer-based GUI,
import the PNG into [diagrams.net](https://app.diagrams.net/), lock it on the
bottom layer, draw shapes on the top layer, then export the shapes as SVG while
keeping a `.drawio` source. Preserve the 1080 × 2340 viewBox and update the
crop settings in `tutorial.css` if the highlighted part moves. No annotation
tool or JavaScript is required to *view* the tutorial.

Before adding new screenshots, use a disposable workbook and inspect every
image for personal workbook names, URLs, API keys, notifications, or account
details. Include a text description and caption: the yellow outline alone must
not be required to understand a step.

`privacy-policy-top.jpg` is an existing Free-app QA capture of the top of the
scrollable Privacy Policy dialog. It contains no user content or credentials.
The acceptance button is below the visible area, so the tutorial explicitly
tells readers to scroll inside the dialog; this image is linked directly rather
than cropped or overlaid like the five workflow screenshots above.
