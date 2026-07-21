import Lake
open Lake DSL

package UmbraDBFormalTest where
  version := v!"0.1.0"

require mathlib from git
  "https://github.com/leanprover-community/mathlib4.git" @ "v4.32.0"

@[default_target]
lean_lib UmbraDBFormal

@[default_target]
lean_lib UmbraDBFormalTest
