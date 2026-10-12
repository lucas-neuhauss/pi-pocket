// New-file summary counts must agree with Git and remain stable when files are staged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changesIn, diffOf } from "../src/server/changes.ts";
// Load the plain web module without asking TypeScript for declarations.
const MODULE: string = "../web/diff-parse.js";
const { parseDiff } = await import(MODULE);

function fixture(firstCommit = true) {
    const root = mkdtempSync(join(tmpdir(), "pocket-counts-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");

    if (firstCommit) {
        git("commit", "--allow-empty", "-qm", "baseline");
    }

    return { root, git };
}

test("new text counts match the diff and do not change on staging", async (t) => {
    const { root, git } = fixture();

    t.after(() => rmSync(root, { recursive: true, force: true }));

    const cases = new Map([
        ["normal.txt", "one\ntwo\nthree\n"],
        ["no-final-newline.txt", "one\ntwo"],
        ["empty.txt", ""],
        ["crlf.txt", "one\r\ntwo\r\n"],
        ["unicode.txt", "Olá\n世界\n"],
        ["space tab\tnewline\n.txt", "one\n"],
    ]);

    for (const [path, content] of cases) {
        writeFileSync(join(root, path), content);
    }

    writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 10]));

    const before = await changesIn(root, []);

    for (const file of before.files) {
        if (file.path === "binary.bin") {
            assert.equal(file.added, undefined);
            assert.equal(file.removed, undefined);

            continue;
        }

        const parsed = parseDiff(await diffOf(root, file.path), file.path).files[0];

        assert.equal(file.added, parsed?.added ?? 0, file.path);
        assert.equal(file.removed, parsed?.removed ?? 0, file.path);
    }

    assert.equal(
        before.files.reduce((sum, file) => sum + (file.added ?? 0), 0),
        10,
    );
    git("add", "-A");

    const after = await changesIn(root, []);
    const counts = (files: typeof before.files) =>
        files.map(({ path, added, removed }) => ({ path, added, removed }));

    assert.deepEqual(counts(after.files), counts(before.files));
});

test("large files use counts-only output, before and after staging", async (t) => {
    const { root, git } = fixture();

    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "large.txt"), `${"x".repeat(79)}\n`.repeat(131072));

    const before = await changesIn(root, []);

    assert.equal(before.files[0]!.added, 131072);
    assert.equal((await changesIn(root, [])).files[0]!.added, 131072);
    git("add", "large.txt");
    assert.equal((await changesIn(root, [])).files[0]!.added, 131072);
});

test("cached counts invalidate on same-size rewrites even with restored mtime", async (t) => {
    const { root } = fixture();

    t.after(() => rmSync(root, { recursive: true, force: true }));

    const path = join(root, "fresh.txt");

    writeFileSync(path, "a\nb\n");

    const before = await changesIn(root, []);
    const info = statSync(path);

    assert.equal(before.files[0]!.added, 2);
    assert.deepEqual(await changesIn(root, []), before);
    writeFileSync(path, "abcd");
    utimesSync(path, info.atime, info.mtime);

    const rewritten = await changesIn(root, []);

    assert.equal(rewritten.files[0]!.added, 1);
    assert.notEqual(rewritten.files[0]!.version, before.files[0]!.version);
    writeFileSync(path, Buffer.from([0, 1, 2, 3]));
    assert.equal((await changesIn(root, [])).files[0]!.added, undefined);
    rmSync(path);
    assert.equal((await changesIn(root, [])).files.length, 0);
    writeFileSync(path, "a\nb\nc\n");
    assert.equal((await changesIn(root, [])).files[0]!.added, 3);
});

test("cache expiry rechecks Git attributes without a file content change", async (t) => {
    const { root } = fixture();
    let now = Date.now();

    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(Date, "now", () => now);
    writeFileSync(join(root, "fresh.txt"), "one\ntwo\n");
    assert.equal((await changesIn(root, [])).files[0]!.added, 2);
    writeFileSync(join(root, ".gitattributes"), "fresh.txt -diff\n");
    now += 31_000;

    const binary = (await changesIn(root, [])).files.find((file) => file.path === "fresh.txt");

    assert.equal(binary?.added, undefined);
    writeFileSync(join(root, ".gitattributes"), "fresh.txt diff\n");
    now += 31_000;
    assert.equal(
        (await changesIn(root, [])).files.find((file) => file.path === "fresh.txt")?.added,
        2,
    );
});

test("before the first commit, both staged and untracked files have counts", async (t) => {
    const { root, git } = fixture(false);

    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "staged.txt"), "one\ntwo\n");
    git("add", "staged.txt");
    writeFileSync(join(root, "fresh.txt"), "three");

    const changes = await changesIn(root, []);

    assert.equal(changes.repo?.head, undefined);
    assert.deepEqual(
        changes.files.map(({ path, added, removed }) => ({ path, added, removed })),
        [
            { path: "staged.txt", added: 2, removed: 0 },
            { path: "fresh.txt", added: 1, removed: 0 },
        ],
    );
});

test("concurrent reviews agree, including a new symlink", async (t) => {
    const { root, git } = fixture();

    t.after(() => rmSync(root, { recursive: true, force: true }));

    for (let index = 0; index < 20; index++) {
        writeFileSync(join(root, `file-${index}.txt`), "one\ntwo\n");
    }

    symlinkSync("file-0.txt", join(root, "link"));

    const reviews = await Promise.all(Array.from({ length: 5 }, () => changesIn(root, [])));

    for (const review of reviews) {
        assert.deepEqual(review, reviews[0]);
    }

    assert.equal(reviews[0]!.files.find((file) => file.path === "link")?.added, 1);
    git("add", "-A");
    assert.equal((await changesIn(root, [])).files.find((file) => file.path === "link")?.added, 1);
});
