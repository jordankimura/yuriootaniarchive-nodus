import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/nodus/nodus.js', import.meta.url), 'utf8');
function viewer(blocked = false, fetchImpl) {
  const elements = new Map(), timers = new Map(), domEvents = new Map();
  let peer, timerId = 0;
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: id !== 'poster', textContent: '', muted: true, videoWidth: 640,
      dataset: {},
      children: [], append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
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
    document: {readyState:'loading', addEventListener:(name, handler)=>domEvents.set(name, handler), getElementById:get, createElement:tag=>({tag, children:[], append(...children) { this.children.push(...children); }}), createDocumentFragment:()=>({children:[],append(child) {this.children.push(child);}})}, addEventListener() {},
    setInterval() {}, setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    RTCPeerConnection:Peer, MediaStream: class { addTrack() {} },
    crypto: {randomUUID:()=>'test-view'}, AbortSignal, Date,
    fetch: fetchImpl || (async () => ({ok:true, json:async()=>({iceServers:[]})})),
  });
  vm.runInContext(source, context);
  return { get, timers, domEvents, context, peer:()=>peer, run: code => vm.runInContext(code, context) };
}

const session = {csrf:'session', name:'Visitor', roomOpen:true, videoAvailable:true, queue:[], mine:[], transcript:[]};

test('reply indicators distinguish deliberate quiet from uncertainty and clear on idle', () => {
  const v=viewer();
  for(const [state,label] of [['working','Working'],['quiet','Deliberately quiet'],['failed','Failed'],['unknown','Unknown']]) {
    v.run(`showActivity({state:${JSON.stringify(state)}})`);
    assert.equal(v.get('turn-state-label').textContent,label);
    assert.equal(v.get('turn-status').hidden,false);
  }
  v.run('showActivity({state:"idle"})');
  assert.equal(v.get('turn-status').hidden,true);
  v.context.legacy={...session,videoAvailable:false,mine:[{id:'old',status:'failed',error:'Could not finish'}]};
  v.run('render(legacy)');
  assert.equal(v.get('turn-state-label').textContent,'Unknown');
  assert.match(v.get('notice').textContent,/unknown/);
});

test('opening the page automatically loads chat and starts muted video', async () => {
  const calls = [];
  const v = viewer(false, async url => {
    calls.push(url);
    return {ok:true, json:async()=>url.endsWith('/session') ? session : {iceServers:[]}};
  });
  v.domEvents.get('DOMContentLoaded')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(url=>url.endsWith('/session')).length, 1);
  assert.ok(calls.includes('/api/nodus/signal'));
  assert.equal(v.get('join').hidden, true);
  assert.equal(v.get('message-form').hidden, false);
  assert.equal(v.get('send').disabled, false);
  assert.equal(v.get('video').muted, true);
});

test('session attempts do not overlap and failed startup retries automatically', async () => {
  let rejectRequest, count = 0;
  const v = viewer(false, () => {
    count++;
    return new Promise((resolve, reject) => { rejectRequest = reject; });
  });
  const attempt = v.run('join()');
  await v.run('pollRoom()');
  assert.equal(count, 1);
  rejectRequest(Error('Temporary outage'));
  await attempt;
  await v.run('pollRoom()');
  assert.equal(count, 1);
  assert.equal(v.get('join').hidden, false);
  v.run('sessionRetryAt = 0');
  const retry = v.run('pollRoom()');
  assert.equal(count, 2);
  rejectRequest(Error('Temporary outage'));
  await retry;
});

test('expired sessions reconnect without a click and preserve the draft', async () => {
  const v = viewer(false, async url => url.endsWith('/state')
    ? {ok:false, status:401, json:async()=>({error:'Expired'})}
    : {ok:true, json:async()=>({...session, videoAvailable:false})});
  v.run('csrf="expired"');
  v.get('message').value = 'My unfinished message';
  await v.run('pollRoom()');
  assert.equal(v.run('csrf'), 'session');
  assert.equal(v.get('presence').textContent, 'OPEN');
  assert.equal(v.get('message').value, 'My unfinished message');
  assert.equal(v.get('send').disabled, false);
});

test('public disclosure is static and separate from live connection notices', () => {
  const html = fs.readFileSync(new URL('../public/nodus/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="privacy-note"[^>]*>\s*A shared, public conversation\. Please keep personal details\s+private\./);
  assert.match(html, /id="notice"[^>]*hidden><\/p>/);
  assert.doesNotMatch(source, /\$\("privacy-note"\)/);
});
test('negotiated video keeps saved preview until actual playback', async () => {
  const v = viewer(); await v.run('connectVideo()');
  assert.equal(v.get('video-loading').hidden, false);
  v.peer().ontrack({track:{kind:'video'}});
  assert.equal(v.get('poster').hidden, false);
  assert.notEqual(v.get('video-badge').textContent, 'LIVE');
  v.get('video').onplaying();
  assert.equal(v.get('poster').hidden, true);
  assert.equal(v.get('video-badge').textContent, 'LIVE');
  assert.equal(v.get('video-loading').hidden, true);
  assert.equal(v.timers.size, 0);
});
test('blocked autoplay offers manual playback without replacing the preview', async () => {
  const v = viewer(true); await v.run('connectVideo()');
  v.peer().ontrack({track:{kind:'video'}});
  await Promise.resolve();
  assert.equal(v.get('play-video').hidden, false);
  assert.equal(v.get('video-loading').hidden, true);
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

test('chat clears at 30 idle minutes, preserves active replies, and starts fresh after a gap', () => {
  const v = viewer();
  assert.equal(v.run('transcriptForDisplay({transcript:[{at:100}], current:null, queue:[]}, 1800100).length'), 0);
  assert.equal(v.run('transcriptForDisplay({transcript:[{at:100}], current:{}, queue:[]}, 1800100).length'), 1);
  assert.equal(v.run('transcriptForDisplay({transcript:[{at:100},{at:1800100}], current:null, queue:[]}, 1800200).length'), 1);
});

test('successful polling clears a stale network error and renders message timestamps', async () => {
  let fail = true;
  const message = {name:'Nodus', role:'nodus', text:'Hello', at:Date.now()};
  const state = {roomOpen:true, videoAvailable:false, queue:[], mine:[], transcript:[message]};
  const v = viewer(false, async () => {
    if (fail) throw Error('Network unavailable');
    return {ok:true,json:async()=>state};
  });
  v.run('csrf="session"');
  await v.run('pollRoom()');
  assert.equal(v.get('presence').textContent, 'RECONNECTING');
  fail = false;
  await v.run('pollRoom()');
  assert.equal(v.get('presence').textContent, 'OPEN');
  assert.match(v.get('notice').textContent, /Connection restored/);
  const timestamp = v.get('transcript').children[0].children[0].children[0].children[1];
  assert.equal(timestamp.tag, 'time');
  assert.equal(timestamp.dateTime, new Date(message.at).toISOString());
  state.transcript = [];
  await v.run('pollRoom()');
  assert.match(v.get('transcript').children[0].textContent, /fresh conversation/);
});
