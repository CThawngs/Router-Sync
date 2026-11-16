# RouterSync MCP Server

RouterSync exposes a read-only MCP server with **24 tools, zero write tools**.
Every tool reads a real source (router adapter, daemon state file, documentation
tree, or runtime Zod schema) and reports absence instead of inventing values.

## Client configuration

### Claude Code

```json
{
  "mcpServers": {
    "routersync": {
      "command": "node",
      "args": ["/absolute/path/to/routersync/packages/mcp-server/dist/index.js"],
      "env": { "ROUTERSYNC_STATE_DIR": "/absolute/path/to/state" }
    }
  }
}
```
Apply: `claude mcp add --transport stdio routersync node "<entrypoint>"`

### OpenCode

```json
{
  "mcp": {
    "routersync": { "type": "local", "command": ["node", "/absolute/path/to/routersync/packages/mcp-server/dist/index.js"] }
  }
}
```

### Cursor / generic MCP client

```json
{
  "mcpServers": {
    "routersync": {
      "command": "node",
      "args": ["/absolute/path/to/routersync/packages/mcp-server/dist/index.js"],
      "env": { "ROUTERSYNC_STATE_DIR": "/absolute/path/to/state" }
    }
  }
}
```

## Read-only tools (24)

| Tool | Description |
|---|---|
| detect_routers | Scans the local system for active LLM routers (OmniRoute, 9Router) |
| get_config | Reads the resolved config.yaml (or routersync.yaml) configuration |
| validate_config | Validates the configuration against the Zod schema |
| list_models | Lists models from router catalogs |
| list_combos | Lists combo definitions from routers |
| status | Shows router health and read-back level |
| plan | Computes the sync plan and prints the diff |
| sync_plan | Returns the pending sync plan |
| diff | Shows the diff between current and desired combos |
| health | Aggregates catalog, invariant, tick, and verification health |
| discover | Detects routers and AI apps |
| scan_completeness | Reports model-list scan completeness |
| research_queue | Lists pending research requests |
| research_evidence | Shows recorded research evidence |
| schedule_status | Shows the tick schedule status |
| autopilot_status | Shows autopilot plan status |
| search_docs | Searches the RouterSync documentation tree |
| inbox_list | Lists notification inbox items |
| verify_requests | Lists models awaiting verification |
| get_item | Reads a single state item by id |
| list_traits | Lists model traits |
| list_strategies | Lists combo strategies |
| get_schema | Returns the runtime Zod schema |
| profile_interview | Returns profile interview questions |

All tools are read-only. No tool writes to a router, a config file, or a
database.
