/**
 * The AI eval's judge: local Claude Code in print mode (CLAUDE.md "LLM access"), never a hosted
 * LLM API. Kept apart from run-ai-eval.ts so its isolation and verdict parsing are unit-tested
 * (tests/ai-eval-judge.test.ts) without running the eval.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The judge only reads the grading prompt and answers: no built-in tools, no MCP servers, no
 * user/project/local settings (hooks, CLAUDE.md), and no saved session.
 */
export const judgeIsolationArgs = [
  "--tools",
  "",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--no-session-persistence"
] as const;

export interface ClaudeCodeJudge {
  readonly bin: string;
  available(): Promise<boolean>;
  /** Raw judge output; a FAIL verdict JSON when the CLI fails twice. Never throws for CLI exits. */
  grade(prompt: string): Promise<string>;
  /** Removes the judge's scratch working directory. Safe to call more than once. */
  dispose(): void;
}

export function createClaudeCodeJudge(options: {
  bin: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}): ClaudeCodeJudge {
  const timeoutMs = options.timeoutMs ?? 180_000;
  let workdir: string | null = null;
  // An empty working directory keeps the judge from loading this repository's CLAUDE.md, git
  // state or files: it must grade only the prompt it is given. Created on first use.
  const judgeWorkdir = () => (workdir ??= mkdtempSync(join(tmpdir(), "grogoni-eval-judge-")));

  const run = (args: readonly string[], input: string | null) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      // Never hand the judge a hosted API key: it must use the local Claude Code login.
      const { ANTHROPIC_API_KEY: _apiKey, ...env } = options.env ?? process.env;
      void _apiKey;
      // Its own process group, so a timeout kills the CLI and anything it started; a surviving
      // child would otherwise hold the pipes open and the wait would never end.
      const child = spawn(options.bin, [...args], {
        cwd: judgeWorkdir(),
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let settled = false;
      const settle = (result: { code: number; stdout: string; stderr: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        settle({ code: 124, stdout, stderr: `${stderr}\njudge timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => settle({ code: code ?? 1, stdout, stderr }));
      // A CLI that exits before reading the prompt closes the pipe mid-write (EPIPE). The exit
      // code and stderr already carry the real failure; unhandled, this error crashed the run.
      child.stdin.on("error", () => undefined);
      child.stdin.end(input ?? "");
    });

  return {
    bin: options.bin,
    async available() {
      try {
        return (await run(["--version"], null)).code === 0;
      } catch {
        return false;
      }
    },
    async grade(prompt) {
      // One retry for a transient CLI failure; a second failure becomes a FAIL verdict for that
      // scenario rather than a crash that throws away every other scenario's result.
      let lastFailure = "";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const result = await run(
            ["-p", "--output-format", "text", ...judgeIsolationArgs],
            prompt
          );
          if (result.code === 0) return result.stdout;
          lastFailure = `exit ${result.code}: ${(result.stderr || result.stdout).trim().slice(-300)}`;
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : "spawn failed";
        }
        options.log?.(`[eval] judge attempt ${attempt} failed (${lastFailure})`);
      }
      return JSON.stringify({ verdict: "FAIL", reason: `Judge unavailable (${lastFailure}).` });
    },
    dispose() {
      if (workdir !== null) rmSync(workdir, { recursive: true, force: true });
      workdir = null;
    }
  };
}

export function parseJudgeVerdict(text: string): { verdict: "PASS" | "FAIL"; reason: string } {
  try {
    const match = text.match(/\{[\s\S]*\}/u);
    const parsed = JSON.parse(match?.[0] ?? text) as { verdict?: unknown; reason?: unknown };
    const verdict = parsed.verdict === "PASS" ? "PASS" : "FAIL";
    const reason = typeof parsed.reason === "string" ? parsed.reason : "No reason given by judge.";
    return { verdict, reason };
  } catch {
    return {
      verdict: "FAIL",
      reason: `Judge output was not parseable JSON: ${text.slice(0, 200)}`
    };
  }
}
