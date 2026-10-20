import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import test from "node:test"

const runner = fileURLToPath(new URL("./run.mjs", import.meta.url))

// VAST is an external installation. These executable fixtures check the actual
// runner's process contracts, not the accuracy of VAST's analyses.
async function fixture(t, responses = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vast-skill-test-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const bin = path.join(dir, "tools")
  await fs.mkdir(bin)
  await Promise.all(Object.entries(responses).map(async ([name, response]) => {
    await fs.writeFile(path.join(bin, name), `#!${process.execPath}
const fs = require("node:fs")
const args = process.argv.slice(2)
const response = ${JSON.stringify(response)}
fs.appendFileSync(${JSON.stringify(path.join(dir, "calls.jsonl"))}, JSON.stringify({
  tool: ${JSON.stringify(name)}, args, mlir: process.env.MLIR_COMPILER_PATH
}) + "\\n")
if (${JSON.stringify(name)} === "vast-checker" && !fs.existsSync(args[args.indexOf("-t") + 1])) process.exit(99)
if (["vast-link", "extract-bc"].includes(${JSON.stringify(name)}) && !response.code) fs.writeFileSync(args[args.indexOf("-o") + 1], "thin fixture")
process.stderr.write(response.stderr || "")
process.stdout.write(response.stdout || "")
process.exitCode = response.code || 0
`, { mode: 0o755 })
  }))
  return {
    dir,
    bin,
    run(args, env = {}) {
      const result = spawnSync(process.execPath, [runner, ...args], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ...env },
      })
      assert.equal(result.error, undefined)
      assert.equal(result.stderr, "")
      const json = JSON.parse(result.stdout)
      assert.equal(result.status, json.ok === false ? 1 : 0)
      return json
    },
    async calls() {
      const text = await fs.readFile(path.join(dir, "calls.jsonl"), "utf8").catch(() => "")
      return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : []
    },
  }
}

test("help and invalid invocation execute no tools", async (t) => {
  const f = await fixture(t)
  assert.match(f.run(["--help"]).usage, /check-uaf/)
  for (const args of [[], ["check-uaf"], ["toString", "test.c"]]) assert.equal(f.run(args).ok, false)
  assert.deepEqual(await f.calls(), [])
})

test("source detectors preserve argv, diagnostics, and explicit output", async (t) => {
  const f = await fixture(t, { "vast-front": { stderr: "context\n[VAST debug] first detected\nsource snippet\n[VAST debug] second detected\nsecond snippet" } })
  for (const [check, flag] of [
    ["check-uaf", "-vast-use-after-free"],
    ["check-df", "-vast-double-free"],
    ["check-leak", "-vast-memory-leak-detection"],
  ]) {
    const result = f.run([check, "source with spaces.cpp", "-DVALUE=$(touch should-not-exist)", "-o", "my output.o"])
    assert.equal(result.ok, true)
    assert.equal(result.check, check)
    assert.equal(result.mode, "source")
    assert.equal(result.tp, `.opencode/vast/${check}.TP.md`)
    assert.deepEqual(result.command.slice(1), [flag, "source with spaces.cpp", "-DVALUE=$(touch should-not-exist)", "-o", "my output.o"])
    assert.deepEqual(result.diagnostics, ["context\n[VAST debug] first detected\nsource snippet", "[VAST debug] second detected\nsecond snippet"])
  }
  assert.equal(await fs.stat(path.join(f.dir, "should-not-exist")).catch(() => undefined), undefined)
  assert.equal(await fs.stat(path.join(f.dir, ".opencode")).catch(() => undefined), undefined)
})

test("default null output and empty diagnostics", async (t) => {
  const f = await fixture(t, { "vast-front": {} })
  const result = f.run(["check-uaf", "test.c"])
  assert.deepEqual(result.command.slice(-2), ["-o", process.platform === "win32" ? "NUL" : "/dev/null"])
  assert.deepEqual(result.diagnostics, [])
})

test("compile failure runs clang and preserves existing reports", async (t) => {
  const f = await fixture(t, { "vast-front": { code: 1, stderr: "VAST failed" }, clang: { stderr: "clang compile error", code: 1 } })
  await fs.mkdir(path.join(f.dir, ".opencode/vast"), { recursive: true })
  await fs.writeFile(path.join(f.dir, ".opencode/vast/check-df.TP.md"), "previous report")
  const result = f.run(["check-df", "broken.c", "-Iinclude"])
  assert.equal(result.ok, false)
  assert.deepEqual(result.diagnostics, [])
  assert.equal(result.output, "VAST failed")
  assert.equal(result.clang.output, "clang compile error")
  assert.deepEqual(result.clang.command.slice(1), ["-c", "broken.c", "-Iinclude", "-o", "/dev/null"])
  assert.deepEqual((await f.calls()).map((call) => call.tool), ["vast-front", "clang"])
  assert.equal(await fs.readFile(path.join(f.dir, ".opencode/vast/check-df.TP.md"), "utf8"), "previous report")
})

test("missing prerequisites return structured failures", async (t) => {
  const f = await fixture(t)
  assert.match(f.run(["check-uaf", "test.c"], { PATH: f.bin }).error, /vast-front/)
  assert.match(f.run(["check-uaf", "test.std"], { PATH: f.bin }).error, /vast-link/)
  assert.match(f.run(["check-uaf", "app"], { PATH: f.bin }).error, /file/)
  const binary = await fixture(t, { file: { stdout: "ELF executable" }, "vast-link": {} })
  assert.match(binary.run(["check-uaf", "app"], { PATH: binary.bin }).error, /wllvm/)
})

test("IR modes link all inputs, select analysis, and clean temporary files", async (t) => {
  const f = await fixture(t, { "vast-link": {}, "vast-checker": { stdout: "one diagnostic" } })
  for (const [check, analysis] of [["check-uaf", "uaf"], ["check-df", "df"], ["check-leak", "mld"]]) {
    const result = f.run([check, "a.std", "b.MLIR", "c.hl"])
    assert.equal(result.ok, true)
    assert.equal(result.mode, "ir")
    assert.deepEqual(result.prepare.command.slice(1, 5), ["--link", "a.std", "b.MLIR", "c.hl"])
    assert.deepEqual(result.command.slice(1, 4), ["-a", analysis, "-t"])
    assert.deepEqual(result.diagnostics, ["one diagnostic"])
    assert.equal(await fs.stat(path.dirname(result.command.at(-1))).catch(() => undefined), undefined)
  }
})

test("IR content routing uses real input files and file detection", async (t) => {
  const f = await fixture(t, { "vast-link": {}, "vast-checker": {} })
  await fs.writeFile(path.join(f.dir, "module.txt"), "// comment\nmodule {\n}\n")
  await fs.writeFile(path.join(f.dir, "function.txt"), "hl.func @main")
  assert.equal(f.run(["check-uaf", "module.txt"]).mode, "ir")
  assert.equal(f.run(["check-uaf", "module.txt", "function.txt"]).ok, true)
  assert.equal(f.run(["check-uaf", "module.txt", "-Iinclude"]).ok, false)
})

test("link and checker failures stop review and clean temporary files", async (t) => {
  for (const tool of ["vast-link", "vast-checker"]) {
    const f = await fixture(t, { "vast-link": {}, "vast-checker": {}, [tool]: { code: 2, stderr: "tool failed" } })
    const result = f.run(["check-leak", "a.std"])
    assert.equal(result.ok, false)
    assert.deepEqual(result.diagnostics, [])
    assert.match(result.error, new RegExp(tool))
    assert.equal(await fs.stat(path.dirname(result.command.at(-1))).catch(() => undefined), undefined)
    if (tool === "vast-link") assert.deepEqual((await f.calls()).map((call) => call.tool), ["vast-link"])
  }
})

test("binary extraction distinguishes executables and libraries and sets MLIR path", async (t) => {
  for (const kind of ["ELF executable", "ELF shared object", "Mach-O shared library", "current ar archive"]) {
    const f = await fixture(t, { file: { stdout: kind }, "vast-link": {}, "extract-bc": {}, "vast-checker": {} })
    const result = f.run(["check-df", "input file"])
    assert.equal(result.ok, true)
    assert.equal(result.mode, kind.includes("executable") ? "executable" : "library")
    assert.deepEqual(result.prepare.command.slice(1, -2), ["--mlir", ...(result.mode === "library" ? ["-b"] : []), "input file"])
    assert.equal((await f.calls()).find((call) => call.tool === "extract-bc").mlir, f.bin)
    assert.equal(await fs.stat(path.dirname(result.command.at(-1))).catch(() => undefined), undefined)
  }
})

test("extraction failure does not start checker", async (t) => {
  const f = await fixture(t, { file: { stdout: "ELF executable" }, "vast-link": {}, "extract-bc": { code: 1 }, "vast-checker": {} })
  const result = f.run(["check-uaf", "app"])
  assert.equal(result.ok, false)
  assert.deepEqual(result.diagnostics, [])
  assert.deepEqual((await f.calls()).map((call) => call.tool), ["file", "extract-bc"])
  assert.equal(await fs.stat(path.dirname(result.command.at(-1))).catch(() => undefined), undefined)
})
