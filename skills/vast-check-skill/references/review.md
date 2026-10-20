# Sequential diagnostic review

Review each diagnostic once, in returned order, using the relevant source,
ownership rules, and execution paths. Produce exactly one TP or FP result per
diagnostic and retain its original text including source snippets. Record
uncertainty in confidence and reasoning; do not invent unavailable source or
claim a patch was tested when it was only proposed.

TP entries include the original diagnostic, suspected error path, confidence,
reason, and proposed patch. FP entries include the original diagnostic,
confidence, and the reason it is not credible. A proposed patch belongs in
the report; checking alone does not request applying it to project sources.

## Automatic review (`interact: false`, default)

Classify the current diagnostic and retain its entry, then continue to the
next. Write the final reports only after every diagnostic has been reviewed.
No classification or patch confirmation is needed in this mode.

## Interactive review (`interact: true` or explicit user request)

Finish confirmation for the current diagnostic before analyzing the next:

- For a TP, show confidence, original diagnostic with source snippet,
  suspected error path, and reason, in that order. Ask whether the user accepts
  the classification and path (`TP Review`: `Accept` / `Reject`, with custom
  feedback). Do not reveal the patch before that acceptance. Then show the
  proposed patch and ask for its acceptance (`Patch Review`).
- For an FP, show confidence, original diagnostic with source snippet, and
  reason, then ask for acceptance of that reason (`FP Review`).
- Use the host's question tool with selectable answers and custom feedback
  when available. If it has no question tool, ask in chat and wait for an
  explicit answer. Silence is not acceptance. Rejection or feedback means
  revise the same diagnostic and repeat the affected confirmation. If the
  classification changes, complete the new classification's review steps.
- Summarize the confirmed entry, then proceed to the next diagnostic yourself.
  If the user stops the review, retain draft progress without overwriting the
  final reports; do not mark unreviewed diagnostics as accepted.

## Final reports

Only after successful execution and completion of all required reviews:

1. Create `.opencode/vast/` in the analyzed project if needed. Keep this output
   location for compatibility even when another host runs the skill.
2. Overwrite `<check-name>.TP.md` and `<check-name>.FP.md` with this run's
   classifications, using a section per original diagnostic index. Include
   the input/tool command and all required entry fields. Use fenced blocks
   that preserve diagnostic text and proposed diffs verbatim.
3. If a category is empty, write a short empty-result note. If VAST returned
   no diagnostics, write both reports with a no-diagnostics note.
4. Print the summary in this order: TP count; FP count; precision as
   `TP / (TP + FP)`; TP report path; FP report path. When both counts are zero,
   report precision as `N/A (no diagnostics)` rather than divide by zero.

Reports describe the reviewed VAST output, not a guarantee that no other bugs
exist. Missing prerequisites, compile errors, link/extraction failures, and
checker failures must leave any earlier reports untouched.
