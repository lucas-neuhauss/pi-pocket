/**
 * Standalone Changes benchmark (not part of npm test):
 *     node test/bench-changes.ts [--runs=7] [--warmup=2] [--baseline=origin/main]
 *
 * Compares the working-tree changesIn with the selected baseline's changes.ts, loaded unchanged except for
 * redirecting its runtime ./git.ts import to this checkout's git helper. All baseline modules and fixture repos
 * live in one temporary folder, removed in finally; no files are written into src/ or any existing repository.
 * Defaults to origin/main; pass a commit hash to reproduce historical results. Prints its commit and source hashes.
 *
 * Fixtures have 20 tracked text files, 10 modified, plus 0/10/100/500 untracked 1 KiB text files; a separate fixture
 * adds a 10 MiB text file and a 1 MiB NUL-containing binary. Calls use empty entries and default onlyHere=false.
 * Cold means a new repository path for every implementation/sample (application caches cold, NOT OS disk caches).
 * Warm means repeated calls on each implementation's own unchanged repository after warmup. Setup, warmup,
 * validation and cleanup are outside timings. Implementation order alternates each sample. Reports median and
 * nearest-rank p95 wall-clock milliseconds for the entire awaited changesIn, plus baseline/current median ratio.
 * Small samples and process-spawn scheduling are noisy: use more runs and repeat before interpreting a speedup.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { changesIn, type Changes } from "../src/server/changes.ts";
import { git } from "../src/server/git.ts";

const project = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);

function option(name: string, fallback: number, minimum: number): number {
    const matches = args.filter((arg) => arg.startsWith(`--${name}=`));
    const value = matches.length === 0 ? fallback : Number(matches[0]!.split("=")[1]);

    assert(matches.length <= 1 && Number.isSafeInteger(value) && value >= minimum);

    return value;
}

assert(
    args.every((arg) => /^--(runs|warmup)=\d+$/.test(arg) || /^--baseline=.+$/.test(arg)),
    "Use --runs=N --warmup=N --baseline=REF",
);

const baselines = args.filter((arg) => arg.startsWith("--baseline="));

assert(baselines.length <= 1, "Pass at most one baseline");

const baselineRef = baselines[0]?.slice("--baseline=".length) ?? "origin/main";
const runs = option("runs", 7, 1);
const warmup = option("warmup", 2, 1);
const fixtures = [
    { name: "tracked-only", small: 0, large: false },
    { name: "untracked-10", small: 10, large: false },
    { name: "untracked-100", small: 100, large: false },
    { name: "untracked-500", small: 500, large: false },
    { name: "large-text+binary", small: 0, large: true },
];

type Fixture = (typeof fixtures)[number];
type Implementation = { name: string; call: typeof changesIn };

// Do not let the user's global git attributes, hooks, or configuration affect synthetic fixtures.
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_SYSTEM = devNull;

const temporary = await mkdtemp(join(tmpdir(), "pocket-bench-changes-"));
let sequence = 0;

async function repository(fixture: Fixture): Promise<string> {
    const root = join(temporary, `repo-${sequence++}`);

    await mkdir(root);
    await git(root, ["init", "--quiet", "--initial-branch=main", "--template="]);
    await git(root, ["config", "user.name", "Changes benchmark"]);
    await git(root, ["config", "user.email", "benchmark@example.invalid"]);
    await git(root, ["config", "core.autocrlf", "false"]);
    await git(root, ["config", "core.attributesFile", devNull]);
    await git(root, ["config", "core.hooksPath", devNull]);

    for (let index = 0; index < 20; index++) {
        await writeFile(join(root, `tracked-${index}.txt`), "before\n".repeat(32));
    }

    await git(root, ["add", "--all"]);
    await git(root, ["commit", "--quiet", "-m", "fixture", "--no-gpg-sign"]);

    for (let index = 0; index < 10; index++) {
        await writeFile(join(root, `tracked-${index}.txt`), "before\n".repeat(32) + "after\n");
    }

    for (let index = 0; index < fixture.small; index++) {
        await writeFile(
            join(root, `untracked-${String(index).padStart(3, "0")}.txt`),
            `${"x".repeat(31)}\n`.repeat(32),
        );
    }

    if (fixture.large) {
        await writeFile(join(root, "untracked-large.txt"), `${"x".repeat(79)}\n`.repeat(131072));
        await writeFile(join(root, "untracked-binary.bin"), Buffer.alloc(1024 * 1024, 0));
    }

    return root;
}

function validate(result: Changes, fixture: Fixture, current: boolean): void {
    const total = 10 + fixture.small + (fixture.large ? 2 : 0);

    assert.equal(result.files.length, Math.min(total, 500));
    assert.equal(result.more, Math.max(total - 500, 0));
    assert.equal(result.piOnly.length, 0);
    assert.equal(result.repo?.branch, "main");
    assert(result.repo?.head);
    assert(result.files.every((file) => file.byPi === false && file.version !== undefined));

    const tracked = result.files.filter((file) => file.path.startsWith("tracked-"));

    assert.equal(tracked.length, 10);
    assert(
        tracked.every((file) => file.kind === "modified" && file.added === 1 && file.removed === 0),
    );
    const untracked = result.files.filter((file) => !file.path.startsWith("tracked-"));

    assert(untracked.every((file) => file.kind === "new"));

    if (current) {
        for (const file of untracked) {
            if (file.path === "untracked-binary.bin") {
                assert.equal(file.added, undefined);
                assert.equal(file.removed, undefined);
            } else {
                assert.equal(file.added, file.path === "untracked-large.txt" ? 131072 : 32);
                assert.equal(file.removed, 0);
            }
        }
    }
}

async function measure(
    implementation: Implementation,
    root: string,
    fixture: Fixture,
): Promise<number> {
    const start = performance.now();
    const result = await implementation.call(root, []);
    const elapsed = performance.now() - start;

    validate(result, fixture, implementation.name === "current");

    return elapsed;
}

function percentile(values: number[], fraction: number): number {
    const sorted = [...values].sort((left, right) => left - right);

    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function hash(source: string): string {
    return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

try {
    const commit = (
        await git(project, ["rev-parse", "--verify", "--end-of-options", `${baselineRef}^{commit}`])
    ).trim();
    const baselineSource = await git(project, ["show", `${commit}:src/server/changes.ts`]);
    const currentSource = await readFile(join(project, "src/server/changes.ts"), "utf8");
    const helper = pathToFileURL(join(project, "src/server/git.ts")).href;
    const modulePath = join(temporary, "baseline.mts");

    assert(
        baselineSource.includes('from "./git.ts"'),
        "Baseline git import changed; update loader",
    );
    await writeFile(modulePath, baselineSource.replace('from "./git.ts"', `from "${helper}"`));

    const baseline = (await import(pathToFileURL(modulePath).href)) as {
        changesIn: typeof changesIn;
    };
    const implementations: Implementation[] = [
        { name: "HEAD", call: baseline.changesIn },
        { name: "current", call: changesIn },
    ];

    console.log(
        `Node ${process.version}; ${process.platform}/${process.arch}; ${cpus()[0]?.model}`,
    );
    console.log(`Git ${(await git(project, ["--version"])).trim()}; baseline ${commit}`);
    console.log(`Source SHA256: HEAD=${hash(baselineSource)} current=${hash(currentSource)}`);
    console.log(
        `runs=${runs}; warmup=${warmup}; empty entries; cold = fresh repo, not cold OS cache`,
    );
    console.log("fixture\tmode\tHEAD median/p95 ms\tcurrent median/p95 ms\tmedian speedup");

    for (const fixture of fixtures) {
        for (const mode of ["cold", "warm"]) {
            const samples: number[][] = [[], []];
            const warmRoots: string[] = [];

            if (mode === "warm") {
                for (const implementation of implementations) {
                    const root = await repository(fixture);

                    warmRoots.push(root);

                    for (let iteration = 0; iteration < warmup; iteration++) {
                        validate(
                            await implementation.call(root, []),
                            fixture,
                            implementation.name === "current",
                        );
                    }
                }
            }

            for (let iteration = 0; iteration < runs; iteration++) {
                const order = iteration % 2 === 0 ? [0, 1] : [1, 0];

                for (const index of order) {
                    const root = mode === "cold" ? await repository(fixture) : warmRoots[index]!;
                    const elapsed = await measure(implementations[index]!, root, fixture);

                    samples[index]!.push(elapsed);

                    if (mode === "cold") {
                        await rm(root, { recursive: true, force: true });
                    }
                }
            }

            const summaries = samples.map(
                (values) => `${median(values).toFixed(2)}/${percentile(values, 0.95).toFixed(2)}`,
            );
            const ratio = median(samples[0]!) / median(samples[1]!);

            console.log(`${fixture.name}\t${mode}\t${summaries.join("\t")}\t${ratio.toFixed(2)}x`);

            for (const root of warmRoots) {
                await rm(root, { recursive: true, force: true });
            }
        }
    }
} finally {
    await rm(temporary, { recursive: true, force: true });
}
