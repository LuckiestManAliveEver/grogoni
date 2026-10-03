# Authentication and shop-deletion audit

## Authentication decision

Social OAuth login is disabled for Google, Facebook, TikTok, Apple, GitHub, Microsoft, LinkedIn,
and X. The frontend has no social-login controls, the provider registry reports every OAuth
provider as disabled, and all OAuth start/callback paths are rejected by the API.

Phone account access uses Grogoni PIN routes. Phone OTP is rejected, while the existing email OTP path
remains available. First-shop registration stores an unverified private phone identity without
sending an SMS.

## Shop deletion

Shop deletion remains protected by owner authorization, exact shop ID confirmation, and PIN. This
authentication-channel change does not alter its tenant-scoped deletion behavior.
