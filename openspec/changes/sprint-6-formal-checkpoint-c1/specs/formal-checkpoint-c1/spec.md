# formal-checkpoint-c1

## ADDED Requirements

### Requirement: Chunk identities form an unconditional finite join projection

The Lean model SHALL represent the save-side set of stored chunk identities as `Finset Hash` and
SHALL merge identity sets by union. Merge SHALL be associative, commutative, idempotent, have the
empty set as identity, contain both inputs, and be the least identity set containing both inputs.

#### Scenario: Overlapping saves converge on the same identities
- **WHEN** one identity input contains `{h1, h2}` and another contains `{h2, h3}`
- **THEN** applying them in either order SHALL produce `{h1, h2, h3}`

#### Scenario: Duplicate positions erase only at the identity projection
- **WHEN** the ordered input list is `[h1, h2, h1]`
- **THEN** the list SHALL retain three positions
- **AND** its C1 identity projection SHALL contain exactly `{h1, h2}`

### Requirement: Saving identity inputs is extensive, repeat-idempotent, and order-independent

For any stored identity set and finite hash input, saving SHALL union the input projection into
the stored identities. Repeating one input SHALL not change the projection after its first save,
and two inputs SHALL produce the same identity projection in either order.

#### Scenario: Empty input adds no identity
- **WHEN** an empty hash input is saved into any identity projection
- **THEN** the projection SHALL remain unchanged
- **AND** this SHALL NOT be described as proving that runtime public `save` creates no manifest

### Requirement: Chunk-map merge preserves existing bytes

The Lean model SHALL represent byte-bearing chunk storage as a finite map and SHALL use an
existing-left-biased merge. An existing left binding SHALL remain unchanged; a right binding
SHALL be added exactly when the left map has no binding at that hash.

#### Scenario: Same hash with different bytes exposes order dependence
- **WHEN** two maps bind the same abstract hash to different byte values
- **THEN** merging left then right SHALL retain the left bytes
- **AND** reversing the merge SHALL retain the right bytes
- **AND** both maps SHALL still have the same one-element identity projection

### Requirement: Compatible chunk maps satisfy conditional C1 commutation

Two chunk maps SHALL be compatible exactly when every overlapping hash binds equal bytes. Merge
SHALL be associative and idempotent without compatibility and SHALL be commutative when
compatibility holds. Pairwise compatibility SHALL be preserved across merge so finite mutually
compatible inputs can later be handled without assuming compatibility is transitive. This sprint
SHALL NOT claim a finite-family permutation theorem.

#### Scenario: Equal overlapping bindings commute
- **WHEN** two maps overlap only at hashes whose bytes are equal
- **THEN** the maps SHALL be compatible
- **AND** merging them in either order SHALL produce the same map

#### Scenario: Compatibility is not assumed transitive
- **WHEN** a left and right map bind one common hash to different bytes and a middle map binds
  neither value
- **THEN** left SHALL be compatible with middle and middle compatible with right
- **AND** the model SHALL witness that left and right are incompatible

### Requirement: Collision freedom is an explicit local theorem premise

The Lean model SHALL expose a theorem deriving map compatibility from two well-hashed maps and a
digest that is injective on the union of their actually bound byte values. Any such collision-free
condition SHALL be a theorem premise and SHALL NOT be an axiom or a claim that SHA-256 is
mathematically injective.

#### Scenario: A concrete injective digest discharges the bridge
- **WHEN** a finite example uses a digest proved injective on its bound values
- **THEN** the compatibility theorem SHALL apply without any custom axiom

### Requirement: C1 remains a save-only abstract projection

The completed proof SHALL NOT claim idempotence or semilattice structure for public
`CheckpointStore.save`, the full store including prune, arbitrary incompatible chunk maps, or the
PostgreSQL adapter. Manifests, sequences, metadata, transactions, C2/GC, SHA security, and
save/load reconstruction SHALL remain outside this sprint.

#### Scenario: Completion status preserves future obligations
- **WHEN** Sprint 6 reports C1 complete
- **THEN** status documentation SHALL identify the result as abstract and save-side only
- **AND** SHALL leave C2a, ordered reconstruction, collision handling, and runtime refinement open
