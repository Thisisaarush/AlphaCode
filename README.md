# Alpha Code

An AI-powered code editor built with Electron, React, and Node.js.

## Features

- AI-powered code editing with Claude and other models
- Git integration with branch management and diff viewing
- Terminal with full PTY support
- Compare view with inline/split diff modes
- Auto-update support

## Installation

### macOS

1. Download the latest `.dmg` file from [Releases](https://github.com/Thisisaarush/AlphaCode/releases)
2. Open the `.dmg` file
3. Drag Alpha Code to Applications
4. Open Alpha Code from Applications

### Windows

1. Download the latest `.exe` installer from [Releases](https://github.com/Thisisaarush/AlphaCode/releases)
2. Run the installer
3. Follow the installation prompts

### Linux

1. Download the latest `.AppImage` from [Releases](https://github.com/Thisisaarush/AlphaCode/releases)
2. Make it executable: `chmod +x AlphaCode-*.AppImage`
3. Run: `./AlphaCode-*.AppImage`

## Development

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Build for production
pnpm build

# Create distributable
pnpm dist        # All platforms
pnpm dist:mac   # macOS only
pnpm dist:win   # Windows only
pnpm dist:linux # Linux only
```

## Keyboard Shortcuts

- `Cmd/Ctrl + S` - Save file
- `Cmd/Ctrl + P` - Quick file open
- `Cmd/Ctrl + Shift + P` - Command palette
- `Cmd/Ctrl + B` - Toggle sidebar
- `Cmd/Ctrl + `` - Toggle terminal

## License

MIT
