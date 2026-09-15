# mcp.tibia.sh

This repository deploys the TibiaWiki MCP server to `https://mcp.tibia.sh/wiki`. A Cloudflare Worker answers
every request itself, except MCP requests to `/wiki`, which it passes on to one Cloudflare Container. The
container runs [`@tibia.sh/tibiawiki-mcp`](https://github.com/tibia-sh/tibiawiki-mcp) with the index from
[`@tibia.sh/tibiawiki-data`](https://github.com/tibia-sh/tibiawiki-data), at the exact versions `package.json` pins.

To use it, add `https://mcp.tibia.sh/wiki` to your MCP client as a remote MCP server. It needs no authentication.
It serves the same five tools as a local install, over Streamable HTTP. The landing page at
`https://mcp.tibia.sh` shows the versions it runs.

## Rate limit

The Worker allows about 300 JSON-RPC messages per 60 s from each IPv4 address or IPv6 /64. Every message in a
batch counts. Past the limit, it answers `429` with `Retry-After: 60`.

The limit is approximate, because Cloudflare counts it per location and applies it permissively. claude.ai users
share Anthropic's egress IPs, so they share one allowance.

## Privacy

- Cloudflare processes every request. Your IP address is used for rate limiting.
- Cloudflare's analytics may keep sampled request details, such as your IP address, under Cloudflare's own
  policies.
- This service writes no request logs. It writes only startup, sleep and error lines, with no data from your
  requests, and keeps them for 7 days.

## How a release reaches the endpoint

1. A new `@tibia.sh/tibiawiki-mcp` or `@tibia.sh/tibiawiki-data` release reaches npm. Dependabot checks npm daily
   and opens one pull request that bumps the `@tibia.sh/*` pins. First-party packages skip its 7-day cooldown.
2. CI runs the required checks `unit`, `container` and `worker` on the pull request. No job reads a secret, so a
   Dependabot pull request runs every check. `container` builds the image and checks that it serves the pinned
   server version and index.
3. You merge the pull request once the checks pass. The push to `main` runs `deploy.yml`:
   - `ci` runs the same checks on the merged commit.
   - `deploy` runs `npm audit signatures`, then `wrangler deploy` with the token of the `cloudflare-production`
     environment. wrangler builds and pushes the image, and deploys the Worker with the merged commit as its
     `DEPLOY_COMMIT`.
   - `smoke` runs `scripts/served-artifact.ts` without the token. It passes once the landing page answers with the
     merged commit in `x-deploy-commit`, and `/wiki` serves the pinned server version and index. It starts no new
     attempt after 10 minutes.

Other dependencies take the same path after a 7-day cooldown: the other npm packages daily, and the base image
and the actions weekly.

## Compatibility rule

A Worker change and a server change must stay compatible for one release, in both directions. A rollout, a
rollback or a deploy that fails halfway puts the new Worker in front of the old container. In a rollback, the
Worker that goes live is the older one, and the container it meets is the newer one.

## Deploy

Merge a pull request into `main`, or run `deploy.yml` on `main` from the Actions tab or with
`gh workflow run deploy.yml --ref main`. The `cloudflare-production` environment deploys only from `main`, so a
run from another branch fails at its `deploy` job.

Runs of `deploy.yml` wait for each other, and a newer run never cancels one in progress. A run that queues does
cancel any run already waiting, even one for a newer commit of `main`. So when you dispatch or re-run a deploy
while another one runs, check afterwards which commit is live:

```bash
curl -sI -H 'Accept: text/html' https://mcp.tibia.sh/ | grep -i x-deploy-commit
```

If it is not the head of `main`, run `deploy.yml` on `main` again.

Before the first deploy, the Cloudflare account needs a workers.dev subdomain. Without one, `wrangler deploy`
fails with code 10063, "You need a workers.dev subdomain in order to proceed". The Worker does not serve on that
subdomain, because `wrangler.jsonc` sets `workers_dev` and `preview_urls` to `false`.

## Rollback

Revert the change in a pull request and merge it. The merge runs CI and deploys the Worker and the image
together, like any other merge.

`wrangler rollback` is not a recovery path. It only deploys an older Worker version and leaves the container image
in place, so a bad server or index keeps serving. It is a break-glass fix for a regression in the Worker alone,
which the maintainer runs with their own Cloudflare login. Merge the revert pull request after it anyway, or the
next deploy brings the regression back.

During a CI outage, the maintainer may disable the ruleset to merge the revert, then enable it again right after.
The merge's deploy still waits for `ci` to pass on the merged commit.

## Dependabot wrangler bumps

Each `wrangler` release pins its own `workerd`. When a bump changes that version, `worker` fails at
`wrangler types --check`, because the generated types name the `workerd` version they came from. On the
Dependabot branch:

1. Run `npm ci --ignore-scripts`, then `npm ls workerd` to read the new version.
2. Move `compatibility_date` in `wrangler.jsonc` to the newest date that version supports, which is the date in its
   version number: `2026-09-07` for `1.20260907.1`. A newer date can change how the Worker runs, and `worker` runs
   the Worker end to end with it.
3. Run `npx wrangler types` to regenerate `worker-configuration.d.ts`. It needs no Cloudflare account.
4. Run `npm run check:config`, which needs Docker, then push both files to the branch.

## Lockfile ages

`npm ci` installs the lockfile without applying the `min-release-age` in `.npmrc`, so `unit` runs
`npm run check:lockfile`. It fails on any lockfile entry outside `@tibia.sh/*` that is younger than 7 days, and on
any `@tibia.sh/*` entry without provenance from a `tibia-sh` repository.

A pull request that brings in a younger entry waits until the entry is 7 days old, and a Dependabot security update
waits too. Re-run `unit` then.

## The deploy token

`CLOUDFLARE_API_TOKEN` is a secret of the `cloudflare-production` environment, and only the `wrangler deploy`
step reads it. The account ID is the environment's `CLOUDFLARE_ACCOUNT_ID` variable.

The token holds these permissions:

| Scope | Permissions |
|---|---|
| Account | Workers Scripts Write, Workers Containers Write, Cloudchamber Write, Account Settings Read |
| Zone `tibia.sh` | Workers Routes Write, Zone Read |

It must never hold DNS Write, SSL and Certificates Write, or any other zone permission. With DNS Write, a holder
could rewrite the mail records of `tibia.sh`, or the TXT record that holds its MCP registry key. With SSL and
Certificates Write, they could change its certificates. If a deploy asks for one of these, the maintainer attaches
`mcp.tibia.sh` to the Worker by hand as a Custom Domain instead.

The first deploy settles this list, and this section changes if it shows otherwise.

The token has no expiry, so it lasts until it is rotated or revoked. To rotate it:

1. Create a new token with the same permissions.
2. Run `gh secret set CLOUDFLARE_API_TOKEN --env cloudflare-production --repo tibia-sh/mcp.tibia.sh`. It prompts
   for the token, so the token stays out of your shell history.
3. Run `deploy.yml` on `main`, as in [Deploy](#deploy), and wait for `smoke` to pass.
4. Revoke the old token.

## Decommissioning

1. Release `tibiawiki-mcp` without `remotes` in its `server.json`, so the MCP registry's latest version stops
   listing `https://mcp.tibia.sh/wiki` before the URL goes dead.
2. From a checkout of this repository, with your own Cloudflare login, delete the Worker with
   `npx wrangler delete`. That also removes its custom domain and its Durable Object namespace, but not the
   container application.
3. Delete the container application with `npx wrangler containers delete <ID>`, taking the ID from
   `npx wrangler containers list`.
4. Delete each image tag with `npx wrangler containers images delete <IMAGE>:<TAG>`, taking them from
   `npx wrangler containers images list`.
5. Revoke the deploy token, so a later merge cannot deploy the service again.
