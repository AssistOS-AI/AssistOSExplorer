# DPU Agent

`dpuAgent` is the confidential and research-data service used by Explorer for `/Confidential` and secret storage. It owns unified research-resource records, bounded file consumption, confirmation-bound actions, compute backends, jobs, source adapters and append-only provenance. It uses a clean-break `dpu-research-v1` root and does not migrate or read legacy state.

The agent owns three things that Explorer should not implement locally:

- actor-aware access control
- encrypted storage for secret values and confidential file content
- stable virtual roots such as `/Confidential/My Space`, `/Confidential/Shared`, `/Confidential/Secrets`, and admin-only `/Confidential/Audit`
- research projections at `/Confidential/Research Data` and `/Confidential/Jobs`

Materialized research files remain in private DPU storage. Authorized users and agents consume them through `dpu_resource_file_list`, `dpu_resource_file_stat`, and bounded `dpu_resource_file_read` calls; physical storage paths are never returned.

## Runtime

`dpuAgent` runs as a Ploinky MCP-first agent through the bundled Ploinky `AgentServer.mjs`. Under Ploinky, `DPU_MASTER_KEY` is a per-agent generated secret provided through `{{generatedSecret:DPU_MASTER_KEY}}`, `DPU_DATA_ROOT` is required and resolves to the managed `/root` mount backed by `.data/dpu-data`, and the router is the only public entry point for DPU MCP calls. The runtime fails closed instead of deriving a storage fallback.

Required or relevant environment variables:

- `DPU_MASTER_KEY`
- `DPU_DATA_ROOT`
- `DPU_WORKSPACE_ROOT`
- `ASSISTOS_FS_ROOT`
- `WORKSPACE_ROOT`
- `DPU_NVFLARE_PYTHON` (optional path to the Python interpreter that contains NVFlare 2.8.1)

## NVFlare integration

Install the pinned Python dependency into an operator-controlled environment:

```bash
python3 -m pip install -r requirements-nvflare.txt
```

Set `DPU_NVFLARE_PYTHON` when that environment does not use the default `python3`. Store the NVFlare configuration as a DPU secret containing JSON with `username`, `startupKitPath`, `templatesRoot`, and optional `study`. The compute-backend record references that secret and maps administrator-defined template IDs to job folders below `templatesRoot`. A backend must pass its identity test before it can be enabled.

## Documentation

- [DPU specification matrix](./docs/specs/matrix.md)
- [DPU documentation](./docs/index.html)

Workspace data is mounted separately at `/workspace-data`. Explorer's read-only `/.data` tree uses the `dpu_data_*` tools: administrators see all permitted files, other users see only `agents/explorer`, and nobody can read the master key through these tools. Every operation is audited.
