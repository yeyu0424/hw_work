#!/usr/bin/env node
// Execution logic adapted from packages/opencode/src/command/vast.ts.
// Keep this file independent of OpenCode so the entire skill can be copied.
import fs from "node:fs/promises"
import { constants } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const detectors = {
  "check-leak": { title: "memory leak", flag: "-vast-memory-leak-detection", analysis: "mld" },
  "check-df": { title: "double free", flag: "-vast-double-free", analysis: "df" },
  "check-uaf": { title: "use after free", flag: "-vast-use-after-free", analysis: "uaf" },
}

async function main(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    return { usage: "node run.mjs <check-leak|check-df|check-uaf> <source> [compiler args...] | <ir...> | <binary>" }
  }
  const command = args[0]
  const inputs = args.slice(1)
  if (!Object.hasOwn(detectors, command) || inputs.length === 0) {
    return { ok: false, error: "Specify check-leak, check-df, or check-uaf and a source file, IR files, or one binary." }
  }

  const mode = await inputMode(inputs)
  if (mode === "missing-file-command") return missing("file")
  if (!mode) return { ok: false, error: "Unsupported input. Compiler arguments are only accepted after a C/C++ source or header file." }

  const detector = detectors[command]
  const result = await execute(mode, inputs, detector)
  return {
    check: command,
    detector: detector.title,
    mode,
    cwd: process.cwd(),
    tp: `.opencode/vast/${command}.TP.md`,
    fp: `.opencode/vast/${command}.FP.md`,
    ...result,
    // Failed execution must never be interpreted as analysis findings.
    diagnostics: result.ok ? diagnostics(result.output) : [],
  }
}

async function execute(mode, args, detector) {
  if (mode === "source") {
    const front = await which("vast-front")
    if (!front) return missing("vast-front")
    const inputs = args.some((arg) => arg.startsWith("-o"))
      ? args
      : [...args, "-o", process.platform === "win32" ? "NUL" : "/dev/null"]
    const result = await run([front, detector.flag, ...inputs])
    if (result.code === 0) return { ok: true, ...result }
    const clang = await which("clang")
    return {
      ok: false,
      error: "VAST exited with a non-zero status. Treat this as a source compile or syntax problem; do not classify findings or write TP/FP reports.",
      ...result,
      clang: clang ? await run([clang, "-c", ...inputs]) : missing("clang"),
    }
  }

  const link = await which("vast-link")
  if (!link) return missing("vast-link")
  const extract = mode === "ir" ? undefined : await which("extract-bc")
  if (mode !== "ir" && !extract) return missing("extract-bc")
  const checker = await which("vast-checker")
  if (!checker) return missing("vast-checker")

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-vast-"))
  const thin = path.join(dir, "input.thin")
  // Cleanup is necessary on both tool failure and successful analysis.
  try {
    const prepare = await run(
      mode === "ir"
        ? [link, "--link", ...args, "-o", thin]
        : [extract, "--mlir", ...(mode === "library" ? ["-b"] : []), args[0], "-o", thin],
      mode === "ir" ? undefined : { MLIR_COMPILER_PATH: path.dirname(link) },
    )
    if (prepare.code !== 0) {
      return { ok: false, error: `${mode === "ir" ? "vast-link" : "extract-bc"} failed.`, ...prepare }
    }
    const result = await run([checker, "-a", detector.analysis, "-t", thin])
    if (result.code !== 0) return { ok: false, error: "vast-checker failed.", prepare, ...result }
    return { ok: true, prepare, ...result }
  } finally {
    await fs.rm(dir, { force: true, recursive: true })
  }
}

async function inputMode(args) {
  if ([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"].includes(path.extname(args[0]).toLowerCase())) {
    return "source"
  }
  if (args.every((arg) => [".std", ".mlir", ".hl"].includes(path.extname(arg).toLowerCase()))) return "ir"
  if (args.length === 1) {
    const file = await which("file")
    if (!file) return "missing-file-command"
    const result = await run([file, "-b", args[0]])
    const text = result.output.toLowerCase()
    if (result.code === 0) {
      if (text.includes("shared object") || text.includes("shared library") || text.includes("current ar archive")) return "library"
      if (text.includes("executable")) return "executable"
    }
  }
  const matches = await Promise.all(args.map(async (arg) => {
    const file = await fs.open(arg, "r").catch(() => undefined)
    if (!file) return false
    try {
      const buffer = Buffer.alloc(16_384)
      const result = await file.read(buffer, 0, buffer.length, 0)
      const sample = buffer.toString("utf8", 0, result.bytesRead)
      return /^\s*(?:\/\/[^\n]*\n|#[^\n]*\n|\s)*module\s+[@{]/m.test(sample) || /\b(?:hl|ll|core|abi|llvm|func)\.func\b/.test(sample)
    } catch {
      return false
    } finally {
      await file.close()
    }
  }))
  return matches.every(Boolean) ? "ir" : undefined
}

async function which(name) {
  const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")] : [""]
  const candidates = (process.env.PATH || "").split(path.delimiter).flatMap((dir) =>
    extensions.map((extension) => path.resolve(dir, name + extension)),
  )
  const matches = await Promise.all(candidates.map(async (candidate) => {
    const stat = await fs.stat(candidate).catch(() => undefined)
    if (!stat?.isFile()) return undefined
    return fs.access(candidate, constants.X_OK).then(() => candidate, () => undefined)
  }))
  return matches.find(Boolean)
}

function run(command, env) {
  return new Promise((resolve) => {
    const stdout = []
    const stderr = []
    // Pass argv directly; compiler flags and filenames must not be shell-expanded.
    const child = spawn(command[0], command.slice(1), { env: { ...process.env, ...env }, shell: false })
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.on("error", (error) => stderr.push(Buffer.from(error.message)))
    child.on("close", (code, signal) => resolve({
      command,
      code: code ?? 1,
      signal,
      output: [Buffer.concat(stderr).toString(), Buffer.concat(stdout).toString()].filter(Boolean).join("\n").trim(),
    }))
  })
}

function missing(tool) {
  return {
    ok: false,
    error: tool === "extract-bc"
      ? "extract-bc was not found in PATH. Install wllvm to extract MLIR bitcode."
      : `${tool} was not found in PATH.`,
  }
}

function diagnostics(output) {
  return output.split(/\r?\n/).reduce((segments, line) => {
    if (line.startsWith("[VAST debug]") && line.includes(" detected") && segments.at(-1)?.includes(" detected")) {
      return [...segments, line]
    }
    if (segments.length === 0) return [line]
    return [...segments.slice(0, -1), segments.at(-1) + "\n" + line]
  }, []).map((segment) => segment.trim()).filter(Boolean)
}

const result = await main(process.argv.slice(2)).catch((error) => ({ ok: false, error: error.message }))
process.stdout.write(JSON.stringify(result, null, 2) + "\n")
process.exitCode = result.ok === false ? 1 : 0
