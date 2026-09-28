# Checkout form validation (no purchase)

Validate the checkout form's client-side validation. The order must never be placed: BrowserSwarm blocks
purchase and payment actions by default, and this request deliberately stops before any submit button.

## Test data

- shopperEmail: qa+{{runId}}@example.test
- badCard (secret): 4000 0000 0000 0002

## Scenario: Checkout shows validation errors for an invalid card

Objective: Verify invalid card details show inline errors without submitting payment.
Priority: high
Roles: functional, forms
Viewports: desktop, mobile
Expected: The card field shows an inline validation error and no order is placed.
Steps:

1. Navigate to /checkout
2. Verify heading "Checkout" is visible
3. Fill "Email" field with {{testData.shopperEmail}}
4. Fill "Card number" field with {{testData.badCard}}
5. Press Tab
6. Verify test id "card-error" contains "card number is invalid"
7. Verify button "Place order" is disabled
8. Take screenshot checkout-invalid-card

## Restrictions

- Do not place orders or submit payment.
- Do not create accounts.
