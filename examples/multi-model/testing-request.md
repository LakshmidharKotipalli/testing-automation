# Pricing smoke with per-role models

Allowed domains: staging.example.com

Uses `browserswarm.config.yaml` in this folder: a fast default model, a vision-capable model for the
accessibility role, and a stronger model for verification. Steps are still scripted and deterministic;
models are only consulted on approved fallback triggers (e.g. a locator that cannot be found).

## Scenario: Pricing page lists plans

Objective: Verify the pricing page renders every plan at desktop and mobile widths.
Roles: functional, accessibility
Viewports: desktop, mobile
Expected: Free, Pro and Team plans are visible and the page does not overflow horizontally.
Steps:

1. Navigate to /pricing
2. Verify heading "Pricing" is visible
3. Verify test id "plan-pro" contains "$20"
4. Verify there is no horizontal overflow
