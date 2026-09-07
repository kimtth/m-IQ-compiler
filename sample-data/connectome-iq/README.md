# Connectome IQ — shared IQs

Three published IQs in the exact shape `packages/shared/src/myiq.ts` defines,
so a person can serve one over MCP and read somebody else's work from VS Code
or Claude Desktop.

**These are files, not the app's fixtures.** Connectome IQ draws its five shared
IQs from `apps/renderer/src/samples/sharedIq.ts` and never reads this directory.
What is here is the other half of the demo: proof that a shared IQ is an
ordinary file with a schema, and something you can actually run a client
against.

## Serving one

`@iq/myiq-mcp` reads one snapshot, at `published.json` under the app's `myiq`
directory. So pick an IQ, give it its own home, and point the server at it:

```powershell
cd d:\Code\IQ-compiler\iq-compiler
$home_ = "$env:TEMP\iq-shared\dana"
New-Item -ItemType Directory -Force -Path "$home_\myiq" | Out-Null
Copy-Item sample-data\connectome-iq\project-delivery-iq.published.json `
  "$home_\myiq\published.json"
$env:IQ_HOME = $home_
node packages\myiq-mcp\dist\index.js
```

Then in another app's MCP configuration:

```json
{
  "mcpServers": {
    "project-delivery-iq": {
      "command": "node",
      "args": ["d:/Code/IQ-compiler/iq-compiler/packages/myiq-mcp/dist/index.js"],
      "env": { "IQ_HOME": "C:/Users/you/AppData/Local/Temp/iq-shared/dana" }
    }
  }
}
```

Five read-only tools answer: `myiq_list_cells`, `myiq_get_cell`,
`myiq_connectome_summary`, `myiq_list_memories`, `myiq_search_notes`. Nothing
writes.

Run each IQ from its own `IQ_HOME`. One server serves one snapshot, which is
what makes "whose IQ am I reading" answerable.

## What is here

| File | IQ | Owner | Cells |
|---|---|---|---|
| `project-delivery-iq.published.json` | Project delivery IQ | Dana Okafor, Delivery | 3 |
| `customer-support-iq.published.json` | Customer support IQ | Marco Bianchi, Customer support | 3 |
| `operations-iq.published.json` | Operations IQ | Yuki Tanaka, Operations | 3 |

Every one carries `"shared": true` and `"sampleDataOnly": true`. The second is
not decoration: the server refuses to load a snapshot without it, so a file
copied from here can never be mistaken for somebody's real work.

## Editing

`schemaVersion` is 1 and stays 1 while fields are only added. Add a field with a
default and old files still parse; change what an existing field means and the
version has to move, because a reader would otherwise misread it silently.

The `hash` on each connectome is a graph hash from a real analysis run. It is
opaque — nothing recomputes it from these files — but keep the three distinct,
or two IQs will look like the same reading of the same library.
