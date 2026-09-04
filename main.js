'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');

const AUTH_URL = 'https://id.mammotion.com/oauth2/token';
const API_BASE_URL = 'https://api-open.mammotion.com';
const MOWERS_URL = `${API_BASE_URL}/v1/mowers`;
const MOWER_URL = `${API_BASE_URL}/v1/mower`;
const ACTION_URL = `${API_BASE_URL}/v1/mower/action`;
const HISTORY_LIMIT = 50;
const RECHARGE_CANDIDATE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const RECHARGE_TRACKING_VERSION = 2;
const SLEEP_STANDBY_DELAY_MS = 2 * 60 * 1000;
const SLEEP_WAKE_GRACE_MS = 5 * 60 * 1000;

const OBSOLETE_STATE_SUFFIXES = [
    'nickname',
    'icon',
    'workParams.available',
    'workParams.commandResult',
    'workParams.resultMessage',
    'workParams.edgeMode',
    'workParams.rideBoundaryDistance',
    'workParams.channelMode',
    'workParams.channelModeText',
    'workParams.jobContent',
    'workParams.jobContentText',
    'workParams.dumpPeriodSqm',
    'workParams.knifeHeight',
    'workParams.speed',
    'workParams.channelWidth',
    'workParams.toward',
    'workParams.towardMode',
    'workParams.towardModeText',
    'workParams.towardIncludedAngle',
    'workParams.ultraWave',
    'workParams.ultraWaveText',
    'workParams.boundaryZigzagOrder',
    'workParams.boundaryZigzagOrderText',
    'workParams.forbiddenAreaCircleTimes',
    'workParams.visualHashsJson',
    'workParams.lastUpdate',
    'workParams.rawJson',
];

class MammotionOpenApi extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'mammotion-openapi' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.accessToken = '';
        this.tokenExpiresAt = 0;
        this.pollTimer = null;
        this.commandRefreshTimer = null;
        this.pollRunning = false;
        this.consecutiveErrors = 0;
        this.commandRunning = new Set();
        this.cleanedMowers = new Set();

        this.knownMowers = [];
        this.sleepingMowers = new Set();
        this.sleepCandidateSince = new Map();
        this.sleepWakeGraceUntil = new Map();
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

        await this.subscribeStatesAsync('mowers.*.tasks.*.start');
        await this.subscribeStatesAsync('mowers.*.controls.*');
        await this.subscribeStatesAsync('mowers.*.sleep.resumePolling');

        const intervalSec = Math.max(30, Number(this.config.pollInterval) || 60);
        const sleepEnabled = this.isSleepProtectionEnabled();
        const sleepThreshold = this.getSleepThreshold();

        this.log.info(`Starting Mammotion OpenAPI polling every ${intervalSec} seconds.`);
        if (sleepEnabled) {
            this.log.info(
                `Sleep protection enabled: Standby + chargeStatus=0 + battery >= ${sleepThreshold}% for 2 minutes stops automatic mower polling.`,
            );
        } else {
            this.log.info('Sleep protection is disabled in the adapter configuration.');
        }

        await this.poll();
        this.pollTimer = setInterval(() => void this.poll(), intervalSec * 1000);
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

    isSleepProtectionEnabled() {
        return this.config.sleepEnabled !== false;
    }

    getSleepThreshold() {
        const configured = Number(this.config.sleepBatteryPercent);
        const value = Number.isFinite(configured) ? configured : 80;
        return Math.min(100, Math.max(20, Math.round(value)));
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
            throw new Error(
                `No access_token in Mammotion authentication response: ${JSON.stringify(root).slice(0, 400)}`,
            );
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

    async apiPost(url, body, retryAuth = true) {
        const token = await this.getAccessToken(false);
        let response;

        try {
            response = await axios.post(url, body, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
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
                return this.apiPost(url, body, false);
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
            return this.apiPost(url, body, false);
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
        return root.data || {};
    }

    async readPlans(deviceId) {
        const root = await this.apiGet(`${MOWER_URL}/${encodeURIComponent(deviceId)}/plan`);
        return Array.isArray(root.data) ? root.data : [];
    }

    async sendAction(deviceId, action, taskName = '') {
        const body = { deviceId, action };
        if (taskName) body.params = { taskName };
        return this.apiPost(ACTION_URL, body);
    }

    objectId(value) {
        return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    taskObjectId(task, usedIds) {
        const namePart = this.objectId(task?.taskName || 'task') || 'task';
        let id = namePart;
        if (usedIds.has(id)) {
            const suffix = this.objectId(task?.taskId || '').slice(-8) || String(usedIds.size + 1);
            id = `${namePart}_${suffix}`;
        }
        usedIds.add(id);
        return id;
    }

    numberOr(value, fallback = -1) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    async cleanupObsoleteObjects(base) {
        if (this.cleanedMowers.has(base)) return;

        for (const suffix of OBSOLETE_STATE_SUFFIXES) {
            try {
                await this.delObjectAsync(`${base}.${suffix}`);
            } catch {
                // Missing objects are expected on clean installations.
            }
        }

        try {
            await this.delObjectAsync(`${base}.workParams`, { recursive: true });
        } catch {
            // Parent channel/folder may not exist.
        }

        this.cleanedMowers.add(base);
    }

    async ensureMowerObjects(base) {
        await this.setObjectNotExistsAsync(`${base}.controls`, {
            type: 'channel',
            common: { name: 'Task controls' },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${base}.sleep`, {
            type: 'channel',
            common: { name: 'Sleep protection' },
            native: {},
        });

        const defs = {
            id: { type: 'string', role: 'text', name: 'Mammotion device ID' },
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
            'recharge.candidateSince': {
                type: 'number',
                role: 'value.time',
                name: 'Intermediate recharge candidate since',
            },
            'recharge.confirmedDuringTask': {
                type: 'boolean',
                role: 'indicator',
                name: 'Intermediate recharge confirmed during current task',
            },
            'recharge.lastConfirmed': {
                type: 'number',
                role: 'value.time',
                name: 'Last confirmed intermediate recharge',
            },
            'recharge.confirmedCount': {
                type: 'number',
                role: 'value',
                name: 'Confirmed intermediate recharge count',
            },
            'recharge.trackingVersion': {
                type: 'number',
                role: 'value',
                name: 'Recharge tracking algorithm version',
            },
            'recharge.statusHistoryJson': {
                type: 'string',
                role: 'json',
                name: 'Recent status and charge-state history',
            },
            'sleep.active': { type: 'boolean', role: 'indicator', name: 'Sleep-friendly polling suspended' },
            'sleep.since': { type: 'number', role: 'value.time', name: 'Sleep-friendly mode since' },
            'sleep.candidateSince': { type: 'number', role: 'value.time', name: 'Sleep candidate since' },
            'sleep.thresholdPercent': {
                type: 'number',
                role: 'value',
                name: 'Configured sleep battery threshold',
                unit: '%',
            },
            'sleep.reason': { type: 'string', role: 'text', name: 'Sleep reason' },
            'controls.lastCommand': { type: 'string', role: 'text', name: 'Last command' },
            'controls.lastCommandOk': { type: 'boolean', role: 'indicator', name: 'Last command successful' },
            'controls.lastCommandError': { type: 'string', role: 'text', name: 'Last command error' },
            'controls.lastCommandAt': { type: 'number', role: 'value.time', name: 'Last command time' },
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

        const buttons = {
            stop: 'Stopp / Pause current task',
            resume: 'Fortführen / Resume current task',
            abort: 'Abbrechen / Stop current task',
            returnToDock: 'Zur Ladestation / Return to dock',
            cancelReturn: 'Rückkehr abbrechen / Cancel return to dock',
        };

        for (const [button, name] of Object.entries(buttons)) {
            await this.setObjectNotExistsAsync(`${base}.controls.${button}`, {
                type: 'state',
                common: {
                    name,
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                    def: false,
                },
                native: {},
            });
            await this.ensureStateValue(`${base}.controls.${button}`, false);
        }

        await this.setObjectNotExistsAsync(`${base}.sleep.resumePolling`, {
            type: 'state',
            common: {
                name: 'Polling wieder starten / Resume polling',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            },
            native: {},
        });

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
        await this.ensureStateValue(`${base}.recharge.trackingVersion`, 0);
        await this.ensureStateValue(`${base}.recharge.statusHistoryJson`, '[]');
        await this.ensureStateValue(`${base}.sleep.active`, false);
        await this.ensureStateValue(`${base}.sleep.since`, 0);
        await this.ensureStateValue(`${base}.sleep.candidateSince`, 0);
        await this.ensureStateValue(`${base}.sleep.thresholdPercent`, this.getSleepThreshold());
        await this.ensureStateValue(`${base}.sleep.reason`, '');
        await this.ensureStateValue(`${base}.sleep.resumePolling`, false);
        await this.ensureStateValue(`${base}.controls.lastCommand`, '');
        await this.ensureStateValue(`${base}.controls.lastCommandOk`, true);
        await this.ensureStateValue(`${base}.controls.lastCommandError`, '');
        await this.ensureStateValue(`${base}.controls.lastCommandAt`, 0);

        await this.cleanupObsoleteObjects(base);
    }

    async ensureTaskObjects(base, plans) {
        const usedIds = new Set();

        for (const task of Array.isArray(plans) ? plans : []) {
            if (!task || !task.taskName) continue;

            const taskKey = this.taskObjectId(task, usedIds);
            const taskBase = `${base}.tasks.${taskKey}`;

            await this.setObjectNotExistsAsync(taskBase, {
                type: 'channel',
                common: { name: String(task.taskName) },
                native: { taskId: task.taskId || '' },
            });
            await this.setObjectNotExistsAsync(`${taskBase}.taskId`, {
                type: 'state',
                common: { name: 'Task ID', type: 'string', role: 'text', read: true, write: false },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${taskBase}.taskName`, {
                type: 'state',
                common: { name: 'Task name', type: 'string', role: 'text', read: true, write: false },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${taskBase}.start`, {
                type: 'state',
                common: {
                    name: `Start ${task.taskName}`,
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                    def: false,
                },
                native: {},
            });

            await this.setStateChangedAsync(`${taskBase}.taskId`, String(task.taskId || ''), true);
            await this.setStateChangedAsync(`${taskBase}.taskName`, String(task.taskName), true);
            await this.ensureStateValue(`${taskBase}.start`, false);
        }
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
        const nextChargeStatus = this.numberOr(data.chargeStatus, -1);

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
        const oldChargeStatus = hadChargeStatus ? this.numberOr(oldChargeState.val, -1) : -1;
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

    isTaskPausedStatus(status) {
        return String(status || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z]/g, '') === 'taskpaused';
    }

    isStandbyStatus(status) {
        return String(status || '').trim().toLowerCase() === 'standby';
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
            battery: this.numberOr(data.batteryLevel, -1),
            chargeStatus: transition.nextChargeStatus,
            online: data.online === 1 || data.online === true,
        });

        if (history.length > HISTORY_LIMIT) {
            history = history.slice(history.length - HISTORY_LIMIT);
        }
        await this.setStateAsync(`${base}.recharge.statusHistoryJson`, JSON.stringify(history), true);
    }

    async resetRechargeSequence(base) {
        await this.setStateAsync(`${base}.recharge.mowingSeenSinceIdle`, false, true);
        await this.setStateAsync(`${base}.recharge.candidate`, false, true);
        await this.setStateAsync(`${base}.recharge.candidateSince`, 0, true);
        await this.setStateAsync(`${base}.recharge.confirmedDuringTask`, false, true);
    }

    async migrateRechargeTracking(base) {
        const version = await this.readNumberState(`${base}.recharge.trackingVersion`, 0);
        if (version >= RECHARGE_TRACKING_VERSION) return;

        await this.resetRechargeSequence(base);
        await this.setStateAsync(`${base}.recharge.lastConfirmed`, 0, true);
        await this.setStateAsync(`${base}.recharge.confirmedCount`, 0, true);
        await this.setStateAsync(`${base}.recharge.trackingVersion`, RECHARGE_TRACKING_VERSION, true);

        this.log.info(
            `Recharge tracking migrated to version ${RECHARGE_TRACKING_VERSION} for ${base}; unreliable v0.0.5 counters were reset, status history was preserved.`,
        );
    }

    async updateRechargeTracking(base, transition) {
        const now = transition.now;
        const status = transition.nextStatus;
        const chargeStatus = transition.nextChargeStatus;
        const working = this.isWorkingStatus(status);
        const taskPaused = this.isTaskPausedStatus(status);
        const taskPausedWhileCharging = taskPaused && chargeStatus > 0;
        const standby = this.isStandbyStatus(status);

        let mowingSeen = await this.readBooleanState(`${base}.recharge.mowingSeenSinceIdle`, false);
        let candidate = await this.readBooleanState(`${base}.recharge.candidate`, false);
        let candidateSince = await this.readNumberState(`${base}.recharge.candidateSince`, 0);
        let confirmedDuringTask = await this.readBooleanState(`${base}.recharge.confirmedDuringTask`, false);

        if (standby) {
            if (mowingSeen || candidate || confirmedDuringTask) {
                await this.resetRechargeSequence(base);
            }
            return;
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

        // A rain or recharge pause can legitimately last longer than the normal
        // safety timeout. Keep the candidate for as long as TaskPaused is
        // reported, and allow the first subsequent working state to confirm it.
        if (
            candidate &&
            !taskPaused &&
            candidateSince > 0 &&
            now - candidateSince > RECHARGE_CANDIDATE_TIMEOUT_MS
        ) {
            candidate = false;
            candidateSince = 0;
            mowingSeen = false;
            confirmedDuringTask = false;
            await this.resetRechargeSequence(base);
        }

        if (mowingSeen && !candidate && taskPausedWhileCharging) {
            candidate = true;
            candidateSince = now;
            await this.setStateAsync(`${base}.recharge.candidate`, true, true);
            await this.setStateAsync(`${base}.recharge.candidateSince`, now, true);
            this.log.info(
                `Intermediate recharge candidate for ${base}: TaskPaused while charging after mowing was observed.`,
            );
        }

        if (confirmedDuringTask) {
            await this.setStateAsync(`${base}.recharge.confirmedDuringTask`, true, true);
        }
    }

    async clearSleepCandidate(base, deviceId) {
        if (!this.sleepCandidateSince.has(deviceId)) return;
        this.sleepCandidateSince.delete(deviceId);
        await this.setStateAsync(`${base}.sleep.candidateSince`, 0, true);
    }

    async enterSleepMode(base, deviceId, batteryLevel) {
        const threshold = this.getSleepThreshold();
        const now = Date.now();
        const reason = `Standby, chargeStatus=0, battery ${batteryLevel}% >= ${threshold}%`;

        this.sleepingMowers.add(deviceId);
        this.sleepCandidateSince.delete(deviceId);
        this.sleepWakeGraceUntil.delete(deviceId);

        await this.setStateAsync(`${base}.sleep.active`, true, true);
        await this.setStateAsync(`${base}.sleep.since`, now, true);
        await this.setStateAsync(`${base}.sleep.candidateSince`, 0, true);
        await this.setStateAsync(`${base}.sleep.thresholdPercent`, threshold, true);
        await this.setStateAsync(`${base}.sleep.reason`, reason, true);

        this.log.info(
            `Sleep protection active for ${deviceId}: ${reason}. Automatic OpenAPI polling for this mower is now suspended.`,
        );
    }

    async resumeMowerPolling(base, deviceId, reason = 'manual resume', graceMs = SLEEP_WAKE_GRACE_MS) {
        const persistedActive = await this.readBooleanState(`${base}.sleep.active`, false);
        const wasSleeping = this.sleepingMowers.delete(deviceId) || persistedActive;

        this.sleepCandidateSince.delete(deviceId);
        if (graceMs > 0) {
            this.sleepWakeGraceUntil.set(deviceId, Date.now() + graceMs);
        } else {
            this.sleepWakeGraceUntil.delete(deviceId);
        }

        await this.setStateAsync(`${base}.sleep.active`, false, true);
        await this.setStateAsync(`${base}.sleep.since`, 0, true);
        await this.setStateAsync(`${base}.sleep.candidateSince`, 0, true);
        await this.setStateAsync(`${base}.sleep.reason`, '', true);

        if (wasSleeping) {
            this.log.info(`Sleep protection released for ${deviceId}: ${reason}. Automatic polling resumes.`);
        }
    }

    async evaluateSleepMode(base, data) {
        if (!data || !data.id) return;

        const deviceId = String(data.id);
        const threshold = this.getSleepThreshold();
        await this.setStateChangedAsync(`${base}.sleep.thresholdPercent`, threshold, true);

        if (!this.isSleepProtectionEnabled()) {
            await this.clearSleepCandidate(base, deviceId);
            if (this.sleepingMowers.has(deviceId)) {
                await this.resumeMowerPolling(base, deviceId, 'sleep protection disabled', 0);
            }
            return;
        }

        if (this.sleepingMowers.has(deviceId)) return;

        const graceUntil = this.sleepWakeGraceUntil.get(deviceId) || 0;
        if (graceUntil > Date.now()) {
            await this.clearSleepCandidate(base, deviceId);
            return;
        }
        if (graceUntil) this.sleepWakeGraceUntil.delete(deviceId);

        const batteryLevel = this.numberOr(data.batteryLevel, -1);
        const chargeStatus = this.numberOr(data.chargeStatus, -1);
        const online = data.online === 1 || data.online === true;
        const eligible =
            online &&
            this.isStandbyStatus(data.status) &&
            chargeStatus === 0 &&
            batteryLevel >= threshold;

        if (!eligible) {
            await this.clearSleepCandidate(base, deviceId);
            return;
        }

        const now = Date.now();
        let candidateSince = this.sleepCandidateSince.get(deviceId) || 0;

        if (!candidateSince) {
            candidateSince = now;
            this.sleepCandidateSince.set(deviceId, candidateSince);
            await this.setStateAsync(`${base}.sleep.candidateSince`, candidateSince, true);
            this.log.info(
                `Sleep candidate for ${deviceId}: Standby, chargeStatus=0, battery ${batteryLevel}% >= ${threshold}%.`,
            );
            return;
        }

        if (now - candidateSince < SLEEP_STANDBY_DELAY_MS) return;
        await this.enterSleepMode(base, deviceId, batteryLevel);
    }

    async updateMower(data, plans) {
        if (!data || !data.id) return;

        const base = `mowers.${this.objectId(data.id)}`;
        await this.ensureMowerObjects(base);
        await this.ensureTaskObjects(base, plans);
        await this.migrateRechargeTracking(base);

        const transition = await this.updateTransitionStates(base, data);
        await this.updateHistory(base, data, transition);
        await this.updateRechargeTracking(base, transition);

        const network = data.network || {};
        const now = Date.now();

        const values = {
            id: String(data.id),
            name: data.name ?? '',
            model: data.model ?? '',
            firmware: data.version ?? '',
            online: data.online === 1 || data.online === true,
            status: data.status ?? '',
            batteryLevel: this.numberOr(data.batteryLevel, -1),
            chargeStatus: this.numberOr(data.chargeStatus, -1),
            'network.usedNetwork': network.usedNetwork ?? '',
            'network.wifiAvailable': network.wifiAvailable === true,
            'network.wifiRssi': this.numberOr(network.wifiRssi, 0),
            'network.cellularAvailable': network.cellularAvailable === true,
            'network.cellularRssi': this.numberOr(network.cellularRssi, 0),
            'plans.count': Array.isArray(plans) ? plans.length : 0,
            'plans.rawJson': JSON.stringify(Array.isArray(plans) ? plans : []),
            'plans.lastUpdate': now,
            lastUpdate: now,
            rawJson: JSON.stringify(data),
        };

        for (const [suffix, value] of Object.entries(values)) {
            await this.setStateChangedAsync(`${base}.${suffix}`, value, true);
        }

        await this.evaluateSleepMode(base, data);
    }

    async restoreSleepStateForKnownMower(mower) {
        if (!mower?.id) return;
        const deviceId = String(mower.id);
        const base = `mowers.${this.objectId(deviceId)}`;

        // Run object setup and one-time tracking migration without contacting the mower.
        // This also works while a persisted sleep state keeps detail polling suspended.
        await this.ensureMowerObjects(base);
        await this.migrateRechargeTracking(base);

        const state = await this.getStateAsync(`${base}.sleep.active`);
        const persistedActive = state?.val === true;

        if (persistedActive && this.isSleepProtectionEnabled()) {
            this.sleepingMowers.add(deviceId);
            this.log.info(
                `Restored sleep protection for ${deviceId}; automatic mower polling remains suspended after adapter restart.`,
            );
            return;
        }

        if (persistedActive && !this.isSleepProtectionEnabled()) {
            await this.setStateAsync(`${base}.sleep.active`, false, true);
            await this.setStateAsync(`${base}.sleep.since`, 0, true);
            await this.setStateAsync(`${base}.sleep.candidateSince`, 0, true);
            await this.setStateAsync(`${base}.sleep.reason`, '', true);
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack || !state.val) return;

        const relativeId = id.startsWith(`${this.namespace}.`)
            ? id.slice(this.namespace.length + 1)
            : id;

        const sleepMatch = relativeId.match(/^mowers\.([^.]+)\.sleep\.resumePolling$/);
        if (sleepMatch) {
            const mowerKey = sleepMatch[1];
            const base = `mowers.${mowerKey}`;
            const idState = await this.getStateAsync(`${base}.id`);
            const deviceId = String(idState?.val || mowerKey).trim();

            try {
                await this.resumeMowerPolling(base, deviceId, 'manual resume button');
                await this.poll();
            } finally {
                await this.setStateAsync(`${base}.sleep.resumePolling`, false, true);
            }
            return;
        }

        const taskMatch = relativeId.match(/^mowers\.([^.]+)\.tasks\.([^.]+)\.start$/);
        if (taskMatch) {
            const mowerKey = taskMatch[1];
            const taskKey = taskMatch[2];
            const base = `mowers.${mowerKey}`;
            const taskBase = `${base}.tasks.${taskKey}`;
            const taskNameState = await this.getStateAsync(`${taskBase}.taskName`);
            const taskName = String(taskNameState?.val || '').trim();

            try {
                if (!taskName) throw new Error('Task name is missing.');
                await this.executeCommand(base, 'START', taskName);
            } finally {
                await this.setStateAsync(`${taskBase}.start`, false, true);
            }
            return;
        }

        const controlMatch = relativeId.match(
            /^mowers\.([^.]+)\.controls\.(stop|resume|abort|returnToDock|cancelReturn)$/,
        );
        if (!controlMatch) return;

        const mowerKey = controlMatch[1];
        const control = controlMatch[2];
        const base = `mowers.${mowerKey}`;
        const actions = {
            stop: 'PAUSE',
            resume: 'RESUME',
            abort: 'STOP',
            returnToDock: 'RETURN',
            cancelReturn: 'CANCEL_RETURN',
        };

        try {
            await this.executeCommand(base, actions[control]);
        } finally {
            await this.setStateAsync(`${base}.controls.${control}`, false, true);
        }
    }

    async executeCommand(base, action, taskName = '') {
        if (this.commandRunning.has(base)) {
            this.log.warn(`Ignoring ${action}: another command is already running for ${base}.`);
            return;
        }

        this.commandRunning.add(base);
        const now = Date.now();
        const label = taskName ? `${action}:${taskName}` : action;

        try {
            const idState = await this.getStateAsync(`${base}.id`);
            const deviceId = String(idState?.val || '').trim();
            if (!deviceId) throw new Error('Mammotion device ID is missing.');

            const graceMs = action === 'STOP' || action === 'RETURN' ? 0 : SLEEP_WAKE_GRACE_MS;
            await this.resumeMowerPolling(base, deviceId, `command ${label}`, graceMs);

            await this.setStateAsync(`${base}.controls.lastCommand`, label, true);
            await this.setStateAsync(`${base}.controls.lastCommandAt`, now, true);
            await this.setStateAsync(`${base}.controls.lastCommandError`, '', true);

            const response = await this.sendAction(deviceId, action, taskName);
            await this.setStateAsync(`${base}.controls.lastCommandOk`, true, true);
            this.log.info(`Mammotion command ${label} accepted for ${deviceId}: ${response.msg || 'Request success'}`);

            if (action === 'START' || action === 'STOP' || action === 'RETURN') {
                await this.resetRechargeSequence(base);
            }

            if (this.commandRefreshTimer) clearTimeout(this.commandRefreshTimer);
            this.commandRefreshTimer = setTimeout(() => {
                this.commandRefreshTimer = null;
                void this.poll();
            }, 3000);
        } catch (error) {
            const message = error.response
                ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data).slice(0, 500)}`
                : error.message || String(error);

            await this.setStateAsync(`${base}.controls.lastCommandOk`, false, true);
            await this.setStateAsync(`${base}.controls.lastCommandError`, message, true);
            this.log.warn(`Mammotion command ${label} failed: ${message}`);
        } finally {
            this.commandRunning.delete(base);
        }
    }

    async poll() {
        if (this.pollRunning) return;
        this.pollRunning = true;

        try {
            let apiCallMade = false;

            if (!this.knownMowers.length) {
                const mowers = await this.discoverMowers();
                apiCallMade = true;

                if (!mowers.length) {
                    throw new Error('No Mammotion mowers returned for this account.');
                }

                this.knownMowers = mowers
                    .filter(mower => mower?.id)
                    .map(mower => ({ ...mower, id: String(mower.id) }));

                for (const mower of this.knownMowers) {
                    await this.restoreSleepStateForKnownMower(mower);
                }
            }

            for (const mower of this.knownMowers) {
                const deviceId = String(mower.id);
                if (this.sleepingMowers.has(deviceId)) continue;

                const details = await this.readMower(deviceId);
                apiCallMade = true;
                const plans = await this.readPlans(deviceId);
                apiCallMade = true;
                await this.updateMower(details, plans);
            }

            if (apiCallMade) {
                this.consecutiveErrors = 0;
                await this.setStateAsync('api.ok', true, true);
                await this.setStateAsync('api.lastError', '', true);
                await this.setStateAsync('api.consecutiveErrors', 0, true);
                await this.setStateAsync('api.lastSuccess', Date.now(), true);
                await this.setStateAsync('info.connection', true, true);
            }
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
            if (this.commandRefreshTimer) clearTimeout(this.commandRefreshTimer);
            this.setState('info.connection', false, true);
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    const startAdapter = options => new MammotionOpenApi(options);
    startAdapter.MammotionOpenApi = MammotionOpenApi;
    module.exports = startAdapter;
} else {
    new MammotionOpenApi();
}
