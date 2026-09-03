'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const BASE = 'mowers.test';

function loadAdapterClass() {
    const filename = path.join(__dirname, '..', 'main.js');
    const source = fs.readFileSync(filename, 'utf8');
    const moduleMock = { exports: {} };
    const requireMock = id => {
        if (id === '@iobroker/adapter-core') return { Adapter: class {} };
        if (id === 'axios') return {};
        throw new Error(`Unexpected test dependency: ${id}`);
    };
    requireMock.main = null;

    vm.runInNewContext(
        source,
        {
            module: moduleMock,
            exports: moduleMock.exports,
            require: requireMock,
            URLSearchParams,
            setInterval,
            clearInterval,
            setTimeout,
            clearTimeout,
        },
        { filename },
    );

    return moduleMock.exports.MammotionOpenApi;
}

const MammotionOpenApi = loadAdapterClass();

function createTracker(initial = {}) {
    const adapter = Object.create(MammotionOpenApi.prototype);
    const states = new Map(Object.entries(initial));

    adapter.log = { info: () => {} };
    adapter.getStateAsync = async id => (states.has(id) ? { val: states.get(id) } : null);
    adapter.setStateAsync = async (id, value) => {
        states.set(id, value);
    };

    return { adapter, states };
}

function initialTrackingStates(overrides = {}) {
    return {
        [`${BASE}.recharge.mowingSeenSinceIdle`]: false,
        [`${BASE}.recharge.candidate`]: false,
        [`${BASE}.recharge.candidateSince`]: 0,
        [`${BASE}.recharge.confirmedDuringTask`]: false,
        [`${BASE}.recharge.lastConfirmed`]: 0,
        [`${BASE}.recharge.confirmedCount`]: 0,
        [`${BASE}.recharge.trackingVersion`]: 2,
        ...overrides,
    };
}

async function applyTransition(adapter, now, status, chargeStatus) {
    await adapter.updateRechargeTracking(BASE, {
        now,
        nextStatus: status,
        nextChargeStatus: chargeStatus,
    });
}

test('completed job followed by a new job is not counted as intermediate recharge', async () => {
    const { adapter, states } = createTracker(initialTrackingStates());

    await applyTransition(adapter, 1_000, 'Mowing', 0);
    await applyTransition(adapter, 2_000, 'Returning', 0);
    assert.equal(states.get(`${BASE}.recharge.candidate`), false);

    await applyTransition(adapter, 3_000, 'Standby', 2);
    assert.equal(states.get(`${BASE}.recharge.mowingSeenSinceIdle`), false);
    assert.equal(states.get(`${BASE}.recharge.candidate`), false);
    assert.equal(states.get(`${BASE}.recharge.confirmedDuringTask`), false);

    await applyTransition(adapter, 4_000, 'Mowing', 0);
    assert.equal(states.get(`${BASE}.recharge.confirmedCount`), 0);
    assert.equal(states.get(`${BASE}.recharge.candidate`), false);
});

test('TaskPaused while charging followed by Mowing confirms intermediate recharge', async () => {
    const { adapter, states } = createTracker(initialTrackingStates());

    await applyTransition(adapter, 1_000, 'Mowing', 0);
    await applyTransition(adapter, 2_000, 'Returning', 0);
    await applyTransition(adapter, 3_000, 'TaskPaused', 2);

    assert.equal(states.get(`${BASE}.recharge.candidate`), true);
    assert.equal(states.get(`${BASE}.recharge.candidateSince`), 3_000);

    await applyTransition(adapter, 4_000, 'Mowing', 0);

    assert.equal(states.get(`${BASE}.recharge.confirmedCount`), 1);
    assert.equal(states.get(`${BASE}.recharge.lastConfirmed`), 4_000);
    assert.equal(states.get(`${BASE}.recharge.confirmedDuringTask`), true);
    assert.equal(states.get(`${BASE}.recharge.candidate`), false);
    assert.equal(states.get(`${BASE}.recharge.candidateSince`), 0);

    await applyTransition(adapter, 5_000, 'Returning', 0);
    await applyTransition(adapter, 6_000, 'Standby', 2);

    assert.equal(states.get(`${BASE}.recharge.confirmedCount`), 1);
    assert.equal(states.get(`${BASE}.recharge.mowingSeenSinceIdle`), false);
    assert.equal(states.get(`${BASE}.recharge.confirmedDuringTask`), false);
    assert.equal(states.get(`${BASE}.recharge.candidate`), false);
});

test('TaskPaused without active charging is not an intermediate recharge candidate', async () => {
    const { adapter, states } = createTracker(initialTrackingStates());

    await applyTransition(adapter, 1_000, 'Mowing', 0);
    await applyTransition(adapter, 2_000, 'TaskPaused', 0);

    assert.equal(states.get(`${BASE}.recharge.candidate`), false);
    assert.equal(states.get(`${BASE}.recharge.confirmedCount`), 0);
});

test('v0.0.5 tracking values are reset once while status history remains untouched', async () => {
    const history = '[{"status":"Mowing"}]';
    const { adapter, states } = createTracker(
        initialTrackingStates({
            [`${BASE}.recharge.mowingSeenSinceIdle`]: true,
            [`${BASE}.recharge.candidate`]: true,
            [`${BASE}.recharge.candidateSince`]: 12_345,
            [`${BASE}.recharge.confirmedDuringTask`]: true,
            [`${BASE}.recharge.lastConfirmed`]: 23_456,
            [`${BASE}.recharge.confirmedCount`]: 2,
            [`${BASE}.recharge.trackingVersion`]: 0,
            [`${BASE}.recharge.statusHistoryJson`]: history,
        }),
    );

    await adapter.migrateRechargeTracking(BASE);

    assert.equal(states.get(`${BASE}.recharge.mowingSeenSinceIdle`), false);
    assert.equal(states.get(`${BASE}.recharge.candidate`), false);
    assert.equal(states.get(`${BASE}.recharge.candidateSince`), 0);
    assert.equal(states.get(`${BASE}.recharge.confirmedDuringTask`), false);
    assert.equal(states.get(`${BASE}.recharge.lastConfirmed`), 0);
    assert.equal(states.get(`${BASE}.recharge.confirmedCount`), 0);
    assert.equal(states.get(`${BASE}.recharge.trackingVersion`), 2);
    assert.equal(states.get(`${BASE}.recharge.statusHistoryJson`), history);

    states.set(`${BASE}.recharge.confirmedCount`, 1);
    await adapter.migrateRechargeTracking(BASE);
    assert.equal(states.get(`${BASE}.recharge.confirmedCount`), 1);
});

test('a sleeping mower is migrated without mower detail or plan polling', async () => {
    const sleepingBase = 'mowers.sleeping-device';
    const { adapter, states } = createTracker({
        [`${sleepingBase}.sleep.active`]: true,
        [`${sleepingBase}.recharge.mowingSeenSinceIdle`]: true,
        [`${sleepingBase}.recharge.candidate`]: true,
        [`${sleepingBase}.recharge.candidateSince`]: 12_345,
        [`${sleepingBase}.recharge.confirmedDuringTask`]: true,
        [`${sleepingBase}.recharge.lastConfirmed`]: 23_456,
        [`${sleepingBase}.recharge.confirmedCount`]: 2,
        [`${sleepingBase}.recharge.trackingVersion`]: 0,
    });

    adapter.sleepingMowers = new Set();
    adapter.ensureMowerObjects = async () => {};
    adapter.isSleepProtectionEnabled = () => true;
    adapter.readMower = async () => {
        throw new Error('readMower must not be called during sleeping-mower migration');
    };
    adapter.readPlans = async () => {
        throw new Error('readPlans must not be called during sleeping-mower migration');
    };

    await adapter.restoreSleepStateForKnownMower({ id: 'sleeping-device' });

    assert.equal(adapter.sleepingMowers.has('sleeping-device'), true);
    assert.equal(states.get(`${sleepingBase}.recharge.confirmedCount`), 0);
    assert.equal(states.get(`${sleepingBase}.recharge.candidate`), false);
    assert.equal(states.get(`${sleepingBase}.recharge.trackingVersion`), 2);
});
