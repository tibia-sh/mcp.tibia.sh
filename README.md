# mcp.tibia.sh

This repository deploys the TibiaWiki MCP server to `https://mcp.tibia.sh/wiki`. A Cloudflare Worker answers
every request itself. The one exception is MCP requests to `/wiki`, which it passes on to one Cloudflare
Container. The container runs [`@tibia.sh/tibiawiki-mcp`](https://github.com/tibia-sh/tibiawiki-mcp) with the index from
[`@tibia.sh/tibiawiki-data`](https://github.com/tibia-sh/tibiawiki-data), at the exact versions `package.json` pins.

To use it, add `https://mcp.tibia.sh/wiki` to your MCP client as a remote MCP server. It needs no authentication.
It serves the same five tools as a local install, over Streamable HTTP. The landing page at
`https://mcp.tibia.sh` shows the versions it runs.

## Rate limit

The Worker allows about 300 JSON-RPC messages per 60 s from each IPv4 address or IPv6 /64. Every message in a
batch counts. Past the limit, it answers `429` with `Retry-After: 60`.

The limit is approximate. Cloudflare counts it per location and applies it permissively. claude.ai users share
Anthropic's egress IPs, so they share one allowance.

## Browser clients

The endpoint answers CORS preflights and allows any origin, so an MCP client that runs in a browser needs no
configuration from you. Every answer of `/wiki` but the landing page carries the CORS headers, and a browser
client can read `Retry-After` on a `429`. A web page can make its visitors' browsers call the endpoint and spend
each visitor's own per-IP allowance, which costs those visitors a `429` for up to a minute and reaches no state or
non-public data.

## Privacy

- Cloudflare processes every request. Your IP address is used for rate limiting.
- Cloudflare's analytics may keep sampled request details, such as your IP address, under Cloudflare's own
  policies.
- This service writes no request logs. It writes only startup, sleep and error lines, with no data from your
  requests, and keeps them for 7 days.

Cloudflare attaches the request URL to the Worker's log events, with your query string redacted.

## How a release reaches the endpoint

1. The release workflow of [`tibiawiki-mcp`](https://github.com/tibia-sh/tibiawiki-mcp) or
   [`tibiawiki-data`](https://github.com/tibia-sh/tibiawiki-data) publishes to npm. Its `hosting` job then sends this
   repository a `repository_dispatch` of type `first-party-release` naming the package and the version, with the
   token of its `release-trigger` environment.
2. The dispatch starts `bump.yml`. Its `bump` job runs in the `release-trigger` environment on the tip of `main`.
   Runs queue one after the other, so a second release pins on the `main` the first one merged.
   - `node scripts/bump.ts pin` runs without the token. It refuses any package but the two above, any version that
     is not an exact `1.2.3`, and any version below the pin. The pinned version ends it with `bump: already-pinned`.
     Otherwise it waits up to 10 minutes for npm to serve the version with a provenance attestation, runs
     `pnpm add --save-exact`, then `scripts/check-lockfile.ts` on the result.
   - `node scripts/bump.ts publish` is the one step with the token. Unchanged files end it with
     `bump: nothing-to-publish`, and the run is green. Otherwise it pushes the branch `bump/<name>-<version>` and
     opens the pull request `chore(deps): bump <package> to <version>`, or reuses the open one. Then it turns
     auto-merge on, which merges at once when the checks have already passed, and waits up to 30 minutes for the
     merge.
3. CI runs the required checks `unit`, `container` and `worker` on the pull request. No job reads a secret, so
   every pull request runs every check. `container` builds the image and checks that it serves the pinned server
   version and index.
4. Auto-merge rebases the pull request onto `main` once the checks pass. The ruleset has no bypass actors, so
   nothing merges before they do. The `bump` run ends green with `bump: merged`, and GitHub deletes the branch.
5. The push to `main` runs `deploy.yml`:
   - `ci` runs the same checks on the merged commit.
   - `deploy` runs `pnpm audit signatures`, then `pnpm exec wrangler deploy` with the token of the
     `cloudflare-production` environment. wrangler builds and pushes the image, and deploys the Worker with the
     merged commit as its `DEPLOY_COMMIT`.
   - `smoke` runs `scripts/served-artifact.ts` without the token. It passes once the landing page answers with the
     merged commit in `x-deploy-commit`, and `/wiki` serves the pinned server version and index. It starts no new
     attempt after 10 minutes.

You can start the chain at step 2 by hand, from a checkout of this repository. gh runs it on `main`, and the
`release-trigger` environment deploys only from `main`, so a run from another branch fails at its `bump` job:

```bash
gh workflow run bump.yml -f package=@tibia.sh/tibiawiki-mcp -f version=1.2.3
```

What can go wrong, and what to do:

| What you see | What to do |
|---|---|
| Red CI on the bump pull request | The `bump` run turns red after 30 minutes, when its wait for the merge runs out, so act on the red checks without waiting for it. Push the fix to the bump branch, and auto-merge merges it once the checks pass. Or close the pull request, fix the cause on `main`, and run `bump.yml` by hand. |
| A bump pull request closed, or open past 30 minutes | The `bump` run is red. Fix the cause, then run `bump.yml` by hand. It reuses an open pull request and turns auto-merge on again, or opens a new one. A pull request that merges on its own after the run turned red needs nothing more: a run by hand then finds the version pinned, and its `pin` step ends with `bump: already-pinned`. |
| A red `bump` run before any pull request exists | Read the last line of the failed step. In `pin`, npm did not serve the version with its provenance within 10 minutes, or the lockfile check refused the version: its provenance does not verify, or the lockfile holds a second copy of a first-party package at a version `package.json` does not pin. Wait, or fix the cause, then run `bump.yml` by hand. In `publish`, gh failed before it opened the pull request, and the line quotes what gh said. `Bad credentials` means the token was revoked, and [The release trigger token](#the-release-trigger-token) describes how to rotate it. |
| A version still under a cooldown | The first-party packages skip the 7-day cooldown, and only their dependencies wait for it. The `pin` step fails at `pnpm add` when no version of some dependency is both in the range the release asks for and 7 days old, so the run is red before a pull request exists. Wait until one is, then run `bump.yml` by hand. |
| A red `hosting` job in a release run | npm and the MCP registry are unaffected. The dispatch may still have arrived, so look for a `bump` run for that version in this repository's Actions tab, and run `bump.yml` by hand if there is none. A second run is harmless. It finds the version pinned, or the pull request open. |

Nothing bumps the other dependencies for you. You bump `wrangler` and the other npm packages, the base image digest
and the actions by hand in a pull request.

## Compatibility rule

A Worker change and a server change must stay compatible for one release, in both directions. A rollout, a
rollback or a deploy that fails halfway puts the new Worker in front of the old container. In a rollback, the
Worker that goes live is the older one, and the container it meets is the newer one.

## Deploy

Merge a pull request into `main`, or run `deploy.yml` on `main` from the Actions tab or with
`gh workflow run deploy.yml --ref main`. The `cloudflare-production` environment deploys only from `main`, so a
run from another branch fails at its `deploy` job.

Runs of `deploy.yml` wait for each other, and a newer run never cancels one in progress. A run that queues does
cancel any run already waiting, even one for a newer commit of `main`. If you dispatch or re-run a deploy while
another one runs, check which commit is live afterwards:

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
in place, so a bad server or index keeps serving. It is a break-glass fix for a regression in the Worker alone.
The maintainer runs it with their own Cloudflare login. Merge the revert pull request after it anyway, or the
next deploy brings the regression back.

During a CI outage, the maintainer may disable the ruleset to merge the revert, then enable it again right after.
The merge's deploy still waits for `ci` to pass on the merged commit.

## Wrangler bumps

Each `wrangler` release pins its own `workerd`. When a bump changes that version, `worker` fails at
`wrangler types --check`, because the generated types name the `workerd` version they came from. On your branch:

1. Run `pnpm install --frozen-lockfile`.
2. Run `pnpm why workerd` to read the new version.
3. Move `compatibility_date` in `wrangler.jsonc` to the newest date that version supports, which is the date in its
   version number: `2026-09-07` for `1.20260907.1`. A newer date can change how the Worker runs, and `worker` runs
   the Worker end to end with it.
4. Run `pnpm exec wrangler types` to regenerate `worker-configuration.d.ts`. It needs no Cloudflare account.
5. Run `pnpm run check:config`. It needs Docker.
6. Push both files to the branch.

## Lockfile ages

pnpm applied the 7-day release age in `pnpm-workspace.yaml` when it wrote the lockfile. `unit` runs
`pnpm run check:lockfile` on every run. It fails on any lockfile entry outside `@tibia.sh/*` that is younger than
7 days, and on any `@tibia.sh/*` entry without a provenance bundle that `gh attestation verify` accepts for the
package's release workflow on `main`.

A pull request that brings in a younger entry fails its checks until the entry is 7 days old: the `pnpm/setup`
install fails in `unit`, `container` and `worker` alike. Re-run the failed checks then.

## The deploy token

`CLOUDFLARE_API_TOKEN` is a secret of the `cloudflare-production` environment, and only the `wrangler deploy`
step reads it. The account ID is the environment's `CLOUDFLARE_ACCOUNT_ID` variable.

The token holds these permissions:

| Scope | Permissions |
|---|---|
| Account | Workers Scripts Write, Workers Containers Write, Cloudchamber Write, Account Settings Read |
| Zone `tibia.sh` | Workers Routes Write, Zone Read, DNS Write, SSL and Certificates Write |

DNS Write and SSL and Certificates Write cover the custom domain attach whatever permission Cloudflare checks for
it. They also widen what a leaked token can do. With DNS Write, a holder could rewrite the mail records of
`tibia.sh`, or the TXT record that holds its MCP registry key. With SSL and Certificates Write, they could change
its certificates. The maintainer accepted that trade-off. If this token leaks, rotate it at once.

If a deploy still asks for a permission this list lacks, the maintainer adds it to the token in place, and this
section changes.

The token has no expiry, so it lasts until it is rotated or revoked. To rotate it:

1. Create a new token with the same permissions.
2. Run `gh secret set CLOUDFLARE_API_TOKEN --env cloudflare-production --repo tibia-sh/mcp.tibia.sh`. It prompts
   for the token, so the token stays out of your shell history.
3. Run `deploy.yml` on `main`, as in [Deploy](#deploy), and wait for `smoke` to pass.
4. Revoke the old token.

## The release trigger token

`HOSTING_DISPATCH_TOKEN` is your fine-grained personal access token, with `tibia-sh` as its resource owner and
`mcp.tibia.sh` as the only repository it can reach. It is a secret of the `release-trigger` environment
in each of the three repositories, `mcp.tibia.sh`, `tibiawiki-mcp` and `tibiawiki-data`, and each of those
environments deploys from `main` only. The `publish` step of `bump.yml` reads it here. The `hosting` job of each
release workflow reads it there, to send the dispatch.

The token holds these permissions on `mcp.tibia.sh`:

| Permission | Access |
|---|---|
| Contents | Read and write |
| Pull requests | Read and write |
| Metadata | Read, which GitHub adds to every fine-grained token |

The token has no expiry, so it lasts until it is rotated or revoked. The organization's token policy caps a
fine-grained token at 366 days by default, and it was set to allow no expiry before the token was created.

The token means control of what the endpoint serves. The ruleset merges any pull request whose required checks
pass, and those checks run the pull request's own scripts and tests, so a holder can push a branch whose checks
pass by construction, open the pull request, turn on auto-merge, and land whatever `src/`, `Dockerfile`,
`wrangler.jsonc` or lockfile they like on `main`. The merge deploys it, and a build command in `wrangler.jsonc` or a
dependency standing in for wrangler would run in the deploy step next to the Cloudflare token. The token is your
own identity, so no rule can tell its pull requests from yours. It cannot push to `main` directly, read a secret
through the API, or touch the other two repositories, and without the Workflows permission it cannot change a
workflow file. The maintainer accepted that trade-off.

If this token leaks, revoke it first. Then close every open pull request, your own included, and open none but
the revert below until it has merged, since one with auto-merge on merges without the token once its checks pass
and deploys `main` as the holder left it. Cancel any run of `deploy.yml` still queued or in progress, since its
`deploy` job reads the Cloudflare token when it starts. Then rotate the Cloudflare token, as
[The deploy token](#the-deploy-token) describes but without its deploy: create the new token, store it and revoke
the old one. A deploy the holder landed may have read the old token, and while that token is valid its holder can
deploy or delete at Cloudflare outside GitHub, so the rotation goes before the revert, which waits on checks, a
merge and a deploy. Then check what `main` holds and, with the `curl` in [Deploy](#deploy), what the endpoint
serves, and revert anything you did not land yourself in a revert pull request. Its merge deploys clean code with
the new token. Do not deploy before that, since a deploy would run the new token next to whatever the holder
landed. Last, run the `curl` again to confirm that the endpoint serves the revert.

To rotate it:

1. Create a new token the same way: resource owner `tibia-sh`, repository access `mcp.tibia.sh` only, the
   permissions above, and no expiration.
2. Run `gh secret set HOSTING_DISPATCH_TOKEN --env release-trigger --repo tibia-sh/<repo>` for `mcp.tibia.sh`,
   `tibiawiki-mcp` and `tibiawiki-data`. Each prompts for the token, so it stays out of your shell history.
3. Revoke the old token.

## Decommissioning

1. Release `tibiawiki-mcp` without `remotes` in its `server.json`, so the MCP registry's latest version stops
   listing `https://mcp.tibia.sh/wiki` before the URL goes dead.
2. From a checkout of this repository, with your own Cloudflare login, delete the Worker with
   `pnpm exec wrangler delete`. That also removes its custom domain and its Durable Object namespace, but not
   the container application.
3. Delete the container application with `pnpm exec wrangler containers delete <ID>`, taking the ID from
   `pnpm exec wrangler containers list`.
4. Delete each image tag with `pnpm exec wrangler containers images delete <IMAGE>:<TAG>`, taking them from
   `pnpm exec wrangler containers images list`.
5. Revoke the deploy token, so a later merge cannot deploy the service again, and the release trigger token too, or
   a later first-party release keeps opening bump pull requests here.
