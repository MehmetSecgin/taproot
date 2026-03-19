# TapRoot Agent Readiness

## Goal

Document how usable TapRoot currently is for agents that have only the TapRoot skill, what local/runtime setup is still required, and what we should change to make first-use agent workflows reliable.

## Short Answer

TapRoot is not yet fully usable by an agent with only the skill and no local context.

The skill is strong enough to teach command choice and workflow, but a fresh machine still needs local runtime state, config, KB data, datasource or KB-backed resolution, credentials, and often connector command setup before real queries can succeed.

TapRoot is much closer to agent-ready in an already prepared environment than it is on first install.

## What An Agent Can Already Do With Only The Skill

If the machine is already prepared, an agent can usually:

- choose the right command family (`doctor`, `query`, `datasource resolve`, `kb`, `cache`, `learn`, `template`, `connector`, `self-check`)
- follow a safe read-only workflow
- use env/service resolution and datasource resolution correctly
- understand deterministic vs discovery-based resolution
- inspect runtime health with `self-check`
- preflight connector/auth state with `doctor`
- use saved templates, cache entries, and learning state through TapRoot commands instead of reading files directly

This means the skill is already useful as an operating manual for an agent once TapRoot has been installed and configured.

## What Prevents Skill-Only Success On A Fresh Install

An agent with only the skill still depends on several local prerequisites:

- TapRoot must be installed or built and runnable.
- Runtime state must exist under `~/.taproot/` or `TAPROOT_STATE_ROOT`.
- Runtime config may be needed at `~/.taproot/config/deterministic-config.json`.
- `TAPROOT_MASTER_KEY` should be set so credential storage does not fall back to a machine-derived secret.
- KB files are expected under the memory-root-backed KB path.
- Datasource profiles may need to exist in `datasources.json`, unless KB bootstrap is sufficient.
- Credential refs may need to exist in the credential store.
- Connector command values may need to be configured for VPN, Teleport, or port-forward workflows.

These requirements come from the current runtime path and command behavior in:

- `src/core/paths.ts`
- `src/store/runtime-config.ts`
- `src/commands/query.ts`
- `src/commands/doctor.ts`
- `src/commands/connector.ts`

## Current First-Install Configuration Burden

### Minimum Practical Setup

For a user or agent to succeed on day one, the current setup is usually:

1. Install dependencies and build TapRoot.
2. Ensure the memory root resolves to a location that contains KB files, or provide `--memory-root`.
3. Optionally create runtime config at `~/.taproot/config/deterministic-config.json`.
4. Store credentials with `taproot creds set`.
5. Either:
   - add a datasource manually with `taproot datasource add`, or
   - rely on KB-backed auto-bootstrap via `taproot query --env --service`.
6. If connectors are required, configure them through credential refs or `taproot connector setup`.

### What Is Already Nice

- State directories are created automatically.
- `query --env --service` can auto-bootstrap datasources from KB.
- Runtime config has safe neutral defaults when an env policy is missing.
- `self-check` gives a lightweight runtime sanity check.
- `doctor` provides actionable next steps for several connector failures.

### What Still Feels Heavy

- There is no single first-run command that prepares the environment.
- `self-check` reports raw checks but not a clear readiness state.
- KB availability is assumed rather than guided.
- Credential and connector setup is still fairly manual.
- The agent has to infer whether the machine is actually query-ready.

## Current Agent-Readiness Assessment

### In A Prepared Environment

TapRoot is close to agent-ready when these already exist:

- built CLI
- valid runtime state root
- KB files
- datasource profiles or KB connection data
- credential refs
- connector commands where needed

In that case, the TapRoot skill is likely enough for an agent to operate successfully.

### On First Install

TapRoot is not yet agent-ready on a fresh machine.

The gap is not command surface coverage. The gap is install/setup orchestration and machine-readability of readiness.

## Recommendations

### 1. Add `taproot init`

Add a real first-run initializer that:

- creates state directories
- writes a starter `deterministic-config.json` if missing
- checks memory-root and KB visibility
- warns when `TAPROOT_MASTER_KEY` is unset and TapRoot would use the fallback derived secret
- explains what is still missing
- optionally writes example config with empty `environmentPolicies` and `serviceAliases`

This should be the default entrypoint for first install.

### 2. Add A Guided Setup Flow

Add a command such as `taproot setup datasource` or `taproot init datasource` that can:

- create datasource profiles from KB when available
- prompt for missing topology when KB is incomplete
- create or link credential refs
- wire connector refs

This reduces the number of independent commands an agent must discover and sequence.

### 3. Make `self-check` Report Readiness States

Extend `self-check` so it reports explicit machine-usable states like:

- `ready`
- `missing_config`
- `missing_kb`
- `missing_datasource`
- `missing_creds`
- `missing_connectors`

The current check list is useful for humans, but an agent needs a stronger summary contract.

### 4. Add An Agent-Facing Readiness Mode

Add a mode such as:

- `taproot --json self-check --agent`
- or `taproot --json doctor --agent-readiness`

This should answer:

- can I run queries now?
- what is missing?
- what exact next command should I run?

This would make the TapRoot skill much more reliable as the only context an agent receives.

### 5. Make KB Dependency More Explicit

Today, KB-backed resolution is powerful, but first-run success depends on KB existing in the expected memory-root path.

Improve this by:

- documenting KB as a first-class dependency in Quickstart
- exposing KB path in `self-check`
- reporting whether required KB files are present
- warning explicitly when the credential store is using the fallback master-secret path
- offering a fallback or import path if KB is absent

### 6. Ship Better Default Config

`environmentPolicies` and `serviceAliases` should stay configurable, but first-run users should not need to author config before basic use.

Recommended behavior:

- create a starter config automatically on first init
- keep neutral defaults when no env policy exists
- avoid requiring service alias configuration for normal flows

### 7. Add A Single “Can I Query?” Path

The simplest successful path for an agent should be one command:

```bash
taproot --json self-check --agent
```

or:

```bash
taproot --json init --check
```

That command should say whether the environment is ready, what is missing, and what exact command to run next.

## Recommended Definition Of “Agent-Ready”

TapRoot should be considered agent-ready with only the skill when a fresh agent can:

1. run one readiness command
2. get a deterministic answer about what is missing
3. run one guided setup path when needed
4. execute a read-only query without manually reading local files or guessing hidden config

TapRoot does not meet that bar yet.

## Recommended Near-Term Backlog

### Must Have

- `taproot init`
- stronger `self-check` readiness summary
- explicit KB presence checks
- guided datasource and connector setup
- agent-readable next-step output

### Nice To Have

- one-shot bootstrap from KB into datasource + connector refs
- install doc specifically for agent operators
- sample “first successful query” flow for skill consumers

## Final Recommendation

Treat TapRoot as:

- operationally usable for agents in preconfigured environments
- not yet zero-context or first-install agent-ready

The highest-leverage next step is not more command coverage. It is first-run orchestration:

- initialize
- detect readiness
- guide missing setup
- make the result machine-readable

That is the fastest path to making the TapRoot skill sufficient as the only context an agent needs.
