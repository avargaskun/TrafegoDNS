// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import DockerMonitor from '../../src/services/DockerMonitor';
import { classifyEvent, HANDLED_ACTIONS } from '../../src/services/DockerMonitor';

const ID = 'c3'.repeat(32);

function modernEvent(action, name = 'app', type = 'container') {
  return {
    Type: type,
    Action: action,
    Actor: { ID, Attributes: { name, image: 'ghcr.io/example/app:1.0' } },
    scope: 'local',
    time: 1757664000,
    timeNano: 1757664000000000000
  };
}

function legacyEvent(action, name = 'app') {
  return { ...modernEvent(action, name), status: action, id: ID, from: 'ghcr.io/example/app:1.0' };
}

test('classifyEvent is exported both as a static method and on the module', () => {
  assert.equal(classifyEvent, DockerMonitor.classifyEvent);
  assert.deepEqual([...HANDLED_ACTIONS].sort(), ['destroy', 'die', 'health_status: healthy', 'start', 'stop']);
});

test('API 1.54 container events are classified with Actor.ID and the container name', () => {
  for (const action of ['start', 'stop', 'die', 'destroy', 'health_status: healthy']) {
    assert.deepEqual(classifyEvent(modernEvent(action)), { action, id: ID, name: 'app' }, action);
  }
});

test('legacy events carrying status, id and from classify identically', () => {
  for (const action of ['start', 'stop', 'die', 'destroy', 'health_status: healthy']) {
    assert.deepEqual(classifyEvent(legacyEvent(action)), classifyEvent(modernEvent(action)), action);
  }
});

test('falls back to status and id when Action and Actor are missing', () => {
  assert.deepEqual(classifyEvent({ Type: 'container', status: 'start', id: ID }), { action: 'start', id: ID, name: 'unknown' });
  assert.deepEqual(classifyEvent({ Type: 'container', Action: 'die' }), { action: 'die', id: null, name: 'unknown' });
});

test('exec, other health states, unhandled actions and non-container events return null', () => {
  for (const action of [
    'exec_create: sh -c true',
    'exec_start: sh -c true',
    'exec_die',
    'health_status: unhealthy',
    'health_status: starting',
    'health_status',
    'create',
    'kill',
    'restart',
    'START'
  ]) {
    assert.equal(classifyEvent(modernEvent(action)), null, action);
  }
  assert.equal(classifyEvent(modernEvent('start', 'app', 'network')), null);
  assert.equal(classifyEvent(modernEvent('start', 'app', 'image')), null);
});

test('malformed input returns null', () => {
  for (const value of [null, undefined, 42, 'start', [], {}, { Type: 'container' }, { Type: 'container', Action: 7 }]) {
    assert.equal(classifyEvent(value), null, JSON.stringify(value));
  }
});
