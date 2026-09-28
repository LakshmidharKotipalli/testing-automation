# Login validation smoke

Allowed domains: 127.0.0.1

This request targets the local fixture site (`pnpm fixture:serve`, http://127.0.0.1:4173).

## Test data

- validEmail: qa+{{runId}}@example.test
- invalidPassword (secret): InvalidPassword123!

## Scenario: Invalid password shows an accessible error

Objective: Verify failed login handling without successful login.
Priority: high
Roles: functional
Viewports: desktop, mobile
Expected: User remains on /login and receives an accessible invalid-credentials error.
Steps:

1. Navigate to /login
2. Verify heading "Sign in" is visible
3. Fill "Email" field with {{testData.validEmail}}
4. Fill "Password" field with {{testData.invalidPassword}}
5. Click button "Sign in"
6. Verify URL contains /login
7. Verify alert is visible
8. Verify alert contains "Invalid email or password"
9. Take screenshot invalid-password-error

## Scenario: Pricing lists every plan

Objective: Verify the pricing page renders the three plans.
Roles: functional
Viewports: desktop
Expected: Free, Pro and Team plans are visible and Pro costs $20.
Steps:

1. Navigate to /pricing
2. Verify heading "Pricing" is visible
3. Verify test id "plan-pro" contains "$20"
4. Verify there are no console errors

## Restrictions

- Do not create accounts.
- Do not attempt a successful sign-in.
