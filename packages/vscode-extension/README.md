# React Native AI Agent

An AI coding assistant and runtime inspector for Visual Studio Code. It adds an AI Agent view, plus RN Console, Network, Errors, and Performance views in the Panel.

## Install

Install the `react-native-ai-agent-0.1.0.vsix` package using **Extensions: Install from VSIX...** in VS Code. Open a React Native project folder, open the RN Agent view, and use **RN Agent: Set API Key**. The key is stored in VS Code SecretStorage. The provider base URL and model are configured with `rnAgent.provider.baseUrl` and `rnAgent.provider.model`.

Use the AI Agent view menu to move the chat to VS Code's Secondary Side Bar on the right. The React Native debugging views appear in the bottom Panel.

## Runtime data

The extension cannot capture app traffic until the React Native app opts into the bridge. Run **RN Agent: Show Runtime Bridge Setup** to see the session URL and token. Package the bridge from the source repository with `npm run bridge:pack`, install the resulting tarball in the app, then initialize it near app startup:

```ts
import { connectReactNativeAgent } from "@rn-agent/runtime-bridge";

const agentBridge = connectReactNativeAgent({
  url: "ws://127.0.0.1:43127/rn-agent?token=PASTE_TOKEN",
  appName: "My React Native App"
});
```

The bridge captures console output, JavaScript errors, fetch/XHR requests, and metrics reported through `reportPerformanceMetric`. Android Emulator uses `10.0.2.2` in place of `127.0.0.1`. Physical-device connections need a trusted local network, `rnAgent.bridge.host: 0.0.0.0`, the Mac's LAN IP in the URL, and the session token. Disable the bridge or remove its initialization from production builds.

## Code edits

The agent can search and read project files, build an architecture index, remember project notes, and suggest refactoring. File changes are staged as proposals; they are applied only when you choose **Apply edit** in the chat.

Android SDK, Xcode, simulators, and device testing are not needed to build or package the extension.
