import { Camera, cameraMessage } from './camera.mjs';
import { photoFile } from './photo.mjs';

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
const camera = new Camera($('camera'));
let state = 'idle';
let operation = 0;
let currentPhoto = null;
let showGuide = false;
let sharing = false;
let zoomOpen = false;

function status(message = '') { $('status').textContent = message; }

function render() {
  app.dataset.state = state;
  const live = state === 'live';
  const review = state === 'review';
  const capturing = state === 'capturing';
  const gate = ['idle', 'starting', 'error', 'paused'].includes(state);
  if (!live) zoomOpen = false;
  $('camera-gate').hidden = !gate;
  $('camera').hidden = review;
  $('photo').hidden = !review;
  $('ambient-camera').hidden = review;
  $('ambient-photo').hidden = !review;
  $('live-controls').hidden = review;
  $('review-controls').hidden = !review;
  $('capture-progress').hidden = !capturing;
  $('guide-toggle').hidden = !review;
  $('guide-toggle').setAttribute('aria-pressed', String(showGuide));
  $('guide-toggle').setAttribute('aria-label', showGuide ? 'Hide donut guide' : 'Show donut guide');
  $('guide').toggleAttribute('hidden', review && !showGuide);
  $('shutter').disabled = !live;
  $('flip-button').disabled = !live;
  $('lens-select').disabled = !live || camera.devices.length < 2;
  $('zoom').disabled = !live;
  $('reset-zoom').disabled = !live;
  $('zoom-toggle').disabled = !live;
  $('zoom-toggle').setAttribute('aria-expanded', String(zoomOpen));
  $('zoom-panel').hidden = !zoomOpen;
  document.querySelector('.lens-picker').hidden = review;
  $('start-button').disabled = state === 'starting';
  $('start-label').textContent = state === 'starting' ? 'Opening camera…' : state === 'paused' ? 'Resume camera' : state === 'error' ? 'Try again' : 'Open camera';
  $('save-button').disabled = sharing;
  $('retake-button').disabled = sharing;
  $('new-button').disabled = sharing;
  $('gate-copy').hidden = !$('gate-copy').textContent;
}

function renderCamera() {
  const zoom = camera.zoom;
  $('zoom').min = zoom.min;
  $('zoom').max = zoom.max;
  $('zoom').step = zoom.step;
  $('zoom').value = zoom.value;
  $('zoom').setAttribute('aria-valuetext', `${zoom.value.toFixed(1)} times ${zoom.mode} zoom`);
  $('zoom-value').textContent = `${zoom.value.toFixed(1)}×`;
  $('zoom-mode').textContent = zoom.mode === 'camera' ? 'Camera zoom' : 'Digital zoom';
  $('camera').style.setProperty('--digital-zoom', zoom.mode === 'digital' ? zoom.value : 1);
  $('camera').style.setProperty('--mirror', camera.facing === 'user' ? -1 : 1);
  $('ambient-camera').style.transform = camera.facing === 'user' ? 'scaleX(-1)' : '';
  $('flip-button').setAttribute('aria-label', camera.facing === 'user' ? 'Switch to back camera' : 'Switch to selfie camera');
}

function renderLenses() {
  const select = $('lens-select');
  const selectedId = camera.track?.getSettings().deviceId;
  select.replaceChildren();
  camera.devices.forEach((device, index) => {
    const option = new Option(device.label || `Camera ${index + 1}`, device.deviceId);
    option.selected = selectedId === device.deviceId;
    select.add(option);
  });
  if (!select.options.length) select.add(new Option(camera.facing === 'user' ? 'Selfie camera' : 'Back camera', ''));
}

function releasePhoto() {
  if (currentPhoto) URL.revokeObjectURL(currentPhoto.url);
  currentPhoto = null;
  $('photo').removeAttribute('src');
  $('ambient-photo').removeAttribute('src');
  $('open-image').removeAttribute('href');
  $('download-image').removeAttribute('href');
  $('save-fallback').hidden = true;
}

async function startCamera(selection = camera.selection) {
  const token = ++operation;
  state = 'starting';
  $('ambient-camera').srcObject = null;
  $('gate-copy').textContent = '';
  status();
  render();
  // Commit the preview's restored visibility before WebKit attaches a new stream.
  $('camera').getBoundingClientRect();
  try {
    const started = await camera.start(selection);
    if (token !== operation || !started) return;
    state = 'live';
    // Reuse the same stream for a dim backdrop outside the actual square crop.
    // This layer is purely presentational and never enters the exported image.
    if (typeof MediaStream !== 'undefined' && camera.stream instanceof MediaStream) {
      $('ambient-camera').srcObject = camera.stream;
      $('ambient-camera').play().catch(() => {});
    }
    renderLenses();
    renderCamera();
    try { localStorage.setItem('donut-camera-started', 'yes'); } catch { /* Optional convenience. */ }
  } catch (error) {
    if (token !== operation) return;
    state = 'error';
    $('gate-copy').textContent = cameraMessage(error);
  }
  render();
}

async function capture() {
  if (state !== 'live') return;
  const token = ++operation;
  state = 'capturing';
  status();
  render();
  try {
    const result = await camera.capture();
    if (token !== operation) return;
    const file = photoFile(result.blob);
    releasePhoto();
    currentPhoto = { ...result, file, url: URL.createObjectURL(result.blob) };
    $('photo').src = currentPhoto.url;
    $('ambient-photo').src = currentPhoto.url;
    await $('photo').decode();
    if (token !== operation) { releasePhoto(); return; }
    camera.stop();
    $('ambient-camera').srcObject = null;
    $('photo-size').textContent = `${result.size.toLocaleString()} × ${result.size.toLocaleString()} px`;
    $('photo-quality').textContent = 'JPEG';
    $('open-image').href = $('download-image').href = currentPhoto.url;
    $('download-image').download = file.name;
    showGuide = false;
    state = 'review';
    status(result.fallback
      ? 'Captured from the live camera frame. Full-resolution still capture wasn’t available for this shot.'
      : '');
    render();
    $('save-button').focus({ preventScroll: true });
  } catch (error) {
    if (token !== operation) return;
    releasePhoto();
    state = camera.track?.readyState === 'live' ? 'live' : 'error';
    if (state === 'error') {
      $('gate-copy').textContent = cameraMessage(error);
    }
    status(cameraMessage(error));
    render();
  }
}

async function savePhoto() {
  if (!currentPhoto || sharing) return;
  const files = [currentPhoto.file];
  if (!navigator.share || !navigator.canShare?.({ files })) {
    $('save-fallback').hidden = false;
    status('Open the image to save to Photos, or download a JPEG copy.');
    return;
  }
  sharing = true;
  render();
  status('Choose Save Image in the share sheet to add this photo to Photos.');
  try {
    // The file is already encoded: call share directly from the tap, before any await.
    await navigator.share({ files });
    status();
  } catch (error) {
    if (error.name === 'AbortError') status();
    else {
      $('save-fallback').hidden = false;
      status('Sharing couldn’t open. You can open or download the image below.');
    }
  } finally { sharing = false; render(); }
}

function pauseCamera() {
  if (!['live', 'starting', 'capturing'].includes(state)) return;
  operation += 1;
  camera.stop();
  $('ambient-camera').srcObject = null;
  state = 'paused';
  $('gate-copy').textContent = '';
  status();
  render();
}

$('start-button').addEventListener('click', () => startCamera());
$('shutter').addEventListener('click', capture);
$('save-button').addEventListener('click', savePhoto);
for (const id of ['retake-button', 'new-button']) {
  $(id).addEventListener('click', () => { releasePhoto(); startCamera(); });
}
$('flip-button').addEventListener('click', () => startCamera({ facing: camera.facing === 'user' ? 'environment' : 'user' }));
$('lens-select').addEventListener('change', (event) => startCamera({ deviceId: event.target.value }));
$('zoom').addEventListener('input', (event) => camera.setZoom(event.target.value));
$('reset-zoom').addEventListener('click', () => camera.setZoom(1));
$('zoom-toggle').addEventListener('click', () => { zoomOpen = !zoomOpen; render(); });
document.addEventListener('pointerdown', (event) => {
  if (zoomOpen && !event.target.closest('#zoom-panel, #zoom-toggle')) {
    zoomOpen = false;
    render();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && zoomOpen) {
    zoomOpen = false;
    render();
    $('zoom-toggle').focus({ preventScroll: true });
  }
});
$('guide-toggle').addEventListener('click', () => { showGuide = !showGuide; render(); });
camera.addEventListener('change', renderCamera);
camera.addEventListener('interrupted', pauseCamera);
navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  if (state !== 'live') return;
  await camera.refreshDevices();
  renderLenses();
  render();
});

// Pinch only affects the viewfinder; normal page accessibility zoom remains available elsewhere.
const pointers = new Map();
let pinchStart = null;
const distance = () => {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
};
$('viewfinder').addEventListener('pointerdown', (event) => {
  if (state !== 'live') return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  $('viewfinder').setPointerCapture(event.pointerId);
  if (pointers.size === 2) pinchStart = { distance: distance(), zoom: camera.zoom.value };
});
$('viewfinder').addEventListener('pointermove', (event) => {
  if (!pointers.has(event.pointerId) || state !== 'live') return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2 && pinchStart?.distance) camera.setZoom(pinchStart.zoom * distance() / pinchStart.distance);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  $('viewfinder').addEventListener(type, (event) => { pointers.delete(event.pointerId); pinchStart = null; });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { pointers.clear(); pinchStart = null; pauseCamera(); }
});
window.addEventListener('pagehide', () => { pauseCamera(); camera.stop(); });

$('help-button').addEventListener('click', () => $('help-dialog').showModal());
$('close-help').addEventListener('click', () => $('help-dialog').close());
$('help-dialog').addEventListener('click', (event) => { if (event.target === $('help-dialog')) {
  const box = $('help-dialog').getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('help-dialog').close();
} });

render();
try { if (localStorage.getItem('donut-camera-started') === 'yes') startCamera(); } catch { /* Storage is optional. */ }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then(async () => {
    await navigator.serviceWorker.ready;
    $('offline-status').textContent = 'Ready to open offline. Updates apply after you close all app windows.';
  }).catch(() => { $('offline-status').textContent = 'Offline access is unavailable. The camera still works while this page is open.'; });
} else { $('offline-status').textContent = 'Offline access is unavailable in this browser.'; }
