# Road Bridge Static Load Effects, 2D

Web version of `Main_gui.m` and `BeamStat2D.m` in BeamStat_road: influence lines of a multi-span
2D Bernoulli-Euler beam, and the load effects of the type vehicles of TRVINFRA-00331 Bilaga 1 and
Load Models 1 and 2 of EN 1991-2:2024. Plain JavaScript, no libraries and no build step.

| File | Content |
|---|---|
| `index.html` | layout, as the MATLAB figure, 560 x 894 px |
| `app.js` | GUI: input, load model tick boxes, plots, Run/Cancel, Reset, Export, Print |
| `beamstat2d.js` | solver, port of BeamStat2D.m |
| `solver.worker.js` | Web Worker, one load model per job, or the influence lines |
| `plot.js` | SVG plots and a LaTeX subset for the labels |
| `xlsx.js` | Excel writer |

The analysis of three or more new load models runs in Web Workers (up to 8, one less than the
processors of the computer). Fewer models, and a page opened from `file://`, run in the page.
From 400 elements the influence lines run in a worker of their own, with the progress bar and
Cancel, so that the page stays live.

Print opens the browser's print preview: choose Save as PDF. The date and the page numbers
"N (M)" need Chrome or Edge 131 or newer.

When a file changes, raise `?v=` in `index.html`, `app.js` (VER) and
`solver.worker.js`, and "Last modified" in `index.html`.

## Disclaimer

This software is provided for research, education and preliminary assessment. It is provided "as is", without warranty of any kind, express or implied, including but not limited to accuracy, completeness, or fitness for a particular purpose.

The results have not been independently certified and do not replace the verification required by the applicable codes, regulations and infrastructure manager requirements. The user is responsible for checking that the method, the load models, the input and the assumptions suit the case at hand, and for verifying the results independently before using them in design, assessment or any other decision. Load models and dynamic factors are implemented as interpreted by the author and may differ from, or become out of date compared with, the current versions of the standards.

The author accepts no liability for any loss, damage or other consequence arising from the use of this software or its results.

Andreas Andersson, 2026-11-08 (assisted by Claude)
