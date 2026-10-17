import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/nodus/nodus.js', import.meta.url), 'utf8');
function viewer(blocked = false, fetchImpl) {
  const elements = new Map(), timers = new Map();
  let peer, timerId = 0;
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: id !== 'poster', textContent: '', muted: true, videoWidth: 640,
      dataset: {},
      classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {},
      play: () => blocked ? Promise.reject(Object.assign(new Error(), {name:'NotAllowedError'})) : Promise.resolve(),
    });
    return elements.get(id);
  };
  class Peer {
    constructor() { peer = this; this.iceGatheringState = 'complete'; }
    addTransceiver() {}
    async createOffer() { return {}; }
    async setLocalDescription() { this.localDescription = {toJSON: () => ({})}; }
    close() { this.closed = true; }
  }
  const context = vm.createContext({
    document: {getElementById:get}, addEventListener() {},
    setInterval() {}, setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    RTCPeerConnection:Peer, MediaStream: class { addTrack() {} },
    crypto: {randomUUID:()=>'test-view'}, AbortSignal, Date,
    fetch: fetchImpl || (async () => ({ok:true, json:async()=>({iceServers:[]})})),
  });
  vm.runInContext(source, context);
  return { get, timers, context, peer:()=>peer, run: code => vm.runInContext(code, context) };
}
test('negotiated video keeps saved preview until actual playback', async () => {
  const v = viewer(); await v.run('connectVideo()');
  v.peer().ontrack({track:{kind:'video'}});
  assert.equal(v.get('poster').hidden, false);
  assert.notEqual(v.get('video-badge').textContent, 'LIVE');
  v.get('video').onplaying();
  assert.equal(v.get('poster').hidden, true);
  assert.equal(v.get('video-badge').textContent, 'LIVE');
  assert.equal(v.timers.size, 0);
});
test('blocked autoplay offers manual playback without replacing the preview', async () => {
  const v = viewer(true); await v.run('connectVideo()');
  v.peer().ontrack({track:{kind:'video'}});
  await Promise.resolve();
  assert.equal(v.get('play-video').hidden, false);
  assert.equal(v.get('poster').hidden, false);
  for (const timer of v.timers.values()) timer();
  assert.notEqual(v.peer().closed, true);
});
test('a stalled connection closes and schedules a fresh attempt', async () => {
  const v = viewer(); await v.run('connectVideo()');
  for (const timer of [...v.timers.values()]) timer();
  assert.equal(v.peer().closed, true);
  assert.equal(v.get('poster').hidden, false);
  assert.equal(v.run('pc'), null);
  assert.ok(v.run('retryAt') > Date.now());
});

test('video signalling continues while a transcript request is pending', async () => {
  const calls = [];
  const v = viewer(false, async url => {
    calls.push(url);
    return {ok:true, json:async()=>({iceServers:[], messages:[], cursor:12})};
  });
  await v.run('connectVideo()');
  v.run('csrf = "session"; polling = true;');
  await v.run('pollSignals()');
  assert.ok(calls.some(url => url.includes('/signals?after=')));
  assert.equal(v.run('cursor'), 12);
  assert.notEqual(v.peer().closed, true);
});

test('one failed signal read preserves the stream; repeated failures recover', async () => {
  const v = viewer(false, async url => {
    if (url.includes('/signals?')) throw Error('Temporary network failure');
    return {ok:true, json:async()=>({iceServers:[]})};
  });
  await v.run('connectVideo()');
  v.run('csrf = "session"');
  await v.run('pollSignals()');
  assert.notEqual(v.peer().closed, true);
  await v.run('pollSignals()');
  await v.run('pollSignals()');
  assert.equal(v.peer().closed, true);
});
