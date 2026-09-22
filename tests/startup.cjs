const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(source => source.includes('async function StartAR'));
assert.ok(script, 'Startup script exists');

function setup(failure) {
    const nodes = {};
    const events = [];
    const track = { label: 'Rear camera', stop: () => events.push('stop') };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    function element(id) {
        return nodes[id] ||= {
            style: {}, options: [], value: '',
            appendChild(option) { this.options.push(option); },
            set innerHTML(value) { this.html = value; this.options = []; },
            get innerHTML() { return this.html; },
            play: async () => events.push('play')
        };
    }
    const context = {
        console: { log() {}, error() {}, warn() {} },
        document: {
            querySelector: element, getElementById: element,
            createElement: () => ({})
        },
        navigator: { mediaDevices: {
            enumerateDevices: async () => [],
            getUserMedia: async settings => {
                events.push('permission');
                if (failure === 'permission') {
                    throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
                }
                return stream;
            }
        } },
        iTracker: { startWebcam: async () => {
            events.push('tracker');
            if (failure === 'tracker') throw Error('tracker failed');
        } },
        createUnityInstance: async () => {
            events.push('unity');
            if (failure === 'unity') throw Error('Unity failed');
            return {};
        }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(script, context);
    return { context, nodes, events };
}

function testResizeRouting() {
    const initialScript = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
        .map(match => match[1]).find(source => source.includes('const resizeActiveTracker'));
    assert.ok(initialScript, 'Tracker resize guard exists');
    const events = [];
    class FakeTracker {
        initialize() { return Promise.resolve(); }
        resize() { events.push('resize'); }
        resizeWithDelay(event) { events.push({ tracker: this, event }); }
    }
    const context = {
        ImageTracker: FakeTracker,
        console: { log() {}, error() {} },
        document: { querySelector() { return {}; }, getElementById() { return { style: {} }; } },
        LoadWebcams: async () => {},
        ShowError(error) { throw Error(error); }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(initialScript, context);
    const tracker = context.iTracker;
    const event = { type: 'resize' };
    tracker.resizeWithDelay(event);
    assert.deepEqual(events, []);
    tracker.VIDEO = {};
    tracker.isStarted = false;
    tracker.resizeWithDelay(event);
    assert.deepEqual(events, ['resize']);
    tracker.isStarted = true;
    tracker.resizeWithDelay(event);
    assert.equal(events.length, 2);
    assert.equal(events[1].tracker, tracker);
    assert.equal(events[1].event, event);
    console.log('PASS resize ignores missing video, resizes menu only, and preserves active tracker handler');
}

async function main() {
    testResizeRouting();
    let test = setup();
    await test.context.LoadWebcams();
    assert.equal(test.nodes.chooseCamSel.options.length, 1);
    assert.equal(test.nodes.chooseCamSel.options[0].value, '');
    console.log('PASS empty camera list keeps automatic option');

    await Promise.all([test.context.StartAR(), test.context.StartAR()]);
    assert.deepEqual(test.events, ['permission', 'play', 'unity', 'tracker']);
    await test.context.StartAR();
    assert.deepEqual(test.events, ['permission', 'play', 'unity', 'tracker']);
    console.log('PASS permission precedes Unity; concurrent and completed starts are guarded');

    for (const failure of ['permission', 'unity', 'tracker']) {
        test = setup(failure);
        await test.context.StartAR();
        assert.equal(test.nodes.errorDiv.style.display, 'flex');
        assert.equal(test.nodes['#unity-loading-bar'].style.display, 'none');
        assert.equal(test.events.includes('stop'), failure !== 'permission');
        if (failure === 'permission') {
            assert.match(test.nodes.errorText.textContent, /permission was denied/);
            assert.equal(test.events.includes('unity'), false);
        }
        if (failure === 'unity') assert.equal(test.events.includes('tracker'), false);
        console.log(`PASS ${failure} failure reports error and cleans up`);
    }

    test = setup();
    test.context.navigator.mediaDevices.enumerateDevices = async () => { throw Error('denied'); };
    await test.context.LoadWebcams();
    assert.equal(test.nodes.chooseCamSel.options.length, 1);
    console.log('PASS denied enumeration keeps automatic option');

    test = setup();
    test.context.navigator.mediaDevices.enumerateDevices = async () => [
        { kind: 'audioinput', deviceId: 'mic', label: 'Microphone' },
        { kind: 'videoinput', deviceId: 'rear-2', label: 'Rear camera' }
    ];
    await test.context.LoadWebcams();
    assert.equal(test.nodes.chooseCamSel.options.length, 2);
    assert.equal(test.nodes.chooseCamSel.style.display, 'block');
    test.nodes.chooseCamSel.value = 'rear-2';
    test.context.SelectCam();
    assert.equal(test.context.WEBCAM_SETTINGS.video.deviceId.exact, 'rear-2');
    test.nodes.chooseCamSel.value = '';
    test.context.SelectCam();
    assert.equal(test.context.WEBCAM_SETTINGS.video.facingMode, 'environment');
    assert.equal(test.context.WEBCAM_SETTINGS.video.deviceId, undefined);
    console.log('PASS explicit camera selection and automatic reset');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
