import { clampZoom } from './geometry.mjs';
import { decodePhoto, squareJPEG, withTimeout } from './photo.mjs';

export function cameraMessage(error) {
  switch (error?.name) {
    case 'NotAllowedError': return 'Camera access is off. Allow camera access in Safari’s website settings, then try again.';
    case 'NotFoundError': return 'No camera was found. Connect a camera or open this app on your iPhone.';
    case 'NotReadableError': return 'The camera is busy. Close other apps using it, then try again.';
    case 'OverconstrainedError': return 'This camera cannot use those settings. Try another camera.';
    case 'SecurityError': return 'Open the app over HTTPS to use your camera.';
    default: return error?.message || 'The camera could not start. Please try again.';
  }
}

export class Camera extends EventTarget {
  constructor(video) {
    super();
    this.video = video;
    this.stream = null;
    this.track = null;
    this.devices = [];
    this.selection = { facing: 'environment' };
    this.facing = 'environment';
    this.generation = 0;
    this.zoom = { mode: 'digital', min: 1, max: 4, step: 0.01, value: 1 };
    this.zoomJob = null;
    this.wantedZoom = null;
  }

  changed() { this.dispatchEvent(new Event('change')); }

  stop() {
    this.generation += 1;
    this.wantedZoom = null;
    this.zoomJob = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = this.track = null;
    this.video.srcObject = null;
  }

  async start(selection = this.selection) {
    this.stop();
    const generation = this.generation;
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      throw new Error('Camera access needs HTTPS. Open the published app in Safari.');
    }
    this.selection = { ...selection };
    const video = {
      width: { ideal: 4096 }, height: { ideal: 3072 },
      aspectRatio: { ideal: 4 / 3 }, frameRate: { ideal: 24, max: 30 },
      ...(selection.deviceId ? { deviceId: { exact: selection.deviceId } } : { facingMode: { ideal: selection.facing || 'environment' } }),
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    } catch (error) {
      if (generation !== this.generation) return false;
      if (error.name !== 'OverconstrainedError') throw error;
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: selection.deviceId
        ? { deviceId: { exact: selection.deviceId } }
        : { facingMode: { ideal: selection.facing || 'environment' } } });
    }
    if (generation !== this.generation || document.hidden) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    const track = this.track;
    this.video.srcObject = stream;
    try {
      await withTimeout(this.video.play(), 12000);
      await this.readyFrame();
      if (generation !== this.generation) return false;
      const settings = track.getSettings();
      this.facing = settings.facingMode || selection.facing || 'environment';
      const capability = track.getCapabilities?.().zoom;
      this.zoom = capability && Number.isFinite(capability.min) && capability.max > capability.min
        ? { mode: 'camera', min: capability.min, max: capability.max, step: capability.step || 0.01, value: settings.zoom ?? capability.min }
        : { mode: 'digital', min: 1, max: 4, step: 0.01, value: 1 };
      await this.refreshDevices();
      if (generation !== this.generation) return false;
      track.addEventListener('ended', () => {
        if (track === this.track) {
          this.stop();
          this.dispatchEvent(new Event('interrupted'));
        }
      });
      this.changed();
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.stop();
      throw error;
    }
  }

  async readyFrame() {
    const started = Date.now();
    while (this.video.readyState < 2 || !this.video.videoWidth || !this.video.videoHeight) {
      if (!this.stream || document.hidden) throw new Error('Camera paused. Tap Resume camera to continue.');
      if (Date.now() - started > 10000) throw new Error('No camera image arrived. Please try again.');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async refreshDevices() {
    try {
      this.devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
    } catch { this.devices = []; }
  }

  setZoom(value) {
    const zoom = this.zoom;
    value = clampZoom(value, zoom.min, zoom.max, zoom.step);
    if (zoom.mode === 'digital') {
      zoom.value = value;
      this.changed();
      return Promise.resolve();
    }
    this.wantedZoom = value;
    if (this.zoomJob) return this.zoomJob;
    const generation = this.generation;
    const track = this.track;
    this.zoomJob = (async () => {
      while (this.wantedZoom !== null && generation === this.generation) {
        const next = this.wantedZoom;
        this.wantedZoom = null;
        try {
          await withTimeout(track.applyConstraints({ ...track.getConstraints(), advanced: [{ zoom: next }] }), 5000);
          if (generation !== this.generation) return;
          const actual = track.getSettings().zoom;
          if (!Number.isFinite(actual) || Math.abs(actual - next) > Math.max(zoom.step, 0.05)) {
            throw new Error('Camera zoom was not applied.');
          }
          zoom.value = actual;
        } catch {
          if (generation !== this.generation) return;
          this.zoom = { mode: 'digital', min: 1, max: 4, step: 0.01, value: 1 };
          this.wantedZoom = null;
        }
        this.changed();
      }
    })().finally(() => { if (generation === this.generation) this.zoomJob = null; });
    return this.zoomJob;
  }

  async capture() {
    await this.zoomJob;
    const track = this.track;
    const generation = this.generation;
    const checkActive = () => {
      if (!track || generation !== this.generation || track.readyState !== 'live' || document.hidden) {
        throw new Error('Capture was interrupted. Resume the camera and try again.');
      }
    };
    checkActive();
    const digitalZoom = this.zoom.mode === 'digital' ? this.zoom.value : 1;
    let photo = null;
    let fallback = false;
    if (typeof window.ImageCapture === 'function') {
      try {
        const capture = new ImageCapture(track);
        let settings = {};
        try {
          const caps = await withTimeout(capture.getPhotoCapabilities(), 4000);
          if (caps.imageWidth?.max > 0) settings.imageWidth = caps.imageWidth.max;
          if (caps.imageHeight?.max > 0) settings.imageHeight = caps.imageHeight.max;
        } catch { /* Some cameras implement takePhoto without capability queries. */ }
        checkActive();
        let blob;
        try {
          blob = await withTimeout(capture.takePhoto(settings), 12000);
        } catch (error) {
          checkActive();
          if (!Object.keys(settings).length) throw error;
          blob = await withTimeout(capture.takePhoto(), 12000);
        }
        checkActive();
        photo = await decodePhoto(blob);
      } catch {
        checkActive();
        fallback = true;
      }
    } else { fallback = true; }

    try {
      if (!photo) {
        // Upgrade fallback frames to the largest stream dimensions the camera exposes.
        const caps = track.getCapabilities?.() || {};
        if (caps.width?.max && caps.height?.max) {
          try {
            await withTimeout(track.applyConstraints({
              ...track.getConstraints(),
              width: { ideal: caps.width.max }, height: { ideal: caps.height.max },
              aspectRatio: { ideal: 4 / 3 },
            }), 5000);
            await new Promise((resolve) => setTimeout(resolve, 150));
          } catch { /* Retain the negotiated stream if the upgrade is rejected. */ }
        }
        checkActive();
        await this.readyFrame();
        photo = { source: this.video, width: this.video.videoWidth, height: this.video.videoHeight, release() {} };
      }
      checkActive();
      const result = await squareJPEG(photo.source, photo.width, photo.height, digitalZoom);
      checkActive();
      return { ...result, fallback, digitalZoom };
    } finally { photo?.release(); }
  }
}
