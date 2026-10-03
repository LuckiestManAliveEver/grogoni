# CP0 Scope Baseline

Status: passed
Date opened: 2026-07-01
Date passed: 2026-07-01

## Product Goal

Build Grogoni as a mobile-first, offline-capable, AI-assisted business operating system for informal and small businesses.

The user should be able to run core commerce workflows through chat, with structured mobile screens for review and confirmation.

## MVP Scope

MVP includes:

- account creation
- owner login
- business setup
- language selection
- mobile PWA shell
- chat shell
- quick actions
- rule-based command parser
- products
- customers
- basic suppliers
- invoices
- inventory movements
- local storage
- offline queue
- basic sync
- manual payments
- M-Pesa payment tracking path
- audit events
- basic reports

## MVP Exclusions

MVP excludes:

- third-party marketplace
- full Trusted Identity Execution Layer
- autonomous procurement
- cross-business collaboration
- full digital twin simulations
- advanced forecasting
- arbitrary/general-purpose agent tools
- full local LLM requirement on low-end phone
- native Android-only delivery

## Beta Scope

Beta adds:

- document import
- expanded Swahili support
- payment webhook hardening
- full Grogoniclaw adapter
- optional cloud fallback
- reports
- notifications
- logistics
- device testing
- sync conflict UX

## Public Launch Scope

Public Launch adds:

- performance hardening
- accessibility pass
- regional tax configuration
- SMS fallback
- USSD stub
- production observability
- backup and restore validation
- support process

## Post-Launch Scope

Post-launch adds:

- marketplace foundation
- first-party skills
- third-party skill onboarding
- full TIEL
- advanced logistics
- digital twin
- forecasting
- multi-agent collaboration
- voice-first workflows

## Non-Negotiable Boundaries

1. AI does not directly mutate business records.
2. Business Runtime owns correctness.
3. Tool Executor is the only path to business actions.
4. Verification precedes state-changing actions.
5. High and critical risk actions require confirmation.
6. Events are immutable.
7. Offline conflicts involving money, tax, invoice totals, discounts, or product quantity are not auto-resolved.
8. Payment state is verified server-side.
9. General host tools are not exposed to merchant-facing agents.
10. The app remains mobile-first and usable on low-end Android targets.
