# CSV tutorial assets

`phone-catalog.png` was captured from the Free PWA running in Chrome on a
Samsung S24-series phone through ADB on 2026-09-24. The browser used a local
development server containing the unreleased built-in CSV workbook. The crop
in `tutorial.css` hides Chrome's address bar and concentrates on the search
field and workbook card. It is not a screenshot of an Android release build.
`phone-output.png` is from the installed Free Android app after importing the
same workbook directly and running its cells. Both images contain only the
fictional CSV exercise and app UI.

`browse-overlay.svg` and `package-overlay.svg` annotate phone screenshots
already stored with the [interface tutorial](../../../interface/tutorial/assets/README.md).
All PNG pixels remain unchanged. The SVG callouts use a 1080 × 2340 viewBox
and can be edited in SVG-Edit or diagrams.net. Alt text and captions must
describe the action without relying on the yellow outline alone.

`seedling-heights.csv` contains only six fictional measurements. It matches
the file created by the workbook and is a download for the import exercise.
`csv-basics-seedlings.srwb` is a byte-for-byte copy of the built-in workbook
under `www/workbooks/`. The public-help deployment overlays `www/help/` on
the last stable app release, so this copy makes the fallback download work
before the next app tag. `tests/test_csv_workbook.mjs` checks equality.
