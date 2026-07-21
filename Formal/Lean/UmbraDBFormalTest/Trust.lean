import Mathlib.Util.AssertNoSorry
import UmbraDBFormalTest.APISmoke
import UmbraDBFormalTest.TemporalKV.Model
import UmbraDBFormalTest.TemporalKV.Laws
import UmbraDBFormalTest.TemporalKV.Retention.Model
import UmbraDBFormalTest.TemporalKV.Retention.Laws

/-!
# UmbraDB proof-trust audit

The source scanner is a fast first line of defense, but source text alone cannot establish an
environment property: a command elaborator can add a declaration without spelling a standalone
forbidden keyword. This module therefore audits the elaborated environment on every default build.
-/

namespace UmbraDBFormalTest.Trust

open Lean Elab Command

/-- Axiom declarations supplied by the pinned Lean/mathlib import closure. These are dependency
internals, not the smaller set that UmbraDB declarations may transitively use. -/
private def dependencyAxiomDeclarations : Array Name := #[
  `sorryAx,
  `lcUnreachable,
  `lcProof,
  `Lean.ofReduceBool,
  `isScalarObj,
  `Lean.trustCompiler,
  `Lean.ofReduceNat,
  `lcAny,
  `Quot.lcInv,
  `propext,
  `lcErased,
  `lcCast,
  `lcVoid,
  `Quot.sound,
  `Classical.choice
]

/-- The only transitive axioms permitted in declarations compiled from UmbraDB modules. -/
private def permittedProjectAxioms : Array Name := #[
  `propext,
  `Quot.sound,
  `Classical.choice
]

private def isUmbraDBModule (moduleName : Name) : Bool :=
  moduleName.toString.startsWith "UmbraDBFormal"

/-- Reject extra axiom declarations and non-allowlisted axiom dependencies in every declaration
whose source module belongs to either UmbraDB Lean library. -/
elab "#audit_umbradb_trust" : command => do
  let environment ← getEnv

  for (name, declaration) in environment.constants.toList do
    match declaration with
    | .axiomInfo _ =>
        unless dependencyAxiomDeclarations.contains name do
          throwError "unexpected axiom declaration in elaborated environment: {name}"
    | _ => pure ()

  for (name, _) in environment.constants.toList do
    let moduleName := match environment.getModuleIdxFor? name with
      | some moduleIndex => environment.header.moduleNames[moduleIndex.toNat]!
      | none => environment.mainModule
    unless isUmbraDBModule moduleName do
      continue
    for axiomName in (← Lean.collectAxioms name) do
      unless permittedProjectAxioms.contains axiomName do
        throwError "declaration {name} from {moduleName} depends on forbidden axiom {axiomName}"

#audit_umbradb_trust

end UmbraDBFormalTest.Trust
