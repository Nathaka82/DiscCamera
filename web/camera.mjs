import { clampZoom } from './geometry.mjs';
import { decodePhoto, squareFrame, squareJPEG, encodeJPEG, withTimeout } from './photo.mjs';

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
    this.profiles = new Map();
    this.selectionProfiles = new Map();
    this.prepared = false;
    this.photoCapture = null;
    this.photoSettings = {};
  }

  changed() { this.dispatchEvent(new Event('change')); }

  stop() {
    this.generation += 1;
    this.wantedZoom = null;
    this.zoomJob = null;
    this.prepared = false;
    this.photoCapture = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = this.track = null;
    this.video.srcObject = null;
  }

  async start(selection = this.selection) {
    const current = this.track?.getSettings();
    const sameCamera = selection.deviceId ? selection.deviceId === current?.deviceId : selection.facing === this.facing;
    if (this.prepared && this.track?.readyState === 'live' && sameCamera && !document.hidden) {
      await withTimeout(this.video.play(), 12000);
      await this.readyFrame();
      return true;
    }
    this.stop();
    const generation = this.generation;
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      throw new Error('Camera access needs HTTPS. Open the published app in Safari.');
    }
    this.selection = { ...selection };
    const selectionKey = selection.deviceId || `facing:${selection.facing || 'environment'}`;
    const knownProfile = this.profiles.get(this.selectionProfiles.get(selectionKey) || selectionKey);
    const video = {
      width: { ideal: knownProfile?.width || 4096 }, height: { ideal: knownProfile?.height || 3072 },
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
    try {
      const deviceKey = track.getSettings().deviceId || selectionKey;
      const profile = this.profiles.get(deviceKey);
      const devicesReady = this.devices.length ? Promise.resolve() : this.refreshDevices();
      const prepared = await this.prepareCapture(track, profile);
      if (generation !== this.generation) return false;
      this.profile = prepared.profile;
      this.photoCapture = prepared.capture;
      this.photoSettings = prepared.profile.photoSettings;
      this.profiles.set(deviceKey, prepared.profile);
      this.selectionProfiles.set(selectionKey, deviceKey);
      this.video.srcObject = stream;
      await withTimeout(this.video.play(), 12000);
      await this.readyFrame();
      if (generation !== this.generation) return false;
      const settings = track.getSettings();
      this.facing = settings.facingMode || selection.facing || 'environment';
      const capability = track.getCapabilities?.().zoom;
      this.zoom = capability && Number.isFinite(capability.min) && capability.max > capability.min
        ? { mode: 'camera', min: capability.min, max: capability.max, step: capability.step || 0.01, value: settings.zoom ?? capability.min }
        : { mode: 'digital', min: 1, max: 4, step: 0.01, value: 1 };
      await devicesReady;
      if (generation !== this.generation) return false;
      track.addEventListener('ended', () => {
        if (track === this.track) {
          this.stop();
          this.dispatchEvent(new Event('interrupted'));
        }
      });
      this.prepared = true;
      this.changed();
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.stop();
      throw error;
    }
  }

  async prepareCapture(track, cached) {
    let capture = null;
    if (!cached?.stillUnavailable && typeof window.ImageCapture === 'function') {
      try { capture = new ImageCapture(track); } catch { /* Use the prepared live frame. */ }
    }
    // Query still dimensions while configuring the stream, never on the shutter path.
    const photoSettings = cached ? Promise.resolve(cached.photoSettings) : (async () => {
      if (!capture) return {};
      try {
        const caps = await withTimeout(capture.getPhotoCapabilities(), 4000);
        return {
          ...(caps.imageWidth?.max > 0 ? { imageWidth: caps.imageWidth.max } : {}),
          ...(caps.imageHeight?.max > 0 ? { imageHeight: caps.imageHeight.max } : {}),
        };
      } catch { return {}; }
    })();
    if (!cached) {
      const caps = track.getCapabilities?.() || {};
      const settings = track.getSettings();
      if (caps.width?.max > settings.width || caps.height?.max > settings.height) {
        try {
          await withTimeout(track.applyConstraints({
            ...track.getConstraints(),
            ...(caps.width?.max ? { width: { ideal: caps.width.max } } : {}),
            ...(caps.height?.max ? { height: { ideal: caps.height.max } } : {}),
          }), 5000);
        } catch { /* Keep the highest dimensions successfully negotiated by the camera. */ }
      }
    }
    const settings = track.getSettings();
    return { capture, profile: { ...cached, width: settings.width, height: settings.height, photoSettings: await photoSettings } };
  }

  frame(maxSize = Infinity) {
    return squareFrame(this.video, this.video.videoWidth, this.video.videoHeight,
      this.zoom.mode === 'digital' ? this.zoom.value : 1, maxSize);
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

  async capture(onFrame = () => {}, onProcessing = () => {}) {
    const track = this.track;
    const generation = this.generation;
    const checkActive = () => {
      if (!track || generation !== this.generation || track.readyState !== 'live' || document.hidden) {
        throw new Error('Capture was interrupted. Resume the camera and try again.');
      }
    };
    checkActive();
    // Copy the pixels synchronously, before any promise, encoding, or hardware call.
    // A failed/unsupported still capture always uses this exact shutter-time frame.
    const frozen = this.frame();
    const digitalZoom = this.zoom.mode === 'digital' ? this.zoom.value : 1;
    const still = this.zoomJob ? null : this.photoCapture;
    let photo = null;
    try {
      onFrame(frozen, !!still);
      if (still) {
        try {
          const blob = await withTimeout(still.takePhoto(this.photoSettings), 12000);
          checkActive();
          photo = await decodePhoto(blob);
        } catch (error) {
          checkActive();
          // Do not take a second, later exposure. Keep the original frame instead.
          if (error.name === 'OverconstrainedError' && Object.keys(this.photoSettings).length) {
            this.photoSettings = this.profile.photoSettings = {};
          } else {
            this.photoCapture = null;
            this.profile.stillUnavailable = true;
          }
        }
      }
      checkActive();
      onProcessing();
      const result = photo
        ? await squareJPEG(photo.source, photo.width, photo.height, digitalZoom)
        : await encodeJPEG(frozen);
      checkActive();
      return { ...result, fallback: !photo, digitalZoom };
    } finally {
      photo?.release();
      frozen.width = frozen.height = 1;
    }
  }
}
