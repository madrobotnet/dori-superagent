import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const packages = [".", "skills/dori-mode/scripts"];

// `bun link` makes each bin target executable. If git tracks the file as 100644, that leaves a mode change in the
// checkout, and the next `install.sh` run (`git pull --ff-only`) aborts as soon as upstream touches the file.
describe("bin targets", () => {
  for (const pkg of packages) {
    test(`${pkg}/package.json bins are tracked as executable, so bun link leaves the checkout clean`, () => {
      const bin: Record<string, string> = JSON.parse(readFileSync(join(root, pkg, "package.json"), "utf8")).bin;
      for (const target of Object.values(bin)) {
        const path = join(pkg, target);
        // The mode is git's record, so outside a git checkout (a source tarball, say) there is nothing to check.
        const ls = Bun.spawnSync(["git", "ls-files", "-s", "--", path], { cwd: root });
        if (ls.exitCode !== 0) throw new Error(`this test requires a git checkout: git ls-files exited ${ls.exitCode}: ${ls.stderr.toString().trim()}`);
        const listed = ls.stdout.toString();
        expect({ path, mode: listed.split(" ")[0] }).toEqual({ path, mode: "100755" });
      }
    });
  }
});
