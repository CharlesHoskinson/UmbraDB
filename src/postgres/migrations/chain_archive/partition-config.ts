/**
 * Single source of truth for the chain-archive schema's height-range partition bucket size and
 * pre-creation headroom (`design/full-chain-storage-design.md` §4.6, revised per the 3-reviewer
 * design-council audit). Two reviewers flagged the original `005_chain_archive.ts` as
 * contradicting the design doc's own claim that bucket size is "configurable": the doc said so
 * in prose, but the DDL hardcoded `1000000` inline with no shared constant and no doc
 * cross-reference. This module is the fix — one real constant, imported everywhere a partition
 * bound is computed, so the doc and the code cannot silently diverge again. It is a build-time
 * constant, not a runtime/env-configurable parameter: a genuinely runtime-configurable bucket
 * size would require generating partition DDL from external config at deploy time, which is out
 * of scope for this pass (see the design doc's revision-history note and §4.6).
 */

/** Blocks (by height) / transactions (by block_height) / bridge_observations (by block_height)
 *  per partition bucket. */
export const CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE = 1_000_000;

/** How many buckets this migration pre-creates ahead of genesis (height 0), in addition to the
 *  `DEFAULT` catch-all partition. §4.6/§9 (operational rollover): a single `DEFAULT` partition
 *  that silently accumulates all overflow rows is a real operational hazard — detaching and
 *  reorganizing it once it holds a nontrivial number of rows requires a heavyweight, locking
 *  `DETACH`/backfill/`ATTACH` sequence (documented in the design doc's rollover runbook). Five
 *  buckets (5,000,000 blocks of headroom) is enough runway that, combined with the scheduled
 *  rollover job the design doc's runbook describes running well before the top bucket fills,
 *  `DEFAULT` should in practice never receive a row on a healthy deployment. */
export const CHAIN_ARCHIVE_PRECREATED_PARTITIONS = 5;
