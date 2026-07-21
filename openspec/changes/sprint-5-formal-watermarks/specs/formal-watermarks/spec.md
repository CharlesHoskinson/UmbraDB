# formal-watermarks

## ADDED Requirements

### Requirement: The abstract Watermarks store has one absence representation

The Lean model SHALL represent a Watermarks store as a total mapping from exact `(kind, key)`
addresses to optional values, with `none` as the observable result for a never-set address.

#### Scenario: Empty lookup is absent
- **WHEN** `get` is evaluated at any address in the empty abstract store
- **THEN** the result SHALL be `none`

### Requirement: Set is an unconditional overwrite at the exact address

WHEN `set(store, address, value)` is evaluated, THEN lookup at `address` SHALL return `some value`,
with no version, guard, history, or monotonicity precondition.

#### Scenario: A later value wins at the same address
- **WHEN** one address is set first to `v1` and then to `v2`
- **THEN** lookup at that address SHALL return `some v2`

#### Scenario: Repeating an identical set is idempotent
- **WHEN** one address is set to `v` twice
- **THEN** the resulting abstract store SHALL equal the store produced by setting it once

#### Scenario: Abstract absence remains distinct from a stored null-like value
- **WHEN** the generic value type is instantiated as `Option Nat` and an address is set to the
  inner value `none`
- **THEN** lookup at that address SHALL return outer `some none`, distinct from outer `none`
- **AND** this abstract witness SHALL NOT be described as acceptance of runtime top-level JSON
  `null`, which remains outside the refinement domain

### Requirement: Set preserves distinct addresses

IF two complete `(kind, key)` addresses are distinct, THEN setting either address SHALL preserve
lookup at the other, and the two set operations SHALL commute.

#### Scenario: Equal keys under different kinds remain isolated
- **WHEN** `(kindA, key)` and `(kindB, key)` are distinct because `kindA ≠ kindB`
- **THEN** setting either address SHALL NOT change lookup at the other

#### Scenario: Different keys under one kind remain isolated
- **WHEN** `(kind, keyA)` and `(kind, keyB)` are distinct because `keyA ≠ keyB`
- **THEN** setting either address SHALL NOT change lookup at the other

### Requirement: Command traces compose in list order

For any initial store and command lists `left` and `right`, running `left ++ right` SHALL equal
running `left` and then running `right` from the resulting store.

#### Scenario: Appended traces equal sequential execution
- **WHEN** two finite set-command traces are concatenated
- **THEN** their single-pass result SHALL equal the result of executing the traces sequentially

### Requirement: Lookup after a trace returns the last matching value

The Lean model SHALL define a store-independent `lastMatching` observer that returns `some value`
exactly for the final command targeting the queried address, or `none` when no command matches.
For any initial store, address, and finite command trace, lookup after executing the trace SHALL
equal that final matching value when present, or the initial lookup result when no command targets
the address.

#### Scenario: The last matching command need not be the final command
- **WHEN** a trace sets address `a`, later sets `a` again, and then ends with a set at distinct
  address `b`
- **THEN** `lastMatching` at `a` SHALL return `some` of the second value
- **AND** lookup at `a` SHALL return that same `some` value

#### Scenario: An untouched address retains its initial value
- **WHEN** no command in a trace targets address `a`
- **THEN** lookup at `a` after the trace SHALL equal lookup at `a` in the initial store

### Requirement: The W1 proof claim remains abstract

The sprint SHALL NOT claim that the Lean model proves PostgreSQL upsert behavior, JSON
serialization, transaction participation, timestamps, HOT eligibility, cancellation, error
translation, concurrency, or monotonic progress.

#### Scenario: Runtime obligations remain outside the theorem boundary
- **WHEN** the sprint reports W1 complete
- **THEN** status documentation SHALL identify the result as an abstract Watermarks proof and
  SHALL leave the PostgreSQL adapter as an external refinement obligation
