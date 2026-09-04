'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const config = require(path.join(__dirname, '..', 'admin', 'jsonConfig.json'));

function collectValidatorErrorTexts(value, result = []) {
    if (!value || typeof value !== 'object') return result;

    if (Object.prototype.hasOwnProperty.call(value, 'validatorErrorText')) {
        result.push(value.validatorErrorText);
    }

    for (const child of Object.values(value)) {
        collectValidatorErrorTexts(child, result);
    }
    return result;
}

test('jsonConfig validator error messages use the string type required by ioBroker Admin', () => {
    const messages = collectValidatorErrorTexts(config);

    assert.ok(messages.length > 0, 'expected at least one validatorErrorText');
    for (const message of messages) {
        assert.equal(typeof message, 'string');
        assert.ok(message.trim().length > 0);
    }
});
