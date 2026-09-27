# Operating mcp.tibia.sh

How the endpoint is built, released, deployed and rolled back, and the two credentials behind it. The [README](../README.md) covers what the endpoint is and how to use it.

## Rate limit

The Worker allows about 300 JSON-RPC messages per 60 s from each IPv4 address or IPv6 /64. Every message in a
batch counts. A request for the server card counts as one message. Past the limit, it answers `429` with
`Retry-After: 60`.

The limit is approximate. Cloudflare counts it per location and applies it permissively. claude.ai users share
Anthropic's egress IPs, so they share one allowance.

In front of the Worker, a WAF rate limiting rule on the `tibia.sh` zone blocks an IP for 10 s once it has sent
more than 200 requests in 10 s, whatever the path or the answer. It is the Free plan's one rule, created on
2026-09-16 (ruleset `71d2118739af4571a02d729c6ea41111`, rule `c18c933621b3469a8d92dfb6650c3f50`), and it
matches every path because the plan offers no host field. The zone serves only `mcp.tibia.sh`, so that is the
same thing. A blocked request gets Cloudflare's own `429` page, not the Worker's answer. The rule lives in the
Cloudflare dashboard under Security, WAF, Rate limiting rules, not in this repository.

## Browser clients

The endpoint answers CORS preflights and allows any origin, so an MCP client that runs in a browser needs no
configuration from you. Every answer of `/wiki` but the landing page carries the CORS headers, and a browser
client can read `Retry-After` on a `429`. A web page can make its visitors' browsers call the endpoint and spend
each visitor's own per-IP allowance, which costs those visitors a `429` for up to a minute and reaches no state or
non-public data.

## The server card

`https://mcp.tibia.sh/wiki/server-card` serves the endpoint's MCP Server Card, a JSON document that describes the
server before you connect. It follows the experimental extension `io.modelcontextprotocol/server-card`, SEP-2127.
The answer carries `Content-Type: application/mcp-server-card+json`, `Cache-Control: public, max-age=3600`, an
`ETag` that is the deployed commit in double quotes, and the four CORS headers the extension requires:
`Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET`,
`Access-Control-Allow-Headers: Content-Type, If-None-Match` and `Access-Control-Expose-Headers: ETag`. A `GET`
with a matching `If-None-Match` gets `304`. The card's `$schema` is
`https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json`, the identifier the extension's schema
requires. That URL did not resolve when this was written. The `/.well-known/` paths some crawlers probe for a
card stay `404`.

## How a release reaches the endpoint

1. The release workflow of [`tibiawiki-mcp`](https://github.com/tibia-sh/tibiawiki-mcp) or
   [`tibiawiki-data`](https://github.com/tibia-sh/tibiawiki-data) publishes to npm. Its `hosting` job then sends this
   repository a `repository_dispatch` of type `first-party-release` naming the package and the version.
2. The dispatch starts `bump.yml` on the tip of `main`. Runs queue one after the other, so a second release pins on
   the `main` the first one merged. It has two jobs:
   - `pin` has no environment and no credential. `node scripts/bump.ts pin` refuses any package but the two above,
     any version that is not an exact `1.2.3`, and any version below the pin. The pinned version ends it with
     `bump: already-pinned`, and the run ends green without `publish`. Otherwise it waits up to 15 minutes for npm
     to serve the version with a provenance attestation and a tarball that answers `200`, runs
     `pnpm add --save-exact`, then `scripts/check-lockfile.ts` on the result. npm lists a fresh version before its
     CDN serves the tarball, and `pnpm add` fails on the `404` it answers meanwhile. The job hands `publish` its
     commit and the sha256 of `package.json` and `pnpm-lock.yaml`.
   - `publish` runs in the `release-trigger` environment, only when `pin` changed the files. It installs nothing
     and runs no dependency code. On `pin`'s commit it runs
     `pnpm add --save-exact --lockfile-only --ignore-scripts`, which writes the two files without `node_modules`,
     and fails unless both match `pin`'s hashes. Then it mints a token of [the tibia-sh App](#the-tibia-sh-app),
     and `node scripts/bump.ts publish`, the one step with the token, pushes the branch `bump/<name>-<version>`
     and opens the pull request `chore(deps): bump <package> to <version>`, or reuses the open one. Then it turns
     auto-merge on, which merges at once when the checks have already passed, and waits up to 30 minutes for the
     merge.
3. CI runs the required checks `unit`, `container` and `worker` on the pull request. No job reads a secret, so
   every pull request runs every check. `container` builds the image and checks that it serves the pinned server
   version and index.
4. Auto-merge rebases the pull request onto `main` once the checks pass. The ruleset has no bypass actors, so
   nothing merges before they do. The `publish` job ends green with `bump: merged`, and GitHub deletes the
   branch.
5. The push to `main` runs `deploy.yml`:
   - `ci` runs the same checks on the merged commit.
   - `deploy` runs `pnpm audit signatures`, then `pnpm exec wrangler deploy` with the token of the
     `cloudflare-production` environment. wrangler builds and pushes the image, and deploys the Worker with the
     merged commit as its `DEPLOY_COMMIT`.
   - `smoke` runs `scripts/served-artifact.ts` without the token. It passes once the landing page answers with the
     merged commit in `x-deploy-commit`, and `/wiki` serves the pinned server version and index. It starts no new
     attempt after 10 minutes.

You can start the chain at step 2 by hand, from a checkout of this repository. gh runs it on `main`, and the
`release-trigger` environment deploys only from `main`, so a run from another branch fails at its `publish` job:

```bash
gh workflow run bump.yml -f package=@tibia.sh/tibiawiki-mcp -f version=1.2.3
```

A `bump.yml` or `deploy.yml` run that does not pass starts `alert.yml`. It comments
`<workflow> <conclusion>: <run url>` on the open issue titled `Automation needs a look`, or opens that issue and
assigns it to `drptbl`. Work through the runs it lists, then close it, and the next failure opens a new one.

What can go wrong, and what to do:

| What you see | What to do |
|---|---|
| Red CI on the bump pull request | The `publish` job turns red after 30 minutes, when its wait for the merge runs out, so act on the red checks without waiting for it. Push the fix to the bump branch, and auto-merge merges it once the checks pass. Or close the pull request, fix the cause on `main`, and run `bump.yml` by hand. |
| A bump pull request closed, or open past 30 minutes | The `publish` job is red. Fix the cause, then run `bump.yml` by hand. It reuses an open pull request and turns auto-merge on again, or opens a new one. A pull request that merges on its own after the run turned red needs nothing more: a run by hand then finds the version pinned, its `pin` job ends with `bump: already-pinned`, and `publish` does not run. |
| A red `bump` run before any pull request exists | Read the last line of the failed step. In `pin`, npm did not serve the version with its provenance and a downloadable tarball within 15 minutes, or the lockfile check refused the version: its provenance does not verify, or the lockfile holds a second copy of a first-party package at a version `package.json` does not pin. Wait, or fix the cause, then run `bump.yml` by hand. In `publish`, before the token, `sha256sum` names a file whose recomputed pin differs from `pin`'s, which a registry change between the two jobs can cause: run `bump.yml` by hand. A failed token step, or `Bad credentials` from gh, means the App's key or its installation no longer works, and [The tibia-sh App](#the-tibia-sh-app) describes how to rotate the key. Otherwise gh failed before it opened the pull request, and the line quotes what gh said. A failed `publish` is recovered by running `bump.yml` by hand, since its `pin` finds the version pinned only once `main` has it. |
| A version still under a cooldown | The first-party packages skip the 7-day cooldown, and only their dependencies wait for it. The `pin` job fails at `pnpm add` when no version of some dependency is both in the range the release asks for and 7 days old, so the run is red before a pull request exists. Wait until one is, then run `bump.yml` by hand. |
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

## The tibia-sh App

The `publish` job of `bump.yml` opens its pull request as the `tibia-sh-bot` GitHub App, ID `5091135`, which the
`tibia-sh` organization owns and has installed on all its repositories. The job mints a token with
`actions/create-github-app-token` from two organization settings: the variable `TIBIA_SH_APP_CLIENT_ID` and the
secret `TIBIA_SH_APP_PRIVATE_KEY`, the App's private key. The job runs in the `release-trigger` environment, which
deploys from `main` only, and the token reaches only the step that runs `node scripts/bump.ts publish`.

The token reaches `mcp.tibia.sh` alone, with these permissions, and expires within the hour. The action revokes it
when the job ends.

| Permission | Access |
|---|---|
| Contents | Read and write |
| Pull requests | Read and write |
| Metadata | Read, which GitHub adds to every App token |

A pull request the App opens runs CI, which one opened with `GITHUB_TOKEN` would not, and it is the App's, so you
can tell it from yours.

The key means more than that token. By the maintainer's decision, the App's installation holds broad permissions on
every repository of the organization, workflows, secrets, actions and environments among them, and whoever holds
the key can mint a token with all of them. A leaked key can rewrite workflows and reach their secrets. On this
repository, the ruleset merges any pull request whose required checks pass, and those checks run the pull request's
own scripts and tests, so a holder can also land whatever `src/`, `Dockerfile`, `wrangler.jsonc`, lockfile or
workflow they like on `main`, and the merge deploys it next to the Cloudflare token. The ruleset has no bypass
actors, and the App holds no administration permission, so a holder cannot push to `main` directly or change the
ruleset. The maintainer accepted that trade-off.

If the key leaks, revoke it first: in the App's settings, generate a new private key and delete the leaked one, then
put the new key in `TIBIA_SH_APP_PRIVATE_KEY`, as in the rotation below. A token minted with the leaked key stays
valid until it expires, within the hour. To cut it off at once, suspend the App's installation in the
organization's settings, and unsuspend it once the new key is stored. Then close every open pull request, your own
included, and open none but the revert below until it has merged, since one with auto-merge on merges without a
token once its checks pass and deploys `main` as the holder left it. Cancel any run of `deploy.yml` still queued or
in progress, since its `deploy` job reads the Cloudflare token when it starts. Then rotate the Cloudflare token, as
[The deploy token](#the-deploy-token) describes but without its deploy: create the new token, store it and revoke
the old one. A deploy the holder landed may have read the old token, and while that token is valid its holder can
deploy or delete at Cloudflare outside GitHub, so the rotation goes before the revert, which waits on checks, a
merge and a deploy. Then check what `main` holds and, with the `curl` in [Deploy](#deploy), what the endpoint
serves, and revert anything you did not land yourself in a revert pull request. Its merge deploys clean code with
the new token. Do not deploy before that, since a deploy would run the new token next to whatever the holder
landed. Last, run the `curl` again to confirm that the endpoint serves the revert.

The key has no expiry, so it lasts until it is deleted. To rotate it:

1. In the App's settings, under Private keys, generate a new private key. GitHub downloads it as a `.pem` file.
2. In the organization's settings, under Secrets and variables, Actions, update `TIBIA_SH_APP_PRIVATE_KEY` with
   the file's content. Updating the value keeps the repositories that can read it.
3. Delete the old key in the App's settings, and delete the downloaded file.

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
5. Revoke the deploy token, so a later merge cannot deploy the service again, and take this repository out of the
   tibia-sh App's installation, or a later first-party release keeps opening bump pull requests here.
