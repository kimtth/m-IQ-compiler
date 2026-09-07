# Demo input / output

One file, [`demo-io.json`](demo-io.json), holding the exact input and the exact
output for every feature the product video shows.

## Why it exists

The demo used to be assembled from whatever the app happened to have on screen.
That produced two failures that a viewer can see:

- **State leaked between demos.** A prompt typed into an existing conversation
  showed the previous demo's history behind it, so the Fabric screen carried the
  browser demo's chat.
- **The environment decided what could be shown.** Features that need a live
  tenant, a Fabric capacity or a signed-in mailbox had nothing to show when
  those were unavailable.

This file fixes both. Every entry declares its `openingState` — a new
conversation, an empty pane — so a demo starts from zero rather than from
leftovers, and the input and output are written down instead of being whatever
the run produced that day.

## The shape

| Field | What it holds |
|---|---|
| `mode` · `surface` | Where in the app the feature lives. |
| `openingState` | What the screen looks like *before* the input. Always initialised. |
| `input` | Exactly what a person types or supplies. |
| `transport` | For features that leave the app: which server, which protocol, whose account, what risk class. |
| `tools` | The tool calls the turn makes, by their real names. |
| `output` | Exactly what comes back. |
| `narrationClaim` | The one sentence the narration is allowed to make about this feature. |

`narrationClaim` is the load-bearing one. If a script sentence is not supported
by an entry here, it does not go in the video.

## Who reads it

- `video/scripts/sync-demo-io.mjs` copies it to `video/public/demo-io.json`, and
  the Remotion composition renders the slides straight from it. The slides
  cannot drift from the data because they contain none of their own.
- A person recording the app by hand uses it as the shot list: type the `input`,
  expect the `output`.

## Editing it

Change the data, not the slide. If a value here is wrong the video is wrong, so
keep it truthful: this is fabricated material, but it must be the kind of thing
the app would actually produce.
