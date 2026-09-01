'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');

const AUTH_URL = 'https://id.mammotion.com/oauth2/token';
const API_BASE_URL = 'https://api-open.mammotion.com';
const MOWERS_URL = `${API_BASE_URL}/v1/mowers`;
const MOWER_URL = `${API_BASE_URL}/v1/mower`;
const HISTORY_LIMIT = 50;
const RECHARGE_CANDIDATE_TIMEOUT_MS = 4 * 60 * 60 * 1000;

class MammotionOpenApi extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'mammotion-openapi' });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.accessToken = '';
        this.tokenExpiresAt = 0;
        this.pollTimer = null;
        this.pollRunning = false;
        this.consecutiveErrors = 0;
    }

    async onReady() {
        await this.ensureApiStates();
        await this.setStateAsync('info.connection', false, true);

        const clientId = String(this.config.clientId || '').trim();
        const clientSecret = String(this.config.clientSecret || '').trim();

        if (!clientId || !clientSecret) {
            const message = 'Mammotion Client ID and Client Secret must be configured.';
            await this.setStateAsync('api.ok', false, true);
            await this.setStateAsync('api.lastError', message, true);
            this.log.error(message);
            return;
        }

        const intervalSec = Math.max(30, Number(this.config.pollInterval) || 60);
        this.log.info(`Starting Mammotion OpenAPI polling every ${intervalSec} seconds (read-only).`);

        await this.poll();
        this.pollTimer = setInterval(() => this.poll(), intervalSec * 1000);
    }

    async ensureApiStates() {
        const states = {
            'api.ok': { type: 'boolean', role: 'indicator.connected', name: 'API OK' },
            'api.lastError': { type: 'string', role: 'text', name: 'Last API error' },
            'api.consecutiveErrors': { type: 'number', role: 'value', name: 'Consecutive API errors' },
            'api.lastHttpStatus': { type: 'number', role: 'value', name: 'Last HTTP status' },
            'api.lastSuccess': { type: 'number', role: 'value.time', name: 'Last successful API update' },
            'api.tokenExpiresAt': { type: 'number', role: 'value.time', name: 'Access token expires at' },
            'api.requestId': { type: 'string', role: 'text', name: 'Last Mammotion request ID' },
        };

        for (const [id, common] of Object.entries(states)) {
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: { ...common, read: true, write: false },
                native: {},
            });
        }
    }

    resetToken() {
        this.accessToken = '';
        this.tokenExpiresAt = 0;
    }

    async getAccessToken(force = false) {
        const marginMs = 5 * 60 * 1000;
        if (!force && this.accessToken && Date.now() < this.tokenExpiresAt - marginMs) {
            return this.accessToken;
        }

        const body = new URLSearchParams({
            client_id: String(this.config.clientId || '').trim(),
            client_secret: String(this.config.clientSecret || '').trim(),
            grant_type: 'client_credentials',
        });

        const response = await axios.post(AUTH_URL, body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15000,
        });

        await this.setStateAsync('api.lastHttpStatus', Number(response.status) || 0, true);

        const root = response.data || {};
        if (root.requestId) {
            await this.setStateAsync('api.requestId', String(root.requestId), true);
        }

        const tokenData = root?.data?.access_token ? root.data : root;
        if (!tokenData.access_token) {
            throw new Error(`No access_token in Mammotion authentication response: ${JSON.stringify(root).slice(0, 400)}`);
        }

        this.accessToken = tokenData.access_token;
        const expiresIn = Number(tokenData.expires_in) || 3600;
        this.tokenExpiresAt = Date.now() + expiresIn * 1000;
        await this.setStateAsync('api.tokenExpiresAt', this.tokenExpiresAt, true);

        return this.accessToken;
    }

    async apiGet(url, retryAuth = true) {
        const token = await this.getAccessToken(false);

        let response;
        try {
            response = await axios.get(url, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                },
                timeout: 15000,
            });
        } catch (error) {
            if (error.response?.status) {
                await this.setStateAsync('api.lastHttpStatus', Number(error.response.status), true);
            }

            if (retryAuth && error.response?.status === 401) {
                this.log.info('Mammotion access token rejected with HTTP 401; requesting a new token once.');
                this.resetToken();
                await this.getAccessToken(true);
                return this.apiGet(url, false);
            }

            throw error;
        }

        await this.setStateAsync('api.lastHttpStatus', Number(response.status) || 0, true);

        const root = response.data || {};
        if (root.requestId) {
            await this.setStateAsync('api.requestId', String(root.requestId), true);
        }

        if (retryAuth && Number(root.code) === 401) {
            this.log.info('Mammotion API returned code 401; requesting a new token once.');
            this.resetToken();
            await this.getAccessToken(true);
            return this.apiGet(url, false);
        }

        if (root.code !== undefined && Number(root.code) !== 0) {
            throw new Error(`Mammotion API code=${root.code}: ${root.msg || 'unknown error'}`);
        }

        return root;
    }

    async discoverMowers() {
        const root = await this.apiGet(MOWERS_URL);
        return Array.isArray(root.data) ? root.data : [];
    }

    async readMower(deviceId) {
        const root = await this.apiGet(`${MOWER_URL}/${encodeURIComponent(deviceId)}`);
        return root.data;
    }

    async readPlans(deviceId) {
        const root = await this.apiGet(`${MOWER_URL}/${encodeURIComponent(deviceId)}/plan`);
        return Array.isArray(root.data) ? root.data : [];
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
            previousStatus: { type: 'string', role: 'text', name: 'Previous operating status' },
            lastStatusChange: { type: 'number', role: 'value.time', name: 'Last operating status change' },
            batteryLevel: { type: 'number', role: 'value.battery', name: 'Battery level', unit: '%' },
            chargeStatus: { type: 'number', role: 'value', name: 'Charge status (raw)' },
            previousChargeStatus: { type: 'number', role: 'value', name: 'Previous charge status (raw)' },
            lastChargeStatusChange: { type: 'number', role: 'value.time', name: 'Last charge status change' },
            'network.usedNetwork': { type: 'string', role: 'text', name: 'Used network' },
            'network.wifiAvailable': { type: 'boolean', role: 'indicator', name: 'Wi-Fi available' },
            'network.wifiRssi': { type: 'number', role: 'value', name: 'Wi-Fi RSSI', unit: 'dBm' },
            'network.cellularAvailable': { type: 'boolean', role: 'indicator', name: 'Cellular available' },
            'network.cellularRssi': { type: 'number', role: 'value', name: 'Cellular RSSI', unit: 'dBm' },
            'plans.count': { type: 'number', role: 'value', name: 'Saved plan count' },
            'plans.rawJson': { type: 'string', role: 'json', name: 'Saved plans (raw JSON)' },
            'plans.lastUpdate': { type: 'number', role: 'value.time', name: 'Last plan update' },
            'recharge.mowingSeenSinceIdle': { type: 'boolean', role: 'indicator', name: 'Working seen since idle' },
            'recharge.candidate': { type: 'boolean', role: 'indicator', name: 'Intermediate recharge candidate' },
            'recharge.candidateSince': { type: 'number', role: 'value.time', name: 'Intermediate recharge candidate since' },
            'recharge.confirmedDuringTask': { type: 'boolean', role: 'indicator', name: 'Intermediate recharge confirmed during current task' },
            'recharge.lastConfirmed': { type: 'number', role: 'value.time', name: 'Last confirmed intermediate recharge' },
            'recharge.confirmedCount': { type: 'number', role: 'value', name: 'Confirmed intermediate recharge count' },
            'recharge.statusHistoryJson': { type: 'string', role: 'json', name: 'Recent status and charge-state history' },
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

        await this.ensureStateValue(`${base}.previousStatus`, '');
        await this.ensureStateValue(`${base}.lastStatusChange`, 0);
        await this.ensureStateValue(`${base}.previousChargeStatus`, -1);
        await this.ensureStateValue(`${base}.lastChargeStatusChange`, 0);
        await this.ensureStateValue(`${base}.recharge.mowingSeenSinceIdle`, false);
        await this.ensureStateValue(`${base}.recharge.candidate`, false);
        await this.ensureStateValue(`${base}.recharge.candidateSince`, 0);
        await this.ensureStateValue(`${base}.recharge.confirmedDuringTask`, false);
        await this.ensureStateValue(`${base}.recharge.lastConfirmed`, 0);
        await this.ensureStateValue(`${base}.recharge.confirmedCount`, 0);
        await this.ensureStateValue(`${base}.recharge.statusHistoryJson`, '[]');
    }

    async ensureStateValue(id, defaultValue) {
        const state = await this.getStateAsync(id);
        if (!state || state.val === null || state.val === undefined) {
            await this.setStateAsync(id, defaultValue, true);
        }
    }

    async updateTransitionStates(base, data) {
        const now = Date.now();
        const nextStatus = data.status ?? '';
        const nextChargeStatus = Number.isFinite(Number(data.chargeStatus)) ? Number(data.chargeStatus) : -1;

        const oldStatusState = await this.getStateAsync(`${base}.status`);
        const hadStatus = oldStatusState?.val !== undefined && oldStatusState?.val !== null;
        const oldStatus = hadStatus ? String(oldStatusState.val) : '';
        const statusChanged = hadStatus && oldStatus !== nextStatus;

        if (statusChanged) {
            await this.setStateAsync(`${base}.previousStatus`, oldStatus, true);
            await this.setStateAsync(`${base}.lastStatusChange`, now, true);
        }

        const oldChargeState = await this.getStateAsync(`${base}.chargeStatus`);
        const hadChargeStatus = oldChargeState?.val !== undefined && oldChargeState?.val !== null;
        const oldChargeStatus = hadChargeStatus && Number.isFinite(Number(oldChargeState.val))
            ? Number(oldChargeState.val)
            : -1;
        const chargeStatusChanged = hadChargeStatus && oldChargeStatus !== nextChargeStatus;

        if (chargeStatusChanged) {
            await this.setStateAsync(`${base}.previousChargeStatus`, oldChargeStatus, true);
            await this.setStateAsync(`${base}.lastChargeStatusChange`, now, true);
        }

        return {
            now,
            nextStatus,
            nextChargeStatus,
            oldStatus,
            oldChargeStatus,
            hadStatus,
            hadChargeStatus,
            statusChanged,
            chargeStatusChanged,
        };
    }

    isWorkingStatus(status) {
        const value = String(status || '').trim().toLowerCase();
        return value === 'working' || value.includes('mow') || value.includes('work');
    }

    isReturningStatus(status) {
        return String(status || '').trim().toLowerCase() === 'returning';
    }

    async readBooleanState(id, fallback = false) {
        const state = await this.getStateAsync(id);
        return state?.val === undefined || state?.val === null ? fallback : Boolean(state.val);
    }

    async readNumberState(id, fallback = 0) {
        const state = await this.getStateAsync(id);
        const value = Number(state?.val);
        return Number.isFinite(value) ? value : fallback;
    }

    async updateHistory(base, data, transition) {
        if (!transition.statusChanged && !transition.chargeStatusChanged && transition.hadStatus && transition.hadChargeStatus) {
            return;
        }

        const historyState = await this.getStateAsync(`${base}.recharge.statusHistoryJson`);
        let history = [];

        if (typeof historyState?.val === 'string' && historyState.val) {
            try {
                const parsed = JSON.parse(historyState.val);
                if (Array.isArray(parsed)) history = parsed;
            } catch {
                history = [];
            }
        }

        history.push({
            ts: transition.now,
            time: new Date(transition.now).toISOString(),
            status: transition.nextStatus,
            battery: Number.isFinite(Number(data.batteryLevel)) ? Number(data.batteryLevel) : -1,
            chargeStatus: transition.nextChargeStatus,
            online: data.online === 1 || data.online === true,
        });

        if (history.length > HISTORY_LIMIT) {
            history = history.slice(history.length - HISTORY_LIMIT);
        }

        await this.setStateAsync(`${base}.recharge.statusHistoryJson`, JSON.stringify(history), true);
    }

    async updateRechargeTracking(base, transition) {
        const now = transition.now;
        const status = transition.nextStatus;
        const chargeStatus = transition.nextChargeStatus;
        const working = this.isWorkingStatus(status);
        const returningOrCharging = this.isReturningStatus(status) || chargeStatus > 0;

        let mowingSeen = await this.readBooleanState(`${base}.recharge.mowingSeenSinceIdle`, false);
        let candidate = await this.readBooleanState(`${base}.recharge.candidate`, false);
        let candidateSince = await this.readNumberState(`${base}.recharge.candidateSince`, 0);
        let confirmedDuringTask = await this.readBooleanState(`${base}.recharge.confirmedDuringTask`, false);

        if (candidate && candidateSince > 0 && now - candidateSince > RECHARGE_CANDIDATE_TIMEOUT_MS) {
            candidate = false;
            candidateSince = 0;
            mowingSeen = false;
            confirmedDuringTask = false;
            await this.setStateAsync(`${base}.recharge.candidate`, false, true);
            await this.setStateAsync(`${base}.recharge.candidateSince`, 0, true);
            await this.setStateAsync(`${base}.recharge.mowingSeenSinceIdle`, false, true);
            await this.setStateAsync(`${base}.recharge.confirmedDuringTask`, false, true);
        }

        if (working) {
            if (candidate) {
                const count = await this.readNumberState(`${base}.recharge.confirmedCount`, 0);
                await this.setStateAsync(`${base}.recharge.confirmedCount`, count + 1, true);
                await this.setStateAsync(`${base}.recharge.lastConfirmed`, now, true);
                await this.setStateAsync(`${base}.recharge.confirmedDuringTask`, true, true);
                await this.setStateAsync(`${base}.recharge.candidate`, false, true);
                await this.setStateAsync(`${base}.recharge.candidateSince`, 0, true);
                candidate = false;
                candidateSince = 0;
                confirmedDuringTask = true;
            } else if (!mowingSeen) {
                confirmedDuringTask = false;
                await this.setStateAsync(`${base}.recharge.confirmedDuringTask`, false, true);
            }

            mowingSeen = true;
            await this.setStateAsync(`${base}.recharge.mowingSeenSinceIdle`, true, true);
            return;
        }

        if (mowingSeen && !candidate && returningOrCharging) {
            candidate = true;
            candidateSince = now;
            await this.setStateAsync(`${base}.recharge.candidate`, true, true);
            await this.setStateAsync(`${base}.recharge.candidateSince`, now, true);
        }

        if (confirmedDuringTask) {
            await this.setStateAsync(`${base}.recharge.confirmedDuringTask`, true, true);
        }
    }

    async updateMower(data, plans) {
        if (!data || !data.id) return;

        const base = `mowers.${this.objectId(data.id)}`;
        await this.ensureMowerObjects(base);
        const transition = await this.updateTransitionStates(base, data);
        await this.updateHistory(base, data, transition);
        await this.updateRechargeTracking(base, transition);

        const network = data.network || {};
        const now = Date.now();
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
            'plans.count': Array.isArray(plans) ? plans.length : 0,
            'plans.rawJson': JSON.stringify(Array.isArray(plans) ? plans : []),
            'plans.lastUpdate': now,
            lastUpdate: now,
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
                const plans = await this.readPlans(mower.id);
                await this.updateMower(details, plans);
            }

            this.consecutiveErrors = 0;
            await this.setStateAsync('api.ok', true, true);
            await this.setStateAsync('api.lastError', '', true);
            await this.setStateAsync('api.consecutiveErrors', 0, true);
            await this.setStateAsync('api.lastSuccess', Date.now(), true);
            await this.setStateAsync('info.connection', true, true);
        } catch (error) {
            this.consecutiveErrors += 1;
            const message = error.response
                ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data).slice(0, 500)}`
                : error.message || String(error);

            await this.setStateAsync('api.ok', false, true);
            await this.setStateAsync('api.lastError', message, true);
            await this.setStateAsync('api.consecutiveErrors', this.consecutiveErrors, true);
            await this.setStateAsync('info.connection', false, true);
            this.log.warn(`Mammotion API error: ${message}`);
        } finally {
            this.pollRunning = false;
        }
    }

    onUnload(callback) {
        try {
            if (this.pollTimer) clearInterval(this.pollTimer);
            this.setState('info.connection', false, true);
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
