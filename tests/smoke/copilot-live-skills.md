# Deployed Copilot live skills gate

`npm run test:copilot-live-skills` runs one Chromium test with one worker and no retries. It submits exactly seven native turns through one actual deployed Copilot conversation. Each turn has the existing 150 second completion limit. The whole test has a 25 minute limit and retains the ordinary Copilot gate's maximum 30 minute Box generation age.

Run the command on the selected deployment host, beside its Podman engine and verified source checkouts. It works with the local Explorer Box and the public QA application. The Box URL is always the exact loopback Router publication on that same host. The application URL can be the local URL or `https://explorer-qa.axiologic.dev`.

```bash
SMOKE_BASE_URL=http://127.0.0.1:8088 \
SMOKE_BOX_BASE_URL=http://127.0.0.1:8088 \
SMOKE_PLOINKY_BOX_CONTAINER=the-exact-box-name \
SMOKE_WORKSPACE_ROOT=/absolute/path/to/deployed-workspace \
SMOKE_RELEASE_MANIFEST=/absolute/path/to/release-manifest.json \
SMOKE_COPILOT_RELEASE_VERIFIER=/absolute/path/to/ploinky/tests/release/verifyCopilot421Bundle.mjs \
npm run test:copilot-live-skills
```

Supply the provisioned `SMOKE_USERNAME` and `SMOKE_PASSWORD` through the environment. The gate does not install dependencies, restart containers, commit files or run `ploinky update`. The release manifest/verifier must identify the clean, exact deployed Ploinky, AchillesCLI, Explorer and shared AgentLib revisions. Existing verifier source-directory overrides apply when these repositories are managed checkouts. `SMOKE_WORKSPACE_ROOT` must equal the running Box's actual `/workspace` bind. `SMOKE_PLOINKY_BOX_CONTAINER` is the exact container name, matching the ordinary release evidence contract. A missing prerequisite fails the selected test, never records a pass or selects another Box.

For QA, run this same command on the QA host with the QA application URL and that host's loopback Box URL, workspace, release manifest and verifier. Public QA login and browser host checks remain supplied by the existing smoke helpers. This test has its own before/after release checks because selecting this spec does not invoke the ordinary folder-launch runner preflight.

| Native turn | Mutation before submission | Required evidence |
| --- | --- | --- |
| Original | Add a control and probe skill through Explorer after conversation creation | Both current descriptor values and helper outputs, two new receipts |
| Descriptor edit | Change only the probe descriptor value | Changed descriptor bytes/value with unchanged helper bytes/value |
| Helper edit | Change only the probe helper value | Changed helper bytes/output with unchanged descriptor bytes/value |
| Addition | Add a third skill through Explorer | Execute control and added skill; all three present in the captured catalog |
| Disable | Disable the original probe through Conversation skills UI | Fresh control receipt, probe absent from the captured execution catalog, no new probe receipt |
| Re-enable | Re-enable that probe through the same UI | Execute control and probe again |
| Delete | Delete the probe source directory through Explorer | Fresh control receipt, probe absent from the captured catalog, no new probe receipt |

Expected answers are random values written only in the skill source. Prompts contain skill names and a fresh public phase UUID. Each helper accepts that UUID, hashes its own bytes and writes its receipt with exclusive creation. The test never writes receipts. Native ALA maps the selected outer `/workspace/<run-folder>` to native `/workspace`, so helpers write `/workspace/.receipts` while the observer reads `/workspace/<run-folder>/.receipts`. The receipts include run/phase/skill identity, current helper value/hash, the actual executed helper path and creation time. The executed path must be the selected native `/workspace/.agents/skills/<name>/receipt.mjs` mount, so a copied helper cannot count. Previous receipts must remain unchanged.

Every phase checks a new persisted assistant message, a distinct completed turn ID and an inactive execution lease. It reads that turn's `skillExecution.catalogPath/.catalog.json` immediately, checks revision, policy/version, identities, names and fingerprints, and hashes the captured fixture descriptor/helper files. Every changed phase must have a different captured revision than the preceding turn. A fresh inventory alone cannot satisfy this proof. The inventory's last revision must match this completed execution and its active revision must be empty. The browser message ID must match the persisted assistant message.

The observer reads the selected robot's durable Copilot session and its ALA native session. The browser UUID, native session ID, backend `codex`, native continuation thread ID, home and selected workspace must stay identical across all seven turns. It also pins the outer Box ID/image/start, the actual RoboTeam registry identity/container/start/image/mounts, and hashes the deployed persistence/catalog/ALA/WebChat contract files against the verified AchillesCLI checkout. These checks detect a container replacement, restart, source update or namespace mismatch during the sequence.

The test reserves another real conversation through the browser's New action before the seven turns. Its policy and the robot defaults must remain unchanged. Only the selected conversation's probe toggle is mutated. Disabled/deleted skills are checked for exclusion from the next captured native catalog; this is a selection assertion, not a claim that old readable files have become inaccessible to the native process. WebChat does not expose native registration telemetry, so the proof combines the captured catalog, completed native continuation and helper-written receipts.

The artifact records sanitized identities, hashes, revisions and results. It omits native auth, environment values, raw session progress and model traces. Any browser error, failed turn, stale answer, missing receipt, identity change or cleanup failure fails the gate. Fixture source and receipts are removed from the run-owned Explorer folder after the native turn is idle; existing conversation history and runtime catalog retention follow the product's normal persistence policy. If cancellation cannot prove the failed native turn has stopped, cleanup fails and retains the uniquely named folder for diagnosis.

This composed gate supplements the existing six native live-skills phases and deployed Conversation skills settings coverage. It does not replace those tests or the ordinary Copilot folder-launch gate. Offline adversarial checks run with `node --test lib/copilot-live-skills.test.mjs`; those checks validate the evidence rules and do not claim deployed execution passed.
