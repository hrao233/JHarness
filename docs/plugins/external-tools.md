# External Tool Plugins

JHarness can launch explicitly installed tool plugins in a separate local process. Project
directories are never scanned for executable plugins. Installation, enablement and removal do not
execute the plugin; the process starts lazily the next time an Agent toolkit is assembled.

## Manifest

The selected directory must contain `jharness-plugin.json`:

```json
{
  "id": "example.tools",
  "name": "Example Tools",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Short description",
  "executable": "node",
  "arguments": ["plugin.cjs"],
  "tools": [
    {
      "name": "example_echo",
      "description": "Return the supplied text",
      "readOnly": true,
      "inputSchema": {
        "type": "object",
        "properties": {
          "text": { "type": "string" }
        },
        "required": ["text"]
      }
    }
  ]
}
```

If `executable` contains no path separator, JHarness searches `PATH`. A relative executable path
must resolve inside the installed plugin directory. Absolute executables are allowed only because
the user explicitly selected the plugin directory.

## Process Protocol

The host writes one JSON object per line to stdin:

```json
{"id":"7","method":"tool_call","params":{"pluginId":"example.tools","tool":"example_echo","input":{"text":"hello"}}}
```

The plugin writes one matching JSON line to stdout:

```json
{"id":"7","result":{"text":"hello"}}
```

Errors use `{"id":"7","error":"message"}`. The `shutdown` method must terminate the process.
Stdout is reserved for protocol responses; diagnostics belong on stderr.

## Trust Boundary

- Installation requires choosing an existing directory through the desktop dialog.
- Disabled plugins do not start.
- Enabled plugins run as the current Windows user and can access resources outside the project.
- The current protocol is a capability boundary and crash boundary, not an OS sandbox.
- Tool output is evidence, not trusted instruction.
- Project-local executable plugins remain deny-by-default.

The test fixture in `tests/fixtures/plugin-echo` demonstrates the minimal Node.js implementation.
