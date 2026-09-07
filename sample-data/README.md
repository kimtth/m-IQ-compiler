# Sample data

Material, not code. Nothing here is imported by the app, compiled, linted or
type-checked — it is the set of files a system test loads and a person opens by
hand, kept in its own directory so the two never get confused with each other.

Everything is fabricated. It uses plain project, customer, operations, quality
and communications examples so a reader can follow it without industry
knowledge. No file contains anything that would need careful handling if it
leaked.

## What is here

| Path | What it is | Used by |
|---|---|---|
| [`iq-cells/`](iq-cells) | Three exported IQ Cell bundles, in the exact format IQ Cell → Editor's **Export** writes and **Import** reads. | `tests/e2e/iq-cell.e2e.ts`, and step 2.13 of the manual plan. |
| [`connectome-iq/`](connectome-iq) | Three published IQs, in the exact shape the My IQ publisher writes and `@iq/myiq-mcp` serves. | Serve one from its own `IQ_HOME` to read somebody else's IQ over MCP. Section 3.7 of the manual plan. |
| [`demo-project/`](demo-project) | A generated, plain-language knowledge vault. | Bind it in **IQ Knowledge** to explore a connected set of notes. |
| [`project/`](project) | A legacy manufacturing project tree used by file-import examples. | Bind it in **Projects** when testing those specific file paths. |

The generated vault and the My IQ library use the same plain-language work
areas: projects, customer work, operations, quality review and communications.

## Where IQ Cells come from

Three surfaces compile them, and the demo library contains all three because a
library of only editor-authored cells would be asserting the other two do not
exist:

| Origin | Count | What it looks like |
|---|---|---|
| **IQ Editor** | 26 | A drawn procedure: a trigger, the sources its declared reach implies, its skills, an ask, and the artifacts it writes. |
| **IQ Knowledge** | 5 | A question in, a cited answer out. Reaches the vault index, writes no artifact. |
| **IQ Memories** | 4 | A convention applied to an input. Reaches nothing, writes nothing, cheap enough to sit inside anything else. |

Those differences are load-bearing rather than cosmetic: they are what the
coupling analysis reads, so a knowledge cell that wrote artifacts like an editor
one would just be an editor cell with a different label.

## Adding to it

Keep a new file useful to a person reading it, not just to an assertion. A CSV
with three rows of `foo,bar,baz` proves a parser runs and teaches a tester
nothing about whether the screen is right.

If a spec depends on an exact value in one of these files — a name, a row count
— say so in the spec, so the next person to edit the data knows the edit has a
consequence.


