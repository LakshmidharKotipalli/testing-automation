# Autonomous discovery example

Test a site you are authorized to test without writing scenarios. With the local fixture site:

```bash
pnpm fixture:serve   # terminal 1 (http://127.0.0.1:4173 by default)

# terminal 2: preflight -> authorize (yes) -> discovery -> review -> approve-safe-plan | export-and-edit | reject
pnpm browserswarm run --url http://127.0.0.1:4173 --discovery-config examples/autonomous-discovery/discovery-config.yaml

# discovery, profile, plan and review only (nothing executed)
pnpm browserswarm discover --url http://127.0.0.1:4173 --confirm-authorized \
  --discovery-config examples/autonomous-discovery/discovery-config.yaml --output artifacts/discovery-demo

# regenerate the plan from the saved profile without accessibility packets
pnpm browserswarm autonomous-plan --profile artifacts/discovery-demo/discovery/website-understanding-profile.json \
  --exclude-role accessibility --output plans/autonomous-plan.yaml --write plans/execution-plan.json
```

`testing-request.md` is a broad request, so `--prompt` with it also selects autonomous mode. Its "do not"
sentence becomes a recorded safety restriction and the checkout request becomes a scope conflict shown in the
review (never planned).
