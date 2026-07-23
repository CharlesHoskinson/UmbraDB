import { describe, it } from "vitest";

/**
 * G5 (A11) — crash-verification HANDOFF. These two scenarios cannot be green in the
 * durable-checkpoint-cursor change: they require an unclean postmaster kill and the
 * `UMBRADB_CRASH_HOOK` fault-schedule, both delivered by the testing-gate change (G9–G12). They
 * are authored here as intentionally PENDING (`it.skip`) so the handoff is explicit and their
 * ownership is recorded — per guideline §2.2 D6 / §2.3 DoD-5: "T5 / fault-schedule G11 MUST be
 * pending, not green, until G5 merges." G5 delivers the `opts.tx` API + `saveAndAdvance` these
 * tests need; it must NOT mark them green.
 */

describe("durable-cursor crash verification — HANDOFF to the testing-gate change (G9–G12)", () => {
  it.skip(
    "T5 (owned by G9–G12, pending until G5 merges): an unclean postmaster kill BETWEEN the data commit and the cursor advance, under synchronous_commit=on AND =off, never leaves the watermark ahead of durable checkpoint data (inverted order = BLOCK; a lost tail is acceptable). Requires an immediate postmaster kill; not expressible as an in-process test in this change.",
    () => {
      // Intentionally empty: the API surface (opts.tx + saveAndAdvance) exists as of G5; the crash
      // harness that fires an unclean postmaster kill in the target window is built by the
      // testing-gate change. See acceptance A11 and design.md §1.4.
    },
  );

  it.skip(
    "fault-schedule G11 (owned by G9–G12, pending until G5 merges): the UMBRADB_CRASH_HOOK points `after-data-commit-before-cursor` and `after-cursor-before-data` drive the ordering-direction assertions. Requires the crash-hook harness, which lives only in test entrypoints of the testing-gate change and does not exist yet.",
    () => {
      // Intentionally empty: fault-hook plumbing (read from an env var, never touching src/) is
      // delivered by the testing-gate change. G5 only guarantees the composition primitives it
      // will exercise.
    },
  );
});
