/**
 * IntegrationManager - Handles auto-installation and updates of the HA integration
 */

import fs from 'fs';
import path from 'path';

const BUNDLED_INTEGRATION_PATH = '/integration';
const HA_CUSTOM_COMPONENTS_PATH = '/homeassistant/custom_components';
const INTEGRATION_NAME = 'teufel_raumfeld_raumkernel';

export default class IntegrationManager {
    constructor() {
        this.targetPath = path.join(HA_CUSTOM_COMPONENTS_PATH, INTEGRATION_NAME);
        this.options = this.loadOptions();
    }

    loadOptions() {
        try {
            if (fs.existsSync('/data/options.json')) {
                return JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
            }
        } catch (err) {
            console.warn('IntegrationManager: Failed to load options:', err.message);
        }
        return { ENABLE_AUTO_INSTALL: true };
    }

    checkIntegrationInstalled() {
        return fs.existsSync(this.targetPath) && fs.existsSync(path.join(this.targetPath, 'manifest.json'));
    }

    getInstalledVersion() {
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(this.targetPath, 'manifest.json'), 'utf8'));
            return manifest.version || null;
        } catch {
            return null;
        }
    }

    getBundledVersion() {
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(BUNDLED_INTEGRATION_PATH, 'manifest.json'), 'utf8'));
            return manifest.version || null;
        } catch (err) {
            console.error('IntegrationManager: Failed to read bundled manifest:', err.message);
            return null;
        }
    }

    /**
     * Compare two semantic versions
     * Returns: -1 if a < b, 0 if a == b, 1 if a > b
     */
    compareVersions(a, b) {
        const partsA = a.split('.').map(Number);
        const partsB = b.split('.').map(Number);
        
        for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
            const numA = partsA[i] || 0;
            const numB = partsB[i] || 0;
            if (numA < numB) return -1;
            if (numA > numB) return 1;
        }
        return 0;
    }

    /**
     * Recursively copy a directory
     */
    copyDirectory(src, dest) {
        fs.mkdirSync(dest, { recursive: true });
        
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            
            if (entry.isDirectory()) {
                this.copyDirectory(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }

    /**
     * Install or update the integration
     * Returns true if changes were made
     */
    installOrUpdateIntegration() {
        const bundledVersion = this.getBundledVersion();
        if (!bundledVersion) {
            console.error('IntegrationManager: No bundled integration found');
            return false;
        }

        const installedVersion = this.getInstalledVersion();
        const isInstalled = this.checkIntegrationInstalled();

        if (isInstalled && installedVersion) {
            const comparison = this.compareVersions(installedVersion, bundledVersion);
            if (comparison >= 0) {
                console.log(`IntegrationManager: Integration already up to date (v${installedVersion})`);
                return false;
            }
            console.log(`IntegrationManager: Updating integration from v${installedVersion} to v${bundledVersion}`);
        } else {
            console.log(`IntegrationManager: Installing integration v${bundledVersion}`);
        }

        // Ensure custom_components directory exists
        fs.mkdirSync(HA_CUSTOM_COMPONENTS_PATH, { recursive: true });

        // Remove existing installation if present
        if (fs.existsSync(this.targetPath)) {
            fs.rmSync(this.targetPath, { recursive: true, force: true });
        }

        // Copy bundled integration
        this.copyDirectory(BUNDLED_INTEGRATION_PATH, this.targetPath);
        
        console.log(`IntegrationManager: Successfully installed integration v${bundledVersion}`);
        return true;
    }

    /**
     * Remove the integration from custom_components
     * Returns true if removed, false if not found
     */
    removeIntegration() {
        if (!this.checkIntegrationInstalled()) {
            console.log('IntegrationManager: Integration not installed, nothing to remove');
            return false;
        }

        console.log('IntegrationManager: Removing integration from custom_components');
        fs.rmSync(this.targetPath, { recursive: true, force: true });
        console.log('IntegrationManager: Integration removed successfully');
        return true;
    }

    /**
     * Create a persistent notification in Home Assistant
     */
    async notifyRestartRequired(action) {
        const supervisorToken = process.env.SUPERVISOR_TOKEN;
        if (!supervisorToken) {
            console.warn('IntegrationManager: SUPERVISOR_TOKEN not available, cannot create notification');
            return;
        }

        try {
            const response = await fetch('http://supervisor/core/api/services/persistent_notification/create', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${supervisorToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    title: 'Raumfeld: Homeassistant restart required',
                    message: `The Teufel Raumfeld integration has been ${action}. Please restart Home Assistant to apply changes.`,
                    notification_id: 'teufel_raumfeld_restart_required'
                })
            });

            if (response.ok) {
                console.log('IntegrationManager: Restart notification created');
            } else {
                console.warn('IntegrationManager: Failed to create notification:', response.status);
            }
        } catch (err) {
            console.warn('IntegrationManager: Failed to create notification:', err.message);
        }
    }

    /**
     * Main entry point - check and install/update integration if needed
     */
    async ensureIntegrationInstalled() {
        // Check if auto-install is enabled
        if (this.options.ENABLE_AUTO_INSTALL === false) {
            console.log('IntegrationManager: Auto-install disabled by configuration');
            return;
        }

        // Check if running in HA environment
        if (!fs.existsSync('/homeassistant')) {
            console.log('IntegrationManager: Not running in Home Assistant environment, skipping');
            return;
        }

        // Check if bundled integration exists
        if (!fs.existsSync(BUNDLED_INTEGRATION_PATH)) {
            console.log('IntegrationManager: No bundled integration found, skipping');
            return;
        }

        try {
            const changed = this.installOrUpdateIntegration();
            if (changed) {
                await this.notifyRestartRequired('installed/updated');
            }
        } catch (err) {
            console.error('IntegrationManager: Error during install/update:', err.message);
        }
    }
}
