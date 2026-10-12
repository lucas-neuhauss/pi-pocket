# Changes counts benchmark

Final rerun on 2026-10-11, after removing `-U3` from count-only commands. No concurrent `npm test` was launched for this run.

## Environment and reproduction

- Apple M4 Pro, macOS (`darwin/arm64`), Node v22.23.3.
- Git 2.50.1 (Apple Git-155).
- HEAD baseline: `6067422bf1cb209872dd84c647036dc07bf06018`.
- Source SHA256 prefixes: HEAD `16c5c02dc4abd4be`; current `e9fc5a05d62fe3b5`.
- Command: `node test/bench-changes.ts --runs=7 --warmup=2 --baseline=6067422bf1cb209872dd84c647036dc07bf06018`.
- Raw results and follow-up diagnostics: `/tmp/pocket-counts-benchmark.log` (local temporary log, not committed).

The script imports actual working-tree `changesIn` and loads the selected baseline's `src/server/changes.ts` into a temporary module. Only its runtime git-helper import is redirected to the checkout. Pass the recorded baseline hash to reproduce this comparison after committing; the script otherwise defaults to `origin/main`.

## Method

Each fixture has 20 tracked text files, with 10 modified to add one line. Fixtures additionally contain 0, 10, 100, or 500 untracked 1 KiB/32-line text files. A separate fixture contains a 10 MiB/131072-line text file and a 1 MiB NUL-containing binary.

Times cover the entire awaited `changesIn(repo, [])`, with default `onlyHere=false`. Cold samples use unique repository paths for each implementation and sample, guaranteeing application-cache misses. Warm samples use each implementation's own unchanged repository after two untimed calls. Implementation order alternates. Repository setup, validation, warmup, and cleanup are excluded. All files are synthetic, repositories/modules are temporary, and global Git configuration is disabled by the benchmark.

Validation checks file totals, the 500-file cap, tracked counts, and current untracked counts: 32/0 for small text, 131072/0 for large text, and absent counts for binary. The pre-change baseline intentionally has no untracked counts.

## Final results

Milliseconds; median/p95, with nearest-rank p95. Speedup is HEAD median divided by current median (below 1 means slower).

| Fixture             | Mode | HEAD median/p95 | Current median/p95 | Speedup |
| ------------------- | ---- | --------------: | -----------------: | ------: |
| Tracked-only        | Cold |     56.41/71.78 |        55.37/62.61 |   1.02x |
| Tracked-only        | Warm |     49.21/50.09 |        48.47/51.19 |   1.02x |
| 10 untracked        | Cold |     50.45/53.49 |        87.17/87.93 |   0.58x |
| 10 untracked        | Warm |     48.68/52.07 |        48.38/48.96 |   1.01x |
| 100 untracked       | Cold |     50.23/50.60 |      360.24/363.45 |   0.14x |
| 100 untracked       | Warm |     50.31/51.54 |        49.41/51.38 |   1.02x |
| 500 untracked       | Cold |     53.52/54.25 |    1577.17/1594.26 |   0.03x |
| 500 untracked       | Warm |     52.79/56.18 |        52.78/53.70 |   1.00x |
| Large text + binary | Cold |     50.80/51.52 |        84.30/85.29 |   0.60x |
| Large text + binary | Warm |     49.79/51.28 |        49.45/51.72 |   1.01x |

Cached calls now match baseline, including the large-text fixture. First-time counting remains proportional to the number of visible untracked files because it spawns a Git comparison for each, with global concurrency four.

## Large-file investigation

A separate temporary-repository diagnostic intercepted Node's `execFile` to count actual `git diff --no-index --numstat` processes, without altering production code:

- First Changes call spawned two count processes (text and binary), returned text counts 131072/0 and no binary counts.
- The next two calls spawned **zero** count processes and returned identical counts and stat versions. Counts were retained in cache; Git did not change the file versions.
- Count-only Git stdout for the large text was **30 bytes**.
- Adding `-U3` to that same numstat invocation produced **10,616,993 bytes**, including the complete patch. This exceeds the 16 KiB count-command buffer and explains the earlier failed counts and uncached warm retries.
- Filtering `-U3` out of count flags fixes both output size and warm caching. The final benchmark's assertions confirm large counts succeed on every sample.

## Limitations

- Cold means application-cache cold, not OS disk-cache cold; fixture contents were just written.
- Seven samples are small: nearest-rank p95 is the maximum observation, not a robust tail-latency estimate.
- Process startup, machine scheduling, and other host activity can affect timings. Repeat with more samples for capacity decisions.
- Warm tests remain within the 30-second cache TTL and do not measure expiry, mutations, attribute changes, or simultaneous sessions.
- The 500-untracked fixture also has 10 tracked modifications; the display cap therefore counts only 490 untracked files and reports 10 omitted files.
- The baseline does less work (no new-file counts), so cold overhead is the cost of additional functionality, not equivalent-output algorithm regression.
- Synthetic fixtures do not represent large tracked repositories, unusual attributes, or all file types.

Checks: benchmark validation, Prettier, ESLint, and project TypeScript check passed. No commits made.
