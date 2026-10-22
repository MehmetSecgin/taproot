# TapRoot Agent Readiness

## Goal

Document how usable TapRoot currently is for agents that have only the TapRoot skill, what local/runtime setup is still required, and what we should change to make first-use agent workflows reliable.

## Short Answer

TapRoot is not yet fully usable by an agent with only the skill and no local context.

The skill is strong enough to teach command choice and workflow, but a fresh machine still needs local runtime state, config, KB data, datasource or KB-backed resolution, credentials, and often connector command setup before real queries can succeed.

TapRoot is much closer to agent-ready in an already prepared environment than it is on first install.

## What An Agent Can Already Do With Only The Skill

If the machine is already prepared, an agent can usually:

- choose the right command family (`doctor`, `query`, `datasource resolve`, `kb`, `cache`, `template`, `connector`, `self-check`)
- follow a safe read-only workflow
- use env/service resolution and datasource resolution correctly
- understand deterministic vs discovery-based resolution
- inspect runtime health with `self-check`
- preflight connector/auth state with `doctor`
- use saved templates and cache entries through TapRoot commands instead of reading files directly

This means the skill is already useful as an operating manual for an agent once TapRoot has been installed and configured.

## What Prevents Skill-Only Success On A Fresh Install

An agent with only the skill still depends on several local prerequisites:

- TapRoot must be installed or built and runnable.
- Runtime state must exist under `~/.taproot/` or `TAPROOT_STATE_ROOT`.
- Runtime config may be needed at `~/.taproot/config/deterministic-config.json`.
- `TAPROOT_MASTER_KEY` should be set so credential storage does not fall back to a machine-derived secret.
- KB files are expected at the configured KB directory (`--kb-dir`, `TAPROOT_KB_DIR`, the `kbDir` saved by `taproot init --kb-dir`, or default `<state-root>/kb`).
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
2. Save the KB directory with `taproot init --kb-dir <dir>`, or place KB files at the default `<state-root>/kb`.
3. Optionally create runtime config at `~/.taproot/config/deterministic-config.json`.
4. Store credentials with `taproot creds set`.
5. Either:
   - add a datasource manually with `taproot datasource add`, or
   - rely on KB-backed auto-bootstrap via `taproot query --env --service`.
6. If connectors are required, configure them through credential refs or `taproot connector setup`.

### What Is Already Nice

- State directories are created automatically.
- `taproot init` creates starter config and reports the current readiness snapshot.
- `self-check --agent` supports target-aware readiness for `--datasource` and `--env` + `--service`.
- `query --env --service` can auto-bootstrap datasources from KB.
- `init datasource` can now repair critically stale datasource profiles instead of forcing delete-and-recreate.
- Runtime config has safe neutral defaults when an env policy is missing.
- `self-check` gives a lightweight runtime sanity check.
- `doctor` provides ranked next steps for connector and executor failures, and `doctor` now exposes structured `nextActionDetails`.

### What Still Feels Heavy

- `taproot init` improves first-run setup, but connector/auth wiring is still the heavier part of getting a machine query-ready.
- `self-check --agent` now reports readiness states, but the most useful checks are target-aware runs against a specific datasource or env/service.
- KB availability is assumed rather than guided.
- Credential and connector setup is still fairly manual.
- The agent still needs targeted connector/auth checks to know whether a specific datasource is actually query-ready.

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

The gap is no longer basic command surface coverage. The remaining gap is first-run orchestration plus connector/auth readiness for the specific datasource an agent wants to use.

## Recommendations

### 1. Keep `taproot init` As The First Entry Point

`taproot init` now covers the basic first-run bootstrap:

- creates required local state
- writes a starter `deterministic-config.json` when missing
- checks KB directory visibility
- warns when `TAPROOT_MASTER_KEY` is unset
- reports what is still missing

This should remain the default entrypoint for first install.

### 2. Keep Improving Guided Datasource Setup

`taproot init datasource` now handles KB-backed datasource creation and explicit repair of critically stale datasource profiles.

The remaining improvement area is guided setup when KB is incomplete:

- prompt for missing topology
- create or link credential refs
- wire connector refs

### 3. Extend Targeted Readiness Further

`self-check --agent` already reports explicit machine-usable states. The current useful set is:

- `ready`
- `missing_config`
- `missing_kb`
- `missing_datasource`
- `missing_creds`
- `missing_connector_config`
- `blocked_connector_auth`

It also supports target-aware runs with `--datasource` or `--env` + `--service`, which is the preferred contract for agents checking a real query path.

The main remaining gap is no longer action structure. `init`, `self-check --agent`, and `doctor` now all expose structured remediation metadata. The remaining gap is making that contract fully consistent across every setup/readiness path.

### 4. Add An Agent-Facing Readiness Mode

The current agent-facing readiness mode is:

- `taproot self-check --agent`

For target-aware readiness, use:

- `taproot self-check --agent --datasource <name>`
- `taproot self-check --agent --env <env> --service <service>`

This should answer:

- can I run queries now?
- what is missing?
- what exact next command should I run?

The next improvement is to keep the remediation contract aligned across every agent-facing path and reduce the remaining differences between top-level readiness and target-aware diagnosis.

### 5. Make KB Dependency More Explicit

Today, KB-backed resolution is powerful, but first-run success depends on KB existing at the configured KB directory.

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
taproot self-check --agent
```

or:

```bash
taproot init --check
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
- keep the result fully machine-readable and consistent across `init`, `self-check --agent`, and `doctor`

That is the fastest path to making the TapRoot skill sufficient as the only context an agent needs.
