# Execution contract

`scripts/run.mjs` adapts the original `packages/opencode/src/command/vast.ts`
execution logic without importing any repository modules. It runs with Node.js
18+ or Bun. VAST tools must already be installed in `PATH`; binary extraction
also requires wllvm's `extract-bc` and embedded MLIR bitcode in the input.

| Check | Source flag | Checker analysis |
| --- | --- | --- |
| `check-leak` | `-vast-memory-leak-detection` | `mld` |
| `check-df` | `-vast-double-free` | `df` |
| `check-uaf` | `-vast-use-after-free` | `uaf` |

Routing preserves the original order:

1. A first argument ending in `.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hh`, `.hpp`,
   or `.hxx` selects source mode (case insensitive).
2. If all arguments end in `.std`, `.mlir`, or `.hl`, select IR mode.
3. For one remaining argument, use `file -b` to recognize executables, shared
   objects/libraries, or current ar archives. Missing `file` stops this route.
4. Otherwise inspect the first 16 KiB of every input for an MLIR `module` or
   `hl/ll/core/abi/llvm/func.func`. All inputs must match to select IR mode.
5. Reject other combinations; IR/binary inputs do not take compiler flags.

Source execution:

```sh
vast-front <source-flag> <source> [compiler args...]
```

Append `-o /dev/null` (`NUL` on Windows) unless the user supplied `-o` or an
argument beginning with `-o`, preserving the original command behavior. On
nonzero exit, run `clang -c` with the same input/output arguments, return both
outputs, and stop analysis even if clang succeeds. Missing clang is included
in the failure result. Do not install tools automatically to recover.

IR execution:

```sh
vast-link --link <ir> [ir...] -o <temporary-directory>/input.thin
vast-checker -a <analysis> -t <temporary-directory>/input.thin
```

Binary execution:

```sh
MLIR_COMPILER_PATH=<vast-link-directory> extract-bc --mlir <executable> -o <temporary-directory>/input.thin
MLIR_COMPILER_PATH=<vast-link-directory> extract-bc --mlir -b <library> -o <temporary-directory>/input.thin
vast-checker -a <analysis> -t <temporary-directory>/input.thin
```

The runner gives `MLIR_COMPILER_PATH` only to the extraction process and keeps
the rest of the environment. It removes its temporary directory on success
and failure. A failed preparation step never runs the checker. A failed
checker never produces reviewable diagnostics.

## JSON result

The script prints a single JSON object. `ok: true` permits review; `ok: false`
and process exit code 1 mean stop. Invalid invocation and missing tools also
return structured errors. `--help` prints usage without running analysis.

Successful results contain `check` (the requested check name), `command` (argv of the final tool), `detector`,
`mode`, `cwd`, `tp`, `fp`, `code`, `signal`, `output`, and `diagnostics`.
IR/binary results also contain `prepare` with the link/extract command and
output. Failures include `error` and available execution details; source
failures include `clang`. The command arrays preserve argument boundaries;
do not execute them by blindly joining with spaces.

As in the original runner, `output` is stderr followed by stdout, trimmed.
Diagnostic boundaries are lines beginning with `[VAST debug]` containing
` detected`; subsequent lines stay with that diagnostic. Leading context is
retained. Nonempty output without those markers remains a single diagnostic;
empty output produces an empty array. The script performs no TP/FP inference.
