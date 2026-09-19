# mcp.tibia.sh

The hosted [TibiaWiki MCP server](https://github.com/tibia-sh/tibiawiki-mcp). It lets an AI assistant answer
questions about Tibia from a snapshot of [TibiaWiki](https://tibia.fandom.com): what drops an item, where to
buy it, which creatures are weak to fire.

## Use it

Add `https://mcp.tibia.sh/wiki` to your MCP client as a remote MCP server. It needs no account and no key.
[mcp.tibia.sh](https://mcp.tibia.sh) has the steps for claude.ai, Claude Code and other clients.

It serves the same five tools as a local install of
[`@tibia.sh/tibiawiki-mcp`](https://github.com/tibia-sh/tibiawiki-mcp), so you can also run it yourself.

## Limits

You get about 300 messages a minute per IP address. Past that, the answer is `429` with `Retry-After: 60`.
claude.ai users share Anthropic's addresses, so they share one allowance.

## Privacy

- Cloudflare processes every request. Your IP address is used for rate limiting.
- Cloudflare's analytics may keep sampled request details, such as your IP address, under Cloudflare's own
  policies.
- This service writes no request logs. It writes only startup, sleep and error lines, with no data from your
  requests, and keeps them for 7 days.

Cloudflare attaches the request URL to the Worker's log events, with your query string redacted.

## How it works

A Cloudflare Worker answers every request itself, apart from MCP requests to `/wiki`. Those go to one Cloudflare
Container, which runs [`@tibia.sh/tibiawiki-mcp`](https://github.com/tibia-sh/tibiawiki-mcp) with the index from
[`@tibia.sh/tibiawiki-data`](https://github.com/tibia-sh/tibiawiki-data), at the exact versions `package.json`
pins. The landing page shows them.

A release of either package reaches the endpoint by itself, within minutes. Its release workflow tells this
repository, a pull request pins the new version, and the merge deploys it.

The endpoint also answers CORS preflights, so MCP clients that run in a browser work, and it publishes an
[MCP Server Card](https://mcp.tibia.sh/wiki/server-card).

[docs/OPERATING.md](docs/OPERATING.md) has the rest: the rate limit in detail, the release path, deploys,
rollbacks and the two credentials.
