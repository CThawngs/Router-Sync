/**
 * test/acceptance/at-103-cross-platform-paths.test.ts
 *
 * Acceptance test for cross-platform paths resolution and sync/network safety (SPEC §32 / X1, X8).
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  getConfigDir,
  getStateDir,
  getCatalogDbPath,
  getSnapshotsDir,
  getLogsDir,
  isSyncOrNetworkFs,
} from '@routersync/core';

describe('AT-103: Cross-platform paths and filesystem safety (SPEC §32 / X1, X8)', () => {
  it('resolves standard config directory on Windows, macOS, and Linux', () => {
    // Windows
    const winEnv = { APPDATA: 'C:\\AppData\\Roaming' };
    expect(getConfigDir(winEnv, 'win32')).toBe(path.join('C:\\AppData\\Roaming', 'routersync'));

    // Linux with XDG
    const linuxXdg = { XDG_CONFIG_HOME: '/etc/xdg/.custom_config' };
    expect(getConfigDir(linuxXdg, 'linux')).toBe(path.join('/etc/xdg/.custom_config', 'routersync'));

    // Linux without XDG (fallback ~/.config)
    const linuxFallback = {};
    expect(getConfigDir(linuxFallback, 'linux')).toBe(path.join(os.homedir(), '.config', 'routersync'));

    // macOS
    const macEnv = {};
    expect(getConfigDir(macEnv, 'darwin')).toBe(path.join(os.homedir(), '.config', 'routersync'));
  });

  it('resolves state directory per OS, avoiding roaming sync on Windows (X1)', () => {
    // Windows LOCALAPPDATA
    const winEnv = { LOCALAPPDATA: 'C:\\AppData\\Local' };
    expect(getStateDir(winEnv, 'win32')).toBe(path.join('C:\\AppData\\Local', 'routersync'));

    // Linux XDG_STATE_HOME
    const linuxXdg = { XDG_STATE_HOME: '/var/local/custom_state' };
    expect(getStateDir(linuxXdg, 'linux')).toBe(path.join('/var/local/custom_state', 'routersync'));

    // Linux fallback
    const linuxFallback = {};
    expect(getStateDir(linuxFallback, 'linux')).toBe(path.join(os.homedir(), '.local', 'state', 'routersync'));
  });

  it('honors ROUTERSYNC_HOME and ROUTERSYNC_STATE_DIR overrides', () => {
    const customHome = { ROUTERSYNC_HOME: '/opt/routersync-home' };
    expect(getConfigDir(customHome, 'linux')).toBe(path.resolve('/opt/routersync-home', 'config'));
    expect(getStateDir(customHome, 'linux')).toBe(path.resolve('/opt/routersync-home', 'state'));

    const stateOverride = { ROUTERSYNC_STATE_DIR: '/var/lib/routersync' };
    expect(getStateDir(stateOverride, 'linux')).toBe(path.resolve('/var/lib/routersync'));
    expect(getCatalogDbPath(stateOverride, 'linux')).toBe(path.join(path.resolve('/var/lib/routersync'), 'catalog.sqlite'));
    expect(getSnapshotsDir(stateOverride, 'linux')).toBe(path.join(path.resolve('/var/lib/routersync'), 'snapshots'));
    expect(getLogsDir(stateOverride, 'linux')).toBe(path.join(path.resolve('/var/lib/routersync'), 'logs'));
  });

  it('detects cloud-synced folders, UNC network shares, and WSL cross-mounts (X8)', () => {
    // Normal safe local paths
    expect(isSyncOrNetworkFs('C:\\AppData\\Local\\routersync\\data.sqlite').isSyncOrNetwork).toBe(false);
    expect(isSyncOrNetworkFs('/var/state/routersync/data.sqlite').isSyncOrNetwork).toBe(false);

    // OneDrive
    const oneDrive = isSyncOrNetworkFs('C:\\Sync\\OneDrive\\Documents\\routersync\\data.sqlite'); // no-secrets:allow: test synthetic onedrive path
    expect(oneDrive.isSyncOrNetwork).toBe(true);
    expect(oneDrive.warning).toContain('OneDrive');

    // Dropbox
    const dropbox = isSyncOrNetworkFs('/var/sync/Dropbox/routersync/data.sqlite');
    expect(dropbox.isSyncOrNetwork).toBe(true);
    expect(dropbox.warning).toContain('Dropbox');

    // Google Drive
    const gDrive = isSyncOrNetworkFs('D:\\Google Drive\\routersync\\data.sqlite');
    expect(gDrive.isSyncOrNetwork).toBe(true);
    expect(gDrive.warning).toContain('Google Drive');

    // UNC Share
    const uncShare = isSyncOrNetworkFs('\\\\nas01\\share\\routersync\\data.sqlite');
    expect(uncShare.isSyncOrNetwork).toBe(true);
    expect(uncShare.warning).toContain('UNC');

    // WSL 9p mount
    const wslMount = isSyncOrNetworkFs('/mnt/c/data/routersync/data.sqlite');
    expect(wslMount.isSyncOrNetwork).toBe(true);
    expect(wslMount.warning).toContain('WSL 9p');
  });
});
