'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');

const AUTH_URL = 'https://id.mammotion.com/oauth2/token';
const MOWERS_URL = 'https://api-open.mammotion.com/v1/mowers';
const MOWER_URL = 'https://api-open.mammotion.com/v1/mower';

class MammotionOpenApi extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'mammotion-openapi' });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.accessToken = '';
        this.tokenExpiresAt = 0;
        this.pollTimer = null;
        this.pollRunning = false;
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);

        if (!this.config.clientId || !this.config.clientSecret) {
            this.log.error('Mammotion Client ID and Client Secret must be configured.');
            return;
        }

        await this.ensureApiStates();

        const intervalSec = Math.max(30, Number(this.config.pollInterval) || 60);
        this.log.info(`Starting Mammotion OpenAPI polling every ${intervalSec} seconds (read-only).`);

        await this.poll();
        this.pollTimer = setInterval(() => this.poll(), intervalSec * 1000);
    }

    async ensureApiStates() {
        const states = {
            'api.ok': { type: 'boolean', role: 'indicator.connected', name: 'API OK' },
            'api.lastError': { type: 'string', role: 'text', name: 'Last API error' },
            'api.lastSuccess': { type: 'number', role: 'value.time', name: 'Last successful API update' },
            'api.tokenExpiresAt': { type: 'number', role: 'value.time', name: 'Access token expires at' },
        };

        for (const [id, common] of Object.entries(states)) {
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: { ...common, read: true, write: false },
                native: {},
            });
        }
    }

    async getAccessToken(force = false) {
        const marginMs = 5 * 60 * 1000;
        if (!force && this.accessToken && Date.now() < this.tokenExpiresAt - marginMs) {
            return this.accessToken;
        }

        const body = new URLSearchParams({
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
            grant_type: 'client_credentials',
        });

        const response = await axios.post(AUTH_URL, body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15000,
        });

        const root = response.data || {};
        const tokenData = root?.data?.access_token ? root.data : root;

        if (!tokenData.access_token) {
            throw new Error(`No access_token in Mammotion response: ${JSON.stringify(root).slice(0, 400)}`);
        }

        this.accessToken = tokenData.access_token;
        const expiresIn = Number(tokenData.expires_in) || 3600;
        this.tokenExpiresAt = Date.now() + expiresIn * 1000;
        await this.setStateAsync('api.tokenExpiresAt', this.tokenExpiresAt, true);
        return this.accessToken;
    }

    async apiGet(url, retry401 = true) {
        const token = await this.getAccessToken(false);

        try {
            return await axios.get(url, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                },
                timeout: 15000,
            });
        } catch (error) {
            if (retry401 && error.response?.status === 401) {
                this.accessToken = '';
                this.tokenExpiresAt = 0;
                await this.getAccessToken(true);
                return this.apiGet(url, false);
            }
            throw error;
        }
    }

    async discoverMowers() {
        const response = await this.apiGet(MOWERS_URL);
        const root = response.data || {};

        if (root.code !== undefined && Number(root.code) !== 0) {
            throw new Error(`Mammotion API code=${root.code}: ${root.msg || 'unknown error'}`);
        }

        return Array.isArray(root.data) ? root.data : [];
    }

    async readMower(deviceId) {
        const response = await this.apiGet(`${MOWER_URL}/${encodeURIComponent(deviceId)}`);
        const root = response.data || {};

        if (root.code !== undefined && Number(root.code) !== 0) {
            throw new Error(`Mammotion API code=${root.code}: ${root.msg || 'unknown error'}`);
        }

        return root.data;
    }

    objectId(deviceId) {
        return String(deviceId).replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    async ensureMowerObjects(base) {
        const defs = {
            name: { type: 'string', role: 'text', name: 'Name' },
            model: { type: 'string', role: 'text', name: 'Model' },
            firmware: { type: 'string', role: 'text', name: 'Firmware' },
            online: { type: 'boolean', role: 'indicator.reachable', name: 'Online' },
            status: { type: 'string', role: 'text', name: 'Operating status' },
            batteryLevel: { type: 'number', role: 'value.battery', name: 'Battery level', unit: '%' },
            chargeStatus: { type: 'number', role: 'value', name: 'Charge status (raw)' },
            'network.usedNetwork': { type: 'string', role: 'text', name: 'Used network' },
            'network.wifiAvailable': { type: 'boolean', role: 'indicator', name: 'Wi-Fi available' },
            'network.wifiRssi': { type: 'number', role: 'value', name: 'Wi-Fi RSSI', unit: 'dBm' },
            'network.cellularAvailable': { type: 'boolean', role: 'indicator', name: 'Cellular available' },
            'network.cellularRssi': { type: 'number', role: 'value', name: 'Cellular RSSI', unit: 'dBm' },
            lastUpdate: { type: 'number', role: 'value.time', name: 'Last update' },
            rawJson: { type: 'string', role: 'json', name: 'Raw mower data' },
        };

        for (const [suffix, common] of Object.entries(defs)) {
            await this.setObjectNotExistsAsync(`${base}.${suffix}`, {
                type: 'state',
                common: { ...common, read: true, write: false },
                native: {},
            });
        }
    }

    async updateMower(data) {
        if (!data || !data.id) return;

        const base = `mowers.${this.objectId(data.id)}`;
        await this.ensureMowerObjects(base);

        const network = data.network || {};
        const values = {
            name: data.name ?? '',
            model: data.model ?? '',
            firmware: data.version ?? '',
            online: data.online === 1 || data.online === true,
            status: data.status ?? '',
            batteryLevel: Number.isFinite(Number(data.batteryLevel)) ? Number(data.batteryLevel) : -1,
            chargeStatus: Number.isFinite(Number(data.chargeStatus)) ? Number(data.chargeStatus) : -1,
            'network.usedNetwork': network.usedNetwork ?? '',
            'network.wifiAvailable': network.wifiAvailable === true,
            'network.wifiRssi': Number.isFinite(Number(network.wifiRssi)) ? Number(network.wifiRssi) : 0,
            'network.cellularAvailable': network.cellularAvailable === true,
            'network.cellularRssi': Number.isFinite(Number(network.cellularRssi)) ? Number(network.cellularRssi) : 0,
            lastUpdate: Date.now(),
            rawJson: JSON.stringify(data),
        };

        for (const [suffix, value] of Object.entries(values)) {
            await this.setStateChangedAsync(`${base}.${suffix}`, value, true);
        }
    }

    async poll() {
        if (this.pollRunning) return;
        this.pollRunning = true;

        try {
            const mowers = await this.discoverMowers();
            if (!mowers.length) {
                throw new Error('No Mammotion mowers returned for this account.');
            }

            for (const mower of mowers) {
                const details = await this.readMower(mower.id);
                await this.updateMower(details);
            }

            await this.setStateAsync('api.ok', true, true);
            await this.setStateAsync('api.lastError', '', true);
            await this.setStateAsync('api.lastSuccess', Date.now(), true);
            await this.setStateAsync('info.connection', true, true);
        } catch (error) {
            const message = error.response
                ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data).slice(0, 500)}`
                : error.message || String(error);

            await this.setStateAsync('api.ok', false, true);
            await this.setStateAsync('api.lastError', message, true);
            await this.setStateAsync('info.connection', false, true);
            this.log.warn(`Mammotion API error: ${message}`);
        } finally {
            this.pollRunning = false;
        }
    }

    onUnload(callback) {
        try {
            if (this.pollTimer) clearInterval(this.pollTimer);
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new MammotionOpenApi(options);
} else {
    new MammotionOpenApi();
}
