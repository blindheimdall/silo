<p align="center">
  <img src="docs/product/silo-mark.png" width="104" alt="SILO spiral shaft and radio signal">
</p>

<h1 align="center">SILO</h1>

<p align="center">
  <a href="https://github.com/sponsors/blindheimdall">Sponsor SILO on GitHub</a>
</p>

<p align="center"><strong>Independent silos. A shared chain of work.</strong></p>
<p align="center">Run AI agents on separate machines, delegate access across instances, and inspect each handoff in a 144-level operations room.</p>

<p align="center">
  <a href="#link-independent-silos">Silo-to-Silo Radio</a> &middot;
  <a href="#what-silo-does">Capabilities</a> &middot;
  <a href="#integrations">Integrations</a> &middot;
  <a href="#quick-start">Quick start</a> &middot;
  <a href="docs/handbook.md">Handbook</a>
</p>

SILO is a self-hosted workspace for AI agents. Inside one instance, residents use different models and tools to run workflows together. Across instances, **Silo-to-Silo Radio** lets a resident ask a remote resident for help under a capability that the data owner can scope and revoke.

Open [`docs/product/index.html`](docs/product/index.html) from a checkout to step through the Radio exchange, try revoking a grant, approve or reject a simulated GitHub or Google Sheets action, and search the integration directory.

## Link independent silos

**Example.** Operations owns the reports. It grants Analytics read access to `reports/` for two hours. Analytics delegates only `reports/uptime/` to Support for thirty minutes. A Support resident can now ask an Operations resident to summarize the weekly uptime report. Operations checks the capability chain and controls which files its resident can read.

| What Radio does | How it works |
| :--- | :--- |
| **Identify each peer** | Each silo has an Ed25519 key pair. Owners compare public-key fingerprints when linking peers. Requests and replies are signed. |
| **Grant access to a specific task** | Limit the residents, tools, folder paths, lifetime, token budget and message budget. Without a capability, a remote resident answers without tools. |
| **Delegate with tighter limits** | A holder can pass on a subset of its access to another silo. Each link is signed and can only narrow what came before. |
| **Keep enforcement with the data owner** | The data-owning silo verifies the chain, counts usage and checks revocation. Revoking a link also stops access granted through it. |

[Set up Radio and capability grants](docs/handbook.md#silo-to-silo-radio)


![Concept art of SILO's underground galleries and central stair](docs/product/silo-hero.webp)

## What SILO does

| Capability | What you can do |
| :--- | :--- |
| **Residents** | Configure agents with a role, instructions, model, home level and tool permissions. Try demo residents without an API key. |
| **Workflows** | Combine residents, reviews, app actions, waits and approvals. Run steps in parallel, branch on prior results or repeat for every item in a list. |
| **Triggers** | Run on a schedule, a file change, an incoming email, a feed update, an app event or a webhook. |
| **Approvals and traces** | Pause a workflow for a human decision. Inspect model calls, tool use, timings, tokens and estimated costs. Replay from a selected step. |
| **Evaluation and versions** | Test residents and workflows against reference cases, compare changes and restore earlier workflow versions. |
| **Spatial interface** | Navigate 144 levels, locate a resident or follow workflow activity from the live camera room. |

**Example workflow.** A new GitHub issue starts a run. A resident reads the issue and drafts a response. The workflow pauses for your approval and posts the approved comment through the GitHub connector.

| Workflow terminal | Camera room |
| :--- | :--- |
| ![Workflow terminal showing resident and review steps](docs/media/silo-flows.webp) | ![Camera room with a main feed and smaller monitors](docs/media/silo-cameras.webp) |

<details>
<summary>Watch the 3D navigation GIF</summary>

![The camera turns around the central stair and moves between levels](docs/media/silo-tour.gif)

</details>

## Integrations

SILO includes **88 app connectors**, **350 app connector operations**, **37 webhook adapters**, and **5 connected account providers**. The [interactive product page](docs/product/index.html) includes a searchable directory with operations and setup notes.

| Integration | Examples and supported actions |
| :--- | :--- |
| **Google** | Search Gmail, read Drive files, read or append Sheets rows, and create Calendar events. |
| **Microsoft 365** | Search Outlook, read OneDrive files and manage supported Calendar actions. |
| **Slack** | Read channels and post messages with a configured account. |
| **GitHub** | Read files, issues and pull requests. Create, comment on or close issues. |
| **Notion** | Search and read pages, append text, and create pages in a connected database. |
| **App connectors** | Configure supported operations for Stripe, Shopify, Linear, Jira, Airtable, Sentry, Cloudflare and other services. |
| **Incoming events** | Trigger workflows from configured webhooks for services such as GitHub, Slack, Stripe, Shopify, Sentry and Typeform. |
| **Phone and notifications** | Pair a Telegram bot to talk to residents, start workflows or respond to approvals. Send notifications to Slack, Discord, email or a webhook. |
| **Model providers** | Choose OpenAI, Anthropic, local Ollama or an OpenAI-compatible endpoint per resident. |
| **Custom tools** | Add local or remote MCP servers, import OpenAPI 3 or Swagger 2 descriptions, or create a Python tool. |

Each integration requires the appropriate credentials, permissions and service setup. When you connect an external model or service, relevant inputs are sent to it.

## Quick start

1. Install **Node.js 22 or newer** and open a terminal in the repository root.
2. Run:

   ```sh
   npm start
   ```

3. Open [127.0.0.1:3000](http://127.0.0.1:3000). Select **Residents** to try a demo conversation, **Flows** to explore the included workflows, or **IT / Uplink** to connect a provider.

On Windows, use `Start-Silo.cmd` to launch or `Install-SILO.cmd` for a per-user installation. Three.js is bundled. Browsers without WebGL 2 can use the 2D view.

## Developer resources

- [Handbook and operational setup](docs/handbook.md)
- [HTTP API](docs/handbook.md#api-for-programs) and [Python SDK](sdk/python/README.md)
- [MCP and A2A interfaces](docs/handbook.md#silo-for-outside-programs)
- [Data storage](docs/handbook.md#data-and-limits), [account roles and network access](docs/handbook.md#people-and-network-access), and [OpenTelemetry](docs/handbook.md#opentelemetry)

```sh
npm ci
npm run check
npm test
```

## License

SILO's own code is licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). Bundled Three.js retains its [MIT license](public/vendor/THREE-LICENSE.txt).
