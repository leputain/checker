import { convertV4MiniflareOptions, Miniflare as NativeMiniflare } from 'miniflare';
import path from 'node:path';

export type MiniflareOptions = Parameters<typeof convertV4MiniflareOptions>[0] & {
  resourcePersistencePath?: string;
};

/**
 * Convert the existing script options using Miniflare's official v4 adapter.
 * Persistent scripts explicitly supply the shared resource root (<state>/v3),
 * so the SDK 5 and Wrangler D1 paths retain the canonical <state>/v3/d1 layout.
 */
export class Miniflare extends NativeMiniflare {
  constructor(options: MiniflareOptions) {
    // One project-level path contract prevents mixed root/plugin paths from
    // selecting a different database when operational jobs share a state.
    if (Object.hasOwn(options, 'd1Persist')) {
      throw new Error('miniflare_d1_persist_use_project_resource_path');
    }
    const { resourcePersistencePath, ...nativeOptions } = options;
    if (resourcePersistencePath !== undefined && !path.isAbsolute(resourcePersistencePath)) {
      throw new Error('miniflare_resource_persistence_path_must_be_absolute');
    }
    const convertedOptions = convertV4MiniflareOptions(nativeOptions);
    super(resourcePersistencePath === undefined ? convertedOptions : {
      ...convertedOptions, resourcePersistencePath,
    });
  }
}
