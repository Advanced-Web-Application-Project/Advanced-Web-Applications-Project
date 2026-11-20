import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("CLI executes from a real path containing spaces and exits nonzero on invalid input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rio tmdb cli "));
  try {
    const backend = fileURLToPath(new URL("../", import.meta.url));
    await cp(join(backend, "src"), join(directory, "src"), { recursive: true });
    await cp(join(backend, "scripts"), join(directory, "scripts"), {
      recursive: true,
    });
    await cp(join(backend, "package.json"), join(directory, "package.json"));
    await symlink(
      join(backend, "node_modules"),
      join(directory, "node_modules"),
    );
    const command = join(directory, "src/features/films/importTmdbCli.js");
    const run = (args) =>
      spawnSync(process.execPath, [command, ...args], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: join(directory, "missing.env"),
          DATABASE_URL: "postgresql://127.0.0.1/rio_dev",
          RIO_DATABASE_MODE: "isolated-development",
          TMDB_API_READ_ACCESS_TOKEN: "",
        },
        timeout: 10000,
      });
    const help = run(["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
    for (const args of [[], ["--ids", "0"], ["--ids", "550"]]) {
      const result = run(args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /TMDB import failed:/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
