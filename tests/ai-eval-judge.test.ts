import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createClaudeCodeJudge,
  judgeIsolationArgs,
  parseJudgeVerdict
} from "../services/api/scripts/ai-eval-judge";

// The eval judge shells out to local Claude Code. These tests stand a fake `claude` executable in
// its place, so they check exactly what the judge passes to the CLI and how it reacts to failures.

const scratch: string[] = [];

function fakeClaude(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  scratch.push(dir);
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Claude Code eval judge", () => {
  it("runs isolated: no tools, MCP, settings or session, an empty cwd, and no API key", async () => {
    const record = join(mkdtempSync(join(tmpdir(), "judge-record-")), "call.txt");
    scratch.push(join(record, ".."));
    const bin = fakeClaude(
      `printf '%s\\n' "$@" > ${record}; pwd >> ${record}; echo "key=\${ANTHROPIC_API_KEY:-unset}" >> ${record}; cat >> ${record}; echo '{"verdict":"PASS","reason":"ok"}'`
    );
    const judge = createClaudeCodeJudge({
      bin,
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-must-not-reach-the-judge" }
    });

    const output = await judge.grade("Grade this reply.");
    expect(parseJudgeVerdict(output)).toEqual({ verdict: "PASS", reason: "ok" });

    const lines = readFileSync(record, "utf8").split("\n");
    expect(lines.slice(0, 3 + judgeIsolationArgs.length)).toEqual([
      "-p",
      "--output-format",
      "text",
      ...judgeIsolationArgs
    ]);
    const cwd = lines[3 + judgeIsolationArgs.length] as string;
    expect(cwd).toContain("grogoni-eval-judge-");
    expect(cwd.startsWith(process.cwd())).toBe(false);
    expect(lines).toContain("key=unset");
    expect(lines).toContain("Grade this reply.");

    judge.dispose();
    expect(existsSync(cwd)).toBe(false);
  });

  it("retries once, then records a FAIL verdict instead of crashing the eval", async () => {
    const counter = join(mkdtempSync(join(tmpdir(), "judge-count-")), "n");
    scratch.push(join(counter, ".."));
    const flaky = fakeClaude(
      `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; if [ $n -eq 1 ]; then echo "rate limited" >&2; exit 1; fi; echo '{"verdict":"PASS","reason":"second try"}'`
    );
    const logs: string[] = [];
    const recovering = createClaudeCodeJudge({ bin: flaky, log: (line) => logs.push(line) });
    expect(parseJudgeVerdict(await recovering.grade("x"))).toEqual({
      verdict: "PASS",
      reason: "second try"
    });
    expect(logs).toEqual([expect.stringContaining("rate limited")]);
    recovering.dispose();

    const broken = createClaudeCodeJudge({ bin: fakeClaude('echo "auth expired" >&2; exit 3') });
    expect(parseJudgeVerdict(await broken.grade("x"))).toEqual({
      verdict: "FAIL",
      reason: expect.stringContaining("exit 3: auth expired")
    });
    broken.dispose();
  });

  it("kills a hung judge after its timeout", async () => {
    const judge = createClaudeCodeJudge({ bin: fakeClaude("sleep 30"), timeoutMs: 200 });
    const startedAt = Date.now();
    expect(parseJudgeVerdict(await judge.grade("x")).verdict).toBe("FAIL");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    judge.dispose();
  });

  it("reports unavailable when the CLI is missing", async () => {
    const judge = createClaudeCodeJudge({ bin: join(tmpdir(), "no-such-claude-binary") });
    await expect(judge.available()).resolves.toBe(false);
    judge.dispose();
  });
});

describe("judge verdict parsing", () => {
  it("accepts JSON wrapped in prose and defaults everything else to FAIL", () => {
    expect(parseJudgeVerdict('Sure. {"verdict":"PASS","reason":"Asks for the price."}')).toEqual({
      verdict: "PASS",
      reason: "Asks for the price."
    });
    expect(parseJudgeVerdict('{"verdict":"pass","reason":"lowercase"}').verdict).toBe("FAIL");
    expect(parseJudgeVerdict('{"verdict":"PASS"}')).toEqual({
      verdict: "PASS",
      reason: "No reason given by judge."
    });
    expect(parseJudgeVerdict("I cannot grade this.")).toEqual({
      verdict: "FAIL",
      reason: expect.stringContaining("not parseable JSON")
    });
  });
});
