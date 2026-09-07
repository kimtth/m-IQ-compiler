---
name: scheduled-digest
description: Author and maintain recurring unattended jobs such as a morning briefing or an end-of-week summary, written so they are safe to run without a person watching. Use when the user asks for something to happen every day, every morning, weekly, on a schedule, or automatically.
license: MIT
allowed-tools: []
---

# Scheduled digest

A scheduled job runs in a fresh session with no one present to answer a
question or approve a write. Everything about how the job is written follows
from that.

This skill needs no tools. Authoring a job produces *text* — the objective, the
cadence, the caps — which the user then saves in Control Center → Automations.
The tools named in the objective are the ones the job's own run will use.

The source is a variable. A digest of mail and meetings comes from Work IQ; a
weekly report of broken links comes from the knowledge index; a project summary
comes from the files. The rules below hold whichever it is.

## Constraints on an unattended objective

1. **Read-only by default.** A job objective must not require a tool that needs
   approval. This app cannot send mail at all, so a digest is delivered in-app;
   say that plainly rather than writing an objective that mails it.

2. **No questions.** The objective cannot contain a branch that depends on
   asking the user. Resolve every ambiguity at authoring time.

3. **Bounded work.** State the time window and the maximum number of items
   explicitly, so a busy week cannot turn a five-minute job into an hour.

4. **Deterministic output shape.** The user compares today's digest to
   yesterday's, so the sections and their order must not vary.

5. **Safe to retry.** A retry after a partial failure must produce the same
   result. Never write an objective whose second run would repeat an external
   effect.

## Authoring procedure

1. Establish the cadence, the local time, and the time window each run covers.
   A daily 07:00 job normally covers the previous 24 hours; a Monday job
   normally covers the previous 7 days.
2. Establish the sections and fix their order.
3. Write the objective as a single instruction that names the source, the
   window, and the caps. Microsoft 365 data comes from Work IQ; there is no
   Microsoft Graph tool to name.
4. Restate the schedule in words and confirm before creating it.

## Objective template

This one reads Microsoft 365. Swap the source and the shape holds.

```
Every weekday at 07:00 local time, summarise the previous 24 hours.

Sections, in this order:
  1. Meetings today - ask Work IQ, all of them.
  2. Mail needing a reply - ask Work IQ, at most 10.
  3. Changes on <project> - ask Work IQ, at most 5.

If a section has nothing, print the heading and "nothing".
Do not modify anything. Report tool failures as "<section>: unavailable" and
continue with the remaining sections.
```

The final paragraph is not optional. Without it a single failing capability
turns the whole run into a failure and the user gets nothing.

## Rules

- Never create, change, or delete a job without restating it and getting
  agreement first.
- Work IQ signs in with its own account. A job whose every run reports that
  Work IQ is unavailable is waiting on a sign-in, not on a retry.
- A job that has failed the same way on every recent run is broken, not
  unlucky. Say so and propose a fix instead of leaving it retrying.
