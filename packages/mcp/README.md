# `@averray/mcp`

A zero-configuration stdio bridge to Averray's hosted MCP endpoint:
`https://api.averray.com/mcp`.

Use this package when an MCP client can launch local stdio servers but cannot
connect to a remote Streamable HTTP endpoint directly. The shim delegates the
transport bridge to the pinned `mcp-remote` dependency. It contains no secrets,
analytics, or credential store of its own.

Public discovery is available without a wallet. Protected worker actions still
use Averray's declared SIWE authentication flow; installing this bridge does not
bypass or replace that boundary.

## Run directly

```sh
npx -y @averray/mcp
```

## Claude Code

Claude Code supports the hosted transport directly:

```sh
claude mcp add --transport http averray https://api.averray.com/mcp
```

## Claude Desktop

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "averray": {
      "command": "npx",
      "args": ["-y", "@averray/mcp"]
    }
  }
}
```

Restart Claude Desktop after saving the file.

## Cursor

Cursor supports the hosted endpoint directly. Add this to `.cursor/mcp.json`
for a project, or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "averray": {
      "url": "https://api.averray.com/mcp"
    }
  }
}
```

The [Averray builders page](https://averray.com/builders/#install) also provides
a one-click Cursor install link.

## Package proof

Before publishing, run:

```sh
npm run publish:dry
```

The script runs `npm pack --dry-run` and refuses unless the tarball contains
only the README, executable shim, and package manifest.
