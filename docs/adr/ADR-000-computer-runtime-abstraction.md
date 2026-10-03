# ADR: Grogoni-Owned ComputerRuntime Abstraction

## Status

Accepted

## Context

Grogoni needs agents to operate external graphical web applications while preserving user control, approval, auditability, and runtime continuity.

## Decision

Grogoni owns a provider-neutral `ComputerRuntime` contract and exposes browser work as `computer.*` capabilities. Provider implementations stay replaceable behind adapters.

## Consequences

The model never receives provider-native browser handles. Stagehand, Browser Use, Browserbase, Playwright, or local CDP can be evaluated without changing the agent/runtime contract. Approval and `RuntimeHandoff` remain Grogoni primitives.
