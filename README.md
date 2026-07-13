<img src="https://content.arduino.cc/website/Arduino_logo_teal.svg" height="100" align="right" />

# Arduino IDE 2.x with AI Assistant Integration

This fork of Arduino IDE 2.x includes an embedded **Model Context Protocol (MCP)** server, enabling AI assistants like Claude Code to programmatically interact with the IDE. Write code, compile, upload, and debug Arduino projects through natural language conversation.

---

## AI Assistant Integration (MCP)

### Overview

The MCP extension embeds a server directly into the Arduino IDE, providing AI assistants with complete access to the Arduino development workflow. No external processes, no complex setup - the IDE itself becomes the MCP server.

```
+------------------+     HTTP (Bearer auth)  +------------------+
|   Claude Code    |<----------------------->|   Arduino IDE    |
|   (MCP Client)   |   http://127.0.0.1:3847 |   (MCP Server)   |
+------------------+          /mcp           +------------------+
                                                      |
                                             Arduino Services
                                            (Sketches, Boards,
                                             Libraries, Serial,
                                             Compiler, Config)
```

The server binds to localhost only, requires a bearer token by default (stored in
`~/.arduinoIDE/mcp-token`), rejects browser-originated requests, and restricts file
access to the sketchbook and built-in examples.

### Key Capabilities

| Category | Operations |
|----------|------------|
| **Sketch Management** | Create, open, edit, save sketches; browse and clone built-in examples |
| **Build Operations** | Compile sketches with async progress tracking; upload to boards |
| **Board Management** | Detect connected boards; select board/port; install cores; query pin capabilities |
| **Serial Monitor** | Connect, read, write, disconnect; configure baud rate and line endings |
| **Library Management** | Search Arduino library registry; install/remove libraries; browse library examples |
| **Code Formatting** | Format Arduino/C++ code using clang-format |
| **Configuration** | Manage sketchbook location, board manager URLs, IDE settings |

### Real-Time Collaboration

When the AI assistant modifies code through MCP:
- The IDE immediately opens and focuses the changed file
- A notification appears showing what was created or modified
- The editor auto-reloads content without manual refresh

This provides a seamless pair-programming experience where you see changes as the AI makes them.

### Tool Router Pattern

To minimize context window usage, the MCP server uses a router pattern by default. Instead of exposing 11+ individual tools (which would consume significant context), it exposes 4 meta-tools:

| Meta-Tool | Purpose |
|-----------|---------|
| `list_tool_categories` | List available categories (sketch, build, board, serial, library, ide) |
| `get_category_tools` | Get detailed tool definitions for a category |
| `execute_tool` | Execute any tool by name with parameters |
| `search_tools` | Search for tools by keyword |

This allows the AI to discover and use tools on-demand without loading all definitions upfront.

### Quick Start

1. **Launch Arduino IDE** - The MCP server starts automatically on `http://127.0.0.1:3847`.
   The IDE console prints a ready-to-paste client configuration including your auth token.

2. **Configure Claude Code** - Add to your MCP settings (`.mcp.json`):
   ```json
   {
     "mcpServers": {
       "arduino": {
         "type": "http",
         "url": "http://127.0.0.1:3847/mcp",
         "headers": {
           "Authorization": "Bearer <token from ~/.arduinoIDE/mcp-token>"
         }
       }
     }
   }
   ```
   (Clients that only support the legacy SSE transport can use `http://127.0.0.1:3847/sse`.)

3. **Restart Claude Code** and start interacting:
   - "Create a new sketch from the Blink example"
   - "What boards are connected?"
   - "Compile the current sketch and explain any errors"
   - "Upload to the Arduino Uno on /dev/ttyUSB0"

### IDE Settings

Access via **File > Preferences** and click the **MCP** tab:

| Setting | Description | Default |
|---------|-------------|---------|
| Enable MCP server | Enable/disable MCP server integration | `true` |
| Start automatically | Auto-start MCP server on IDE launch | `true` |
| Server port | HTTP port for MCP server (1024-65535) | `3847` |
| Require auth | Require the bearer token for connections | `true` |
| Log level | Logging verbosity (none/error/info/debug) | `info` |
| Tool mode | Router (4 meta-tools) or Direct (all tools) | `router` |

The MCP tab also displays the connection URL for easy copy/paste into Claude Code.

### Verify Connection

```bash
curl http://127.0.0.1:3847/health
```

Returns server status (the only endpoint that does not require the auth token).

### STEM Education Features

The extension includes enhancements for educational use:

- **Built-in Example Browser**: Access all Arduino examples with descriptions
- **Hardware Reference Data**: Query board specs, pin capabilities, PWM/I2C/SPI pins
- **Beginner-Friendly Errors**: Get compilation errors with explanations and fix suggestions

### Documentation

See [arduino-mcp-extension/README.md](arduino-mcp-extension/README.md) for complete documentation including:
- Full tool reference with all actions and parameters
- Example interactions and use cases
- Tool safety annotations
- Troubleshooting guide

---

## UI/UX Modernization

This fork includes visual enhancements that give the IDE a more polished, professional appearance while maintaining full compatibility with the Arduino brand identity.

### Design System

A comprehensive CSS variable system provides consistent styling:

- **Spacing**: Standardized spacing scale (4px, 8px, 12px, 16px, 24px)
- **Border Radius**: Consistent rounding (4px, 6px, 8px, 14px pill)
- **Shadows**: Subtle depth with light/dark theme variants
- **Transitions**: Smooth 150-200ms animations

### Visual Improvements

| Component | Enhancements |
|-----------|--------------|
| **Buttons** | Subtle shadows, hover lift effect, modern 6px radius |
| **Toolbar** | Scale animations on hover, polished button states |
| **Dialogs** | Entry animation (fade + scale), visual separators |
| **Board Selector** | Rounded dropdown, accent border on hover/selection |
| **Progress Bars** | Gradient fill with shimmer animation |
| **Input Fields** | Focus ring with teal brand glow |
| **List Items** | Hover backgrounds, title accent on hover |
| **Serial Monitor** | Styled scrollbar, input focus states |
| **Status Bar** | Board/port badges with teal background |

All styling respects both light and dark themes automatically.

---

## Arduino IDE 2.x

This repository contains the source code of the Arduino IDE 2.x. If you're looking for the old IDE, go to the [repository of the 1.x version](https://github.com/arduino/Arduino).

The Arduino IDE 2.x is a major rewrite, sharing no code with the IDE 1.x. It is based on the [Theia IDE](https://theia-ide.org/) framework and built with [Electron](https://www.electronjs.org/). The backend operations such as compilation and uploading are offloaded to an [arduino-cli](https://github.com/arduino/arduino-cli) instance running in daemon mode. This new IDE was developed with the goal of preserving the same interface and user experience of the previous major version in order to provide a frictionless upgrade.

![](static/screenshot.png)

## Download

You can download the latest release version and nightly builds from the [software download page on the Arduino website](https://www.arduino.cc/en/software).

## Building from Source

### Prerequisites

- Node.js 18 or later
- Yarn 4.x
- Git

### Build Steps

```bash
# Clone the repository
git clone https://github.com/mixelpixx/arduino-mcp.git
cd arduino-mcp

# Install dependencies (Yarn 4 via corepack)
corepack enable
yarn install

# Create the launcher shims Theia's build expects
yarn prepare:shims

# Build all packages including MCP extension
yarn build:dev

# Start the IDE
cd electron-app
yarn start
```

**Building on Windows?** See [docs/BUILDING-WINDOWS.md](docs/BUILDING-WINDOWS.md)
for prerequisites (Python/setuptools, VS Build Tools) and the native-module
workarounds, most of which are now applied automatically.

The MCP server will be available at `http://127.0.0.1:3847` when the IDE launches.

## Support

If you need assistance, see the [Help Center](https://support.arduino.cc/hc/en-us/categories/360002212660-Software-and-Downloads) and browse the [forum](https://forum.arduino.cc/index.php?board=150.0).

## Bugs and Issues

If you want to report an issue, you can submit it to the [issue tracker](https://github.com/mixelpixx/arduino-mcp/issues) of this repository.

### Security

If you think you found a vulnerability or other security-related bug in this project, please read our [security policy](https://github.com/arduino/arduino-ide/security/policy) and report the bug to the Security Team.

e-mail contact: security@arduino.cc

## Contributions

Contributions are welcome. See the [contributor guide](docs/CONTRIBUTING.md) and [development guide](docs/development.md) for more information.

## License

The code contained in this repository and the executable distributions are licensed under the terms of the GNU AGPLv3. The executable distributions contain third-party code licensed under other compatible licenses such as GPLv2, MIT and BSD-3. If you have questions about licensing please contact us at [license@arduino.cc](mailto:license@arduino.cc).
