# ICAT USA demo smoke

The target website comes from `BROWSERSWARM_TARGET_URL` in `.env` (set it to `https://demo.icatusa.org`).

## Scenario: Home page loads on the demo site

Objective: Verify the home page opens on demo.icatusa.org and renders content.
Priority: high
Roles: functional
Viewports: desktop
Expected: The home page loads on demo.icatusa.org and shows at least one link.
Steps:

1. Navigate to /
2. Verify URL contains demo.icatusa.org
3. Take screenshot home-desktop

## Scenario: Home page has no horizontal overflow

Objective: Verify the home page layout fits tablet and mobile widths.
Roles: responsive
Viewports: tablet, mobile
Expected: The home page renders without horizontal scrolling at each viewport.
Steps:

1. Navigate to /
2. Verify there is no horizontal overflow
3. Take screenshot home-responsive

## Scenario: Home page has no console errors or failed requests

Objective: Verify the home page loads cleanly from the browser's point of view.
Roles: functional
Viewports: desktop
Expected: No console errors and no failed network requests on the home page.
Steps:

1. Navigate to /
2. Verify there are no console errors
3. Verify there are no network failures

## Restrictions

- Do not sign in or create accounts.
- Do not submit any forms.
