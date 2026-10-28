# Setting up the ParallelFlow GitHub App

Each ParallelFlow deployment has one GitHub App. An arena owner uses it to connect an arena to a GitHub repository (ADR-040). Once connected, GitHub's repository is the arena repo: each approved stage is pushed to its default branch, and pushes and merged pull requests on GitHub show in the arena's Overview.

Without the app's settings, the feature is off and the Overview says "GitHub isn't set up on this server."

## 1. Register the app

On GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub App**. For an organization, use the organization's settings instead.

| Field | Value |
|---|---|
| GitHub App name | For example `ParallelFlow` (or `ParallelFlow Dev` for local testing). The slug in its URL (`github.com/apps/<slug>`) is `GITHUB_APP_SLUG`. |
| Homepage URL | Your web app, for example `https://app.example.com` |
| Callback URL | `<web origin>/v1/github/callback`, for example `http://localhost:3000/v1/github/callback` |
| Expire user authorization tokens | On (the default) |
| Request user authorization (OAuth) during installation | **Off**. ParallelFlow sends people to sign in itself, after the install. |
| Setup URL | `<web origin>/v1/github/setup` |
| Redirect on update | **On**, so changing the repositories of an existing installation also comes back to ParallelFlow |
| Webhook: Active | On |
| Webhook URL | `<API origin>/v1/github/webhook`. Behind the web app's `/v1` proxy, `<web origin>/v1/github/webhook` works too. |
| Webhook secret | A long random value (at least 20 characters), also set as `GITHUB_WEBHOOK_SECRET` |
| Where can this app be installed? | "Only on this account" for testing; "Any account" for real use |

The callback and setup URLs use the **web** origin: the browser carries the ParallelFlow session cookie there, and the web app forwards `/v1/*` to the API.

## 2. Permissions and events

Give the app only what it needs.

**Repository permissions**

- Contents: **Read and write** (fetch, and push the approved documents)
- Pull requests: **Read and write** (for the coding flow)
- Metadata: **Read-only** (required by GitHub)

Leave every other permission at "No access", including all organization and account permissions.

**Subscribe to events**

- Push
- Pull request

The `installation` and `installation_repositories` events are always sent to GitHub Apps, so there is nothing to tick for them.

## 3. Keys and secrets

After creating the app:

1. Note the **App ID** (a number) on the app's General page.
2. Note the **Client ID**, then press **Generate a new client secret** and copy it.
3. Under **Private keys**, press **Generate a private key**. GitHub downloads a `.pem` file.

## 4. Environment

Set these in `.env.local` (or in the deployment's environment). Set all six, or none.

```bash
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=parallelflow-dev
# The whole PEM file. On one line, write its newlines as \n.
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n"
GITHUB_APP_CLIENT_ID=Iv23li...
GITHUB_APP_CLIENT_SECRET=...
GITHUB_WEBHOOK_SECRET=...
```

Restart the API. When only some of them are set, it refuses to start and names the missing ones.

The private key, the client secret and the webhook secret are secrets: never commit them. Installation tokens are made from the private key on demand and kept only in the API's memory.

## 5. Database

Migration `0011_github` adds `arena_github_repos` and `github_webhook_deliveries`. Run `pnpm db:migrate` once.

## 6. Connecting an arena

1. As the arena owner, open the arena. In **Overview → Repository**, press **Connect GitHub**.
2. On GitHub, pick the account and the repositories ParallelFlow may use, and install (or save).
3. GitHub asks you to authorize ParallelFlow (only the first time). This proves you can use that installation.
4. Back in the arena, pick the repository and press **Connect**.

If the GitHub repository is empty, it gets the arena's whole history. Otherwise GitHub's history is kept: the arena's documents are added as one commit on top, and the arena's earlier local history stays on the server under `refs/parallelflow/before-github`. ParallelFlow never force-pushes.

ParallelFlow writes only `README.md`, `AGENTS.md`, `PROGRESS.md`, `STATE.md` and the folders `docs/plan`, `docs/product`, `docs/design`, `docs/build`, `docs/test`, `docs/deploy` and `docs/maintain`. Everything else in the repository, including `AGENTS.local.md`, is left alone.

If the default branch is protected so that the app cannot push to it, the Overview shows the error. Allow the app to push to it (for example as a bypass actor in the branch ruleset).

## 7. Testing locally with a webhook proxy

GitHub cannot reach `localhost`, so use a proxy such as [smee.io](https://smee.io):

1. Open https://smee.io and press **Start a new channel**. Copy the channel URL.
2. Set the app's **Webhook URL** to the channel URL.
3. Forward the channel to the local API:

   ```bash
   npx smee-client --url https://smee.io/<channel> --target http://localhost:4000/v1/github/webhook
   ```

4. Push to the connected repository. The Overview shows the new commit within a few seconds.

The callback and setup URLs can stay on `http://localhost:3000`, because your own browser follows those redirects.

GitHub lists every delivery under the app's **Advanced** tab, where you can also redeliver one. ParallelFlow handles each delivery id only once.
