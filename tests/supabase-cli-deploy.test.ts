import { describe, expect, it, vi } from "vitest";
import {
  deployWithSupabaseCli,
  readUploadMethod,
  supabaseCliCommand,
  supabaseCliDeployArgs
} from "../scripts/supabase-cli-deploy.mjs";

const ref = "gnmndzsughifhboqvsgd";

describe("Edge API deployment through the Supabase CLI", () => {
  it("defaults to the CLI and accepts the Management API only when asked", () => {
    expect(readUploadMethod(["node", "deploy"])).toBe("cli");
    expect(readUploadMethod(["--upload=management-api"])).toBe("management-api");
    expect(() => readUploadMethod(["--upload=ftp"])).toThrow(/Unsupported --upload=ftp/u);
  });

  it("uses SUPABASE_CLI when set, otherwise supabase on PATH", () => {
    expect(supabaseCliCommand({ SUPABASE_CLI: " /opt/supabase " })).toBe("/opt/supabase");
    expect(supabaseCliCommand({ SUPABASE_CLI: "" })).toBe("supabase");
    expect(supabaseCliCommand({})).toBe("supabase");
  });

  it("deploys with the flags of the last successful production deployment", () => {
    expect(supabaseCliDeployArgs("api", ref)).toEqual([
      "functions",
      "deploy",
      "api",
      `--remote=${ref}`,
      "--use-docker",
      "--no-verify-jwt",
      "--yes"
    ]);
    expect(() => supabaseCliDeployArgs("other", ref)).toThrow(/Unsupported/u);
    expect(() => supabaseCliDeployArgs("api", "not a ref")).toThrow(/project ref/u);
  });

  it("passes the token only to the deploy child and checks the CLI first", () => {
    const spawn = vi.fn((command: string, args: string[]) =>
      args[0] === "--version"
        ? { status: 0, stdout: "3.2.0\n" }
        : { status: 0, stdout: "", command }
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const env = { PATH: "/usr/bin" };
    deployWithSupabaseCli({
      slug: "api-candidate",
      projectRef: ref,
      token: "sbp_test",
      env,
      spawn
    });
    log.mockRestore();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]).toEqual(["supabase", ["--version"], { encoding: "utf8" }]);
    const [command, args, options] = spawn.mock.calls[1] as unknown as [
      string,
      string[],
      { env: Record<string, string> }
    ];
    expect(command).toBe("supabase");
    expect(args).toEqual(supabaseCliDeployArgs("api-candidate", ref));
    expect(options.env.SUPABASE_ACCESS_TOKEN).toBe("sbp_test");
    // Never on the command line, where it would show in process listings.
    expect(args.join(" ")).not.toContain("sbp_test");
    expect(env).not.toHaveProperty("SUPABASE_ACCESS_TOKEN");
  });

  it("explains how to install the CLI when it cannot run, without deploying", () => {
    const spawn = vi.fn(() => ({ status: null, error: new Error("ENOENT") }));
    expect(() =>
      deployWithSupabaseCli({ slug: "api", projectRef: ref, token: "t", env: {}, spawn })
    ).toThrow(/could not be run as "supabase".*SUPABASE_CLI/su);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("fails when the deploy itself fails", () => {
    const spawn = vi.fn((_command: string, args: string[]) =>
      args[0] === "--version" ? { status: 0, stdout: "3.2.0" } : { status: 1 }
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(() =>
      deployWithSupabaseCli({ slug: "api", projectRef: ref, token: "t", env: {}, spawn })
    ).toThrow(/exited with status 1/u);
    log.mockRestore();
  });
});
