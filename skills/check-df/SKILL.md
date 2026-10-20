---
name: check-df
description: Run VAST double-free analysis on C/C++ sources, VAST IR, executables, or libraries, review diagnostics, and write TP/FP reports. Use for /check-df or requests for VAST double-free checking.
---

# VAST double-free review

Execute the selected VAST detector with the shell tool, review its diagnostics one at a time, and write the reports below. This skill is self-contained and requires no OpenCode-specific runner or session hooks.

## Input and review mode

Use the file paths and compiler arguments supplied by the user, preserving quoted argument boundaries. Run from the user's project directory, so relative input paths and reports refer to that project.

Supported invocations:

```text
/check-df file.c [compiler args...]
/check-df a.std b.mlir
/check-df app
/check-df libfoo.a
/check-df libfoo.so
```

With no input, show these examples, say that no VAST check ran, and stop without writing reports. Reject unsupported inputs with the same behavior. Do not guess a target or scan the whole project.

Review automatically by default. If the user requests interactive review (including “交互式审查”), use the confirmation procedure below. Review-mode instructions are not compiler arguments. The legacy OpenCode `vast.interact` setting is not automatically read by this portable skill.

## Select and execute the pipeline

Check required tools in `PATH` for the selected pipeline. If one is missing, identify it and stop without classifying output or writing reports. For missing `extract-bc`, explain that it is provided by wllvm. Preserve arguments as separate values; quote paths and compiler options when constructing shell commands, and never evaluate user arguments as shell code.

Capture the command, exit status, stdout and stderr for each step. Keep the complete output for review; if the shell tool truncates it, capture it in a temporary file and read that file. Stop at a failed step instead of running the next pipeline command.

### C/C++ source

If the first argument has extension `.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hh`, `.hpp`, or `.hxx` (case-insensitive), treat it as the source and forward the remaining compiler arguments:

```sh
vast-front -vast-double-free <source> [compiler args...]
```

If no output option (`-o path` or `-opath`) was supplied, append `-o /dev/null` (`-o NUL` on Windows). Preserve any explicitly requested output path.

If `vast-front` exits nonzero, run `clang -c <source> [compiler args...]` with the same output-option handling to obtain compiler diagnostics. Report both commands and their outputs; if clang is missing, say so. If clang succeeds, explain that VAST failed despite clang succeeding. Do not classify this failed run or write TP/FP reports.

### VAST IR

If every argument has extension `.std`, `.mlir`, or `.hl` (case-insensitive), use IR mode. Also accept files without these extensions when every file's first 16 KiB contains an MLIR `module` declaration or an `hl.func`, `ll.func`, `core.func`, `abi.func`, `llvm.func`, or `func.func` operation. IR mode accepts one or more files and no compiler arguments.

Create a unique temporary directory and use an `input.thin` path inside it:

```sh
vast-link --link <ir> [ir...] -o <temporary-directory>/input.thin
vast-checker -a df -t <temporary-directory>/input.thin
```

Require both `vast-link` and `vast-checker`. On failure, report the failing command and its output without classifying or writing reports. Collect the checker output before removing the temporary directory. Clean up only this run's temporary directory, including on failure.

### Executable or library

For a single non-source, non-IR input, use `file -b <input>` to determine its type. Treat output containing `shared object`, `shared library`, or `current ar archive` as a library; treat `executable` as an executable. Unrecognized files may still qualify as IR by the content check above. Multiple binary inputs and binary inputs with compiler arguments are unsupported.

Require `file`, `vast-link`, `extract-bc`, and `vast-checker`. Create a unique temporary directory and set `MLIR_COMPILER_PATH` to the directory containing the resolved `vast-link` executable for the extraction process only:

```sh
# Executable:
MLIR_COMPILER_PATH=<vast-link-directory> extract-bc --mlir <input> -o <temporary-directory>/input.thin
# Static or shared library (use this instead of the executable command):
MLIR_COMPILER_PATH=<vast-link-directory> extract-bc --mlir -b <input> -o <temporary-directory>/input.thin
vast-checker -a df -t <temporary-directory>/input.thin
```

On extraction or checker failure, report the failing command and its output without classifying or writing reports. Collect the checker output before cleaning up this run's temporary directory, including on failure.

## Review diagnostics

Only review a successful VAST run. Use stderr followed by stdout, preserving source snippets and trace lines. A line beginning with `[VAST debug]` and containing ` detected` starts a finding; group its following lines until the next such marker. Keep any preamble as context. Do not count unrelated log lines as findings. If output has no markers, inspect it for actual diagnostics; do not invent findings from status messages. With no findings, proceed to empty reports.

Read the relevant source and trace each finding before classifying it as TP or FP. Trace allocation, ownership transfers and aliases, and both freeing operations. Check whether both frees refer to the same allocation on a feasible path. Assign one classification per diagnostic, state confidence and supporting evidence, and record any missing source or unresolved assumptions instead of inventing evidence. TP means a credible defect; FP means a diagnostic that is not credible, with a concrete reason.

Process findings in order, recording each result before moving on. Continue through all findings yourself; no session hook will supply another diagnostic. Do not apply source patches unless the user asks for that separately. Do not write the final reports until all diagnostics have been reviewed.

### Interactive review

Analyze only the current diagnostic until it is confirmed:

- TP: show confidence, the original diagnostic including its source snippet, then the suspected error path and reason. Use the question tool with header `TP Review`, `custom: true`, and exactly two options, `Accept` and `Reject`, to confirm the classification and path. Only after acceptance, show the proposed patch and use another question with header `Patch Review` and the same options to confirm it.
- FP: show confidence, the original diagnostic including its source snippet, and the reason it is not credible. Use the question tool with header `FP Review`, `custom: true`, and exactly two options, `Accept` and `Reject`, to confirm the reason.
- On rejection or a custom reason, revise this diagnostic and repeat the relevant confirmation. Summarize the accepted result before advancing. If the user cancels, stop; do not claim that the review finished or overwrite final reports.
- In OpenCode, use the question tool rather than plain-text confirmation prompts. If running in an agent without that tool, ask in chat and wait for an explicit answer before proceeding.

## Final reports

Create `.opencode/vast/` if necessary and overwrite only these reports for the current run:

- `.opencode/vast/check-df.TP.md`
- `.opencode/vast/check-df.FP.md`

Each TP entry includes the original diagnostic, suspected error path, confidence, reason, and proposed patch. Each FP entry includes the original diagnostic, confidence, and reason it is not credible. For interactive review, use the confirmed classifications and patches. Include an empty-result note for a category with no findings; a successful run with no diagnostics still writes both files.

After writing, summarize in this order:

1. TP count
2. FP count
3. Precision as `TP / (TP + FP)`; use `N/A (no diagnostics)` when the denominator is zero
4. TP report path
5. FP report path
