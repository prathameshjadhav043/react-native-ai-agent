# React Native AI Agent for VS Code

A TypeScript monorepo for an AI coding assistant and React Native runtime inspector. The extension contributes a chat view that can be moved to VS Code's Secondary Side Bar and four React Native debugging views in the bottom Panel.

Source repository: [prathameshjadhav043/react-native-ai-agent](https://github.com/prathameshjadhav043/react-native-ai-agent)

After installation, open the RN Agent Activity Bar view and use its view menu to move **AI Agent** to the Secondary Side Bar on the right. The **React Native** views container appears in the bottom Panel with RN Console, Network, Errors, and Performance views.

## Features

- OpenAI-compatible chat completions with function/tool calling. The provider URL and model are configurable; the API key is kept in VS Code SecretStorage.
- Workspace search, file reading, architecture indexing, reusable-code search, persistent notes, and refactoring hints.
- Code edits are staged as proposals. The developer reviews and explicitly applies or rejects each edit.
- Runtime bridge package captures console output, JavaScript errors, fetch/XHR requests, and manually reported performance metrics.
- TypeScript checks, Vitest unit tests, GitHub Actions CI, and VSIX packaging.

The runtime bridge is opt-in: install the extension and add the bridge package to the React Native application to send runtime data. Android/iOS builds and device testing are not required to build this repository.

## Requirements

- Node.js 20 or newer and npm 10 or newer
- Visual Studio Code 1.95 or newer
- An API key for the OpenAI-compatible provider you configure

Android SDK, Xcode, simulators, and physical devices are not required for development or packaging.

## Build and check

```sh
npm install
npm run check
npm run package
npm run bridge:pack
```

The VSIX is written to `outputs/react-native-ai-agent-0.1.0.vsix`. Install it in VS Code with **Extensions: Install from VSIX...**, or run:

```sh
code --install-extension outputs/react-native-ai-agent-0.1.0.vsix
```

`npm run bridge:pack` also creates `outputs/rn-agent-runtime-bridge-0.1.0.tgz`. Copy that archive to the React Native project and install it with `npm install /path/to/rn-agent-runtime-bridge-0.1.0.tgz` before adding the initialization snippet below.

## Configure the AI provider

1. Open the **RN Agent** Activity Bar view.
2. Use the key button or the **RN Agent: Set API Key** command. The key is saved to VS Code SecretStorage.
3. Set `rnAgent.provider.baseUrl` and `rnAgent.provider.model` in VS Code settings. The default endpoint is OpenAI's Chat Completions endpoint.

Compatible endpoints must support the OpenAI Chat Completions `tools` format. No API key is bundled in the VSIX.

## Connect a React Native app

1. In VS Code run **RN Agent: Show Runtime Bridge Setup** and copy the displayed URL and token.
2. Add the runtime package from this repository to the React Native app, then initialize it once near application startup:

```ts
import { connectReactNativeAgent } from "@rn-agent/runtime-bridge";

const agentBridge = connectReactNativeAgent({
  url: "ws://127.0.0.1:43127/rn-agent?token=PASTE_TOKEN",
  appName: "My React Native App"
});

// Optional: report app-specific timings or counters.
agentBridge.reportPerformanceMetric("screen.startup", 245, "ms");
```

For Android Emulator, use `10.0.2.2` instead of `127.0.0.1`; for iOS Simulator, `127.0.0.1` generally reaches the host. For a physical device, configure `rnAgent.bridge.host` to `0.0.0.0`, use the Mac's LAN address in the app URL, and keep the generated token private. Restart VS Code after changing the bind host. The bridge is intended for development builds; remove or disable it in production builds.

Captured network headers and JSON payloads redact common credential fields, and payloads are size-limited. Captured data remains local to the extension host.

## Layout

```text
packages/
  shared/           Shared runtime event contracts
  agent-core/       Provider, tools, architecture index, and memory contracts
  runtime-bridge/   React Native fetch/XHR/console/error instrumentation
  vscode-extension/ VS Code chat, debug views, local bridge server, packaging
```

## Development notes

- `npm run check` runs type checking, unit tests, and extension bundling.
- `npm run package` creates a VSIX; it does not publish or push anything.
- Runtime network data requires explicit app instrumentation. The extension cannot capture an uninstrumented React Native app's requests.
- Native crash traces and native performance counters are not collected by this first version; the bridge handles JavaScript-side events and app-reported metrics.
