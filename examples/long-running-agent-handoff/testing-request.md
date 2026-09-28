# Long multi-step flow with planned agent rotation

Allowed domains: 127.0.0.1

Walks the fixture's six-page flow (`/flow/1` .. `/flow/6`). The compiled plan sets a deliberately low
`maxActionsPerAgentInstance` so the agent instance reaches its lifecycle limit mid-flow. BrowserSwarm must
checkpoint, write a validated handoff document, and terminate the exhausted instance cleanly.

## Test data

- note: fixture note value

## Scenario: Multi-step flow completes

Objective: Walk the multi-step flow to completion.
Roles: functional
Viewports: desktop
Expected: The final step shows Flow complete.
Steps:

1. Navigate to /flow/1
2. Fill "Note 1" field with {{testData.note}}
3. Click link "Next step"
4. Fill "Note 2" field with {{testData.note}}
5. Click link "Next step"
6. Fill "Note 3" field with {{testData.note}}
7. Click link "Next step"
8. Fill "Note 4" field with {{testData.note}}
9. Click link "Next step"
10. Fill "Note 5" field with {{testData.note}}
11. Click link "Next step"
12. Verify test id "done" is visible
