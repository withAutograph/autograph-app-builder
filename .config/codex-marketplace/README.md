# Project Vercel package

This project pins the unchanged official [Vercel plugin](https://github.com/vercel/vercel-plugin) as a Git submodule. The small marketplace index uses its actual plugin name, `vercel`; the upstream marketplace currently calls it `vercel-plugin`, which Codex rejects. No vendor files are modified.

Pinned revision: `93a4de9d97d54ce3d6ea4951717873731ac8c3ec`. The newer `358400a` revision has invalid YAML in its AI Gateway skill; this preceding revision passes skill discovery without that error.

For a new checkout, initialize the package and register the local marketplace:

```sh
git submodule update --init .config/codex-marketplace/vercel
codex plugin marketplace add .config/codex-marketplace
codex plugin add vercel@vercel-project
```

The install command enables the package in user configuration. Set `[plugins."vercel@vercel-project"]` to `enabled = false` in your user Codex config after installation. The repository's `.codex/config.toml` enables it only for this project. This task has already applied that user-level default on the configured workstation. Restart discovery after changing selections.

Keep Apple platforms, Cloudflare and CodeRabbit out of this project unless its requirements call for them. Stripe guidance is included only as part of this project-selected Vercel package. Use official OpenAI Visualize for inline explanations, Data Analytics for analytical reports, and Build Web Data Visualization for web charts. Keep local and native document workflows separate.
