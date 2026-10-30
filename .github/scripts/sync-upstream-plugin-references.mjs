import { syncUpstreamPluginReferences } from "./lib/upstream-plugin-sync.mjs";

async function main() {
  const { syncedPlugins } = await syncUpstreamPluginReferences();

  for (const plugin of syncedPlugins) {
    console.log(`Synced ${plugin.pluginId}@${plugin.version} -> ${plugin.referenceDir}`);
  }
  console.log(
    `Updated .github/scripts/upstream-plugins/lock.json for ${syncedPlugins.length} tracked plugins.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
