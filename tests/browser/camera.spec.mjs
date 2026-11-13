import { test, expect } from '@playwright/test';

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || page.isClosed()) return;
  const state = await page.evaluate(() => {
    const video = document.getElementById('camera');
    return {
      state: document.querySelector('.app')?.dataset.state,
      message: document.getElementById('gate-copy')?.textContent,
      hidden: document.hidden,
      video: video && { readyState: video.readyState, paused: video.paused, width: video.videoWidth, height: video.videoHeight, error: video.error?.message },
      requests: window.cameraHarness?.requests,
      tracks: window.cameraHarness?.tracks.map(track => ({ state: track.readyState, muted: track.muted, enabled: track.enabled })),
    };
  }).catch(error => ({ diagnosticError: error.message }));
  await testInfo.attach('camera-state', { body: JSON.stringify(state, null, 2), contentType: 'application/json' });
});

async function mockCamera(page, options = {}) {
  await page.addInitScript((options) => {
    const harness = window.cameraHarness = {
      requests: [], tracks: [], shareCalls: [], photoRequests: [], failPermission: !!options.denied,
      failPhoto: !!options.failPhoto, shareMode: options.shareMode || 'cancel',
      settings: [], constraintRequests: [], capabilityQueries: [], enumerations: 0,
    };
    function paint(canvas) {
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx.fillStyle = '#318357'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#f02b31'; ctx.fillRect(0, 0, w / 8, h);
      ctx.fillStyle = '#244fe4'; ctx.fillRect(w * 7 / 8, 0, w / 8, h);
      ctx.fillStyle = harness.centerColor || '#f5d146'; ctx.fillRect(w / 2 - h / 10, h / 2 - h / 10, h / 5, h / 5);
    }
    const devices = new EventTarget();
    devices.enumerateDevices = async () => { harness.enumerations += 1; return [
      { kind: 'videoinput', deviceId: 'back', label: 'Back camera' },
      { kind: 'videoinput', deviceId: 'front', label: 'Front camera' },
      { kind: 'videoinput', deviceId: 'wide', label: 'Ultra Wide camera' },
    ]; };
    devices.getUserMedia = async (constraints) => {
      harness.requests.push(constraints);
      if (harness.failPermission) throw new DOMException('Denied', 'NotAllowedError');
      if (options.permissionDelay) await new Promise((resolve) => setTimeout(resolve, options.permissionDelay));
      const canvas = document.createElement('canvas');
      const upgraded = options.upgradeResolution && constraints.video.width?.ideal === 1280;
      canvas.width = upgraded ? 1280 : 640; canvas.height = upgraded ? 960 : 480;
      paint(canvas);
      harness.repaint = () => paint(canvas);
      let stream;
      let timer;
      if (canvas.captureStream) {
        stream = canvas.captureStream(20);
        timer = setInterval(() => paint(canvas), 40);
      } else {
        // Windows WebKit has no media capture backend. Supply only the camera boundary;
        // the actual UI, JPEG encoding, image decode, crop, and service worker still run.
        const track = new EventTarget();
        track.readyState = 'live';
        track.stop = () => { track.readyState = 'ended'; };
        stream = { getTracks: () => [track], getVideoTracks: () => [track] };
        const video = document.getElementById('camera');
        if (!harness.frame) {
          Object.defineProperty(video, 'srcObject', { configurable: true, writable: true, value: null });
          Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });
          Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => harness.frame.width });
          Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => harness.frame.height });
          video.play = () => Promise.resolve();
          const draw = CanvasRenderingContext2D.prototype.drawImage;
          CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
            return draw.call(this, source === video ? harness.frame : source, ...args);
          };
        }
        harness.frame = canvas;
      }
      const track = stream.getVideoTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stop(); };
      const deviceId = constraints.video.deviceId?.exact || (constraints.video.facingMode?.ideal === 'user' ? 'front' : 'back');
      const settings = { width: canvas.width, height: canvas.height, facingMode: deviceId === 'front' ? 'user' : 'environment', deviceId, zoom: 1 };
      let applied = constraints.video;
      track.getSettings = () => ({ ...settings });
      track.getCapabilities = () => ({ width: { max: options.upgradeResolution ? 1280 : 640 }, height: { max: options.upgradeResolution ? 960 : 480 }, ...(options.hardwareZoom ? { zoom: { min: 1, max: 8, step: 0.1 } } : {}) });
      track.getConstraints = () => ({ ...applied });
      track.applyConstraints = async (value) => {
        harness.constraintRequests.push(value);
        if (options.constraintDelay) await new Promise(resolve => setTimeout(resolve, options.constraintDelay));
        applied = value;
        if (options.upgradeResolution && value.width?.ideal === 1280) {
          canvas.width = settings.width = 1280; canvas.height = settings.height = 960;
          paint(canvas);
        }
        if (value.advanced?.[0]?.zoom) {
          if (options.zoomFailure) throw new DOMException('Zoom rejected', 'OverconstrainedError');
          settings.zoom = value.advanced[0].zoom;
        }
      };
      harness.tracks.push(track);
      harness.settings.push(settings);
      return stream;
    };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
    window.ImageCapture = class {
      constructor(track) { this.track = track; }
      async getPhotoCapabilities() {
        harness.capabilityQueries.push(this.track.getSettings().deviceId);
        if (options.capabilityDelay) await new Promise(resolve => setTimeout(resolve, options.capabilityDelay));
        return { imageWidth: { max: 1600 }, imageHeight: { max: 1200 } };
      }
      async takePhoto(settings) {
        harness.photoRequests.push(settings);
        if (options.photoDelay) await new Promise(resolve => setTimeout(resolve, options.photoDelay));
        if (harness.failPhoto) throw new Error('Still photo unavailable');
        const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 1200;
        paint(canvas);
        return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 1));
      }
    };
    if (options.noImageCapture) window.ImageCapture = undefined;
    if (options.encodingDelay) {
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
        setTimeout(() => toBlob.call(this, callback, ...args), options.encodingDelay);
      };
    }
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => !options.noShare });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async ({ files }) => {
      harness.shareCalls.push(files.map((file) => ({ name: file.name, type: file.type, size: file.size })));
      if (harness.shareMode === 'cancel') throw new DOMException('Cancelled', 'AbortError');
      if (harness.shareMode === 'error') throw new Error('Sharing failed');
    } });
  }, options);
}

async function openCamera(page) {
  await page.goto('/Donut_Camera/');
  await page.getByRole('button', { name: 'Open camera' }).click();
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled().catch(async (error) => {
    console.error('Camera startup:', await page.locator('#gate-copy').textContent());
    throw error;
  });
}

test('square framing, high-resolution capture, clean export, cancelled share, and retake', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockCamera(page);
  await openCamera(page);
  const bounds = await page.locator('#viewfinder').boundingBox();
  expect(Math.abs(bounds.width - bounds.height)).toBeLessThan(1);
  await page.screenshot({ path: test.info().outputPath('live-camera.png') });
  await page.getByRole('button', { name: 'Take photo' }).click();
  await expect(page.locator('#photo-size')).toHaveText('1,200 × 1,200 px');
  await expect(page.locator('#guide')).toBeHidden();
  expect(await page.evaluate(() => cameraHarness.photoRequests[0])).toEqual({ imageWidth: 1600, imageHeight: 1200 });
  expect(await page.evaluate(() => cameraHarness.requests[0].audio)).toBe(false);
  expect(await page.evaluate(() => cameraHarness.tracks.filter(track => track.readyState === 'live').length)).toBe(1);
  // The yellow centre must remain in the file, even though the live guide shaded it.
  const pixel = await page.evaluate(() => {
    const image = document.getElementById('photo');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    context.drawImage(image, 599, 599, 1, 1, 0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  });
  expect(pixel[0]).toBeGreaterThan(230);
  expect(pixel[1]).toBeGreaterThan(195);
  await page.getByRole('button', { name: 'Show donut guide' }).click();
  await expect(page.locator('#guide')).toBeVisible();
  await page.getByRole('button', { name: 'Hide donut guide' }).click();
  await expect(page.locator('#guide')).toBeHidden();
  await page.getByRole('button', { name: 'Save photo' }).click();
  await expect(page.locator('#status')).toBeEmpty();
  await expect(page.locator('#photo')).toBeVisible();
  expect(await page.evaluate(() => cameraHarness.shareCalls[0][0].type)).toBe('image/jpeg');
  await page.screenshot({ path: test.info().outputPath('review.png') });
  await page.getByRole('button', { name: 'Retake', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('repeated retakes reuse the prepared camera with only one active track', async ({ page }) => {
  await mockCamera(page);
  await openCamera(page);
  for (let shot = 0; shot < 5; shot += 1) {
    await page.getByRole('button', { name: 'Take photo' }).click();
    await expect(page.locator('#photo')).toBeVisible();
    expect(await page.evaluate(() => cameraHarness.tracks.filter(track => track.readyState === 'live').length)).toBe(1);
    await page.getByRole('button', { name: 'Retake', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled();
    expect(await page.evaluate(() => cameraHarness.tracks.filter(track => track.readyState === 'live').length)).toBe(1);
  }
  expect(await page.evaluate(() => cameraHarness.requests.length)).toBe(1);
  expect(await page.evaluate(() => cameraHarness.capabilityQueries)).toEqual(['back']);
});

test('live-frame capture freezes the shutter pixels before slow encoding at prepared maximum resolution', async ({ page }) => {
  await mockCamera(page, { noImageCapture: true, upgradeResolution: true, constraintDelay: 200, encodingDelay: 400 });
  await openCamera(page);
  expect(await page.evaluate(() => cameraHarness.settings[0].width)).toBe(1280);
  const before = await page.evaluate(() => cameraHarness.constraintRequests.length);
  const snapshot = await page.evaluate(() => {
    document.getElementById('shutter').click();
    const canvas = document.getElementById('frozen-frame');
    const pixel = [...canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data];
    cameraHarness.centerColor = '#2430f0';
    cameraHarness.repaint();
    return { visible: !canvas.hidden, pixel };
  });
  expect(snapshot.visible).toBe(true);
  expect(snapshot.pixel[0]).toBeGreaterThan(230);
  await expect(page.locator('#photo-size')).toHaveText('960 × 960 px');
  const pixel = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(document.getElementById('photo'), 479, 479, 1, 1, 0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  });
  expect(pixel[0]).toBeGreaterThan(230);
  expect(pixel[1]).toBeGreaterThan(195);
  expect(await page.evaluate(() => cameraHarness.constraintRequests.length)).toBe(before);
  await expect(page.locator('#photo-quality')).toContainText('Live frame');
});

test('a slow failed native capture falls back to the original frame without a second exposure', async ({ page }) => {
  await mockCamera(page, { failPhoto: true, photoDelay: 400, capabilityDelay: 200 });
  await openCamera(page);
  expect(await page.evaluate(() => cameraHarness.capabilityQueries)).toEqual(['back']);
  const snapshot = await page.evaluate(() => {
    document.getElementById('shutter').click();
    const requested = cameraHarness.photoRequests.length;
    cameraHarness.centerColor = '#2430f0';
    cameraHarness.repaint();
    return { requested, frozen: !document.getElementById('frozen-frame').hidden };
  });
  expect(snapshot).toEqual({ requested: 1, frozen: true });
  await expect(page.locator('#photo-size')).toHaveText('480 × 480 px');
  const pixel = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(document.getElementById('photo'), 239, 239, 1, 1, 0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  });
  expect(pixel[0]).toBeGreaterThan(230);
  expect(pixel[1]).toBeGreaterThan(195);
  expect(await page.evaluate(() => cameraHarness.photoRequests.length)).toBe(1);
  expect(await page.evaluate(() => cameraHarness.capabilityQueries)).toEqual(['back']);
});

test('returning to a lens reuses its resolution and still settings without enumerating again', async ({ page }) => {
  await mockCamera(page, { capabilityDelay: 200, permissionDelay: 150 });
  await openCamera(page);
  await page.locator('#lens-select').selectOption('wide');
  await expect(page.locator('#capture-label')).toHaveText('Switching camera…');
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled();
  await page.locator('#lens-select').selectOption('back');
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled();
  const stats = await page.evaluate(() => ({
    queries: cameraHarness.capabilityQueries,
    enumerations: cameraHarness.enumerations,
    resolution: cameraHarness.requests.at(-1).video.width.ideal,
    active: cameraHarness.tracks.filter(track => track.readyState === 'live').length,
  }));
  expect(stats).toEqual({ queries: ['back', 'wide'], enumerations: 1, resolution: 640, active: 1 });
});

test('backgrounding photo review stops the retained camera and preserves the photo', async ({ page }) => {
  await mockCamera(page);
  await openCamera(page);
  await page.getByRole('button', { name: 'Take photo' }).click();
  await expect(page.locator('#photo')).toBeVisible();
  const photo = await page.locator('#photo').getAttribute('src');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await page.evaluate(() => cameraHarness.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  await expect(page.locator('#photo')).toHaveAttribute('src', photo);
  await expect(page.getByRole('button', { name: 'Save photo' })).toBeEnabled();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
  await page.getByRole('button', { name: 'Retake', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled();
  expect(await page.evaluate(() => cameraHarness.requests.length)).toBe(2);
});

test('digital zoom is applied to the exported pixels and download fallback works', async ({ page }) => {
  await mockCamera(page, { noShare: true });
  await openCamera(page);
  if (!(await page.locator('#zoom').isVisible())) await page.getByRole('button', { name: 'Adjust zoom', exact: true }).click();
  await page.locator('#zoom').fill('2');
  await page.locator('#zoom').dispatchEvent('input');
  await expect(page.locator('#zoom-value')).toHaveText('2.0×');
  await page.getByRole('button', { name: 'Reset zoom' }).click();
  await expect(page.locator('#zoom-value')).toHaveText('1.0×');
  if (!(await page.locator('#zoom').isVisible())) await page.getByRole('button', { name: 'Adjust zoom', exact: true }).click();
  await page.locator('#zoom').fill('2');
  await page.locator('#zoom').dispatchEvent('input');
  await page.getByRole('button', { name: 'Take photo' }).click();
  await expect(page.locator('#photo-size')).toHaveText('600 × 600 px');
  await page.getByRole('button', { name: 'Save photo' }).click();
  await expect(page.getByRole('link', { name: 'Open image' })).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download JPEG' }).click();
  expect((await downloadEvent).suggestedFilename()).toMatch(/^donut-.*\.jpg$/);
});

test('switching lenses and selfie camera stops old streams and preserves image orientation', async ({ page }) => {
  await mockCamera(page);
  await openCamera(page);
  await page.getByRole('button', { name: 'Switch to selfie camera' }).click();
  await expect(page.getByRole('button', { name: 'Switch to back camera' })).toBeEnabled();
  await expect(page.locator('#camera')).toHaveCSS('transform', 'matrix(-1, 0, 0, 1, 0, 0)');
  expect(await page.evaluate(() => cameraHarness.tracks[0].readyState)).toBe('ended');
  await page.getByRole('button', { name: 'Take photo' }).click();
  await expect(page.locator('#photo')).toBeVisible();
  await expect(page.locator('#photo')).toHaveCSS('transform', 'none');
  await page.getByRole('button', { name: 'New photo' }).click();
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled();
  await page.locator('#lens-select').selectOption('wide');
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled();
  expect(await page.evaluate(() => cameraHarness.requests.at(-1).video.deviceId.exact)).toBe('wide');
});

test('denied camera permission can be retried', async ({ page }) => {
  await mockCamera(page, { denied: true });
  await page.goto('/Donut_Camera/');
  await page.getByRole('button', { name: 'Open camera' }).click();
  await expect(page.locator('#gate-copy')).toContainText('Camera access is off');
  await page.evaluate(() => { cameraHarness.failPermission = false; });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled();
});

test('failed still-photo capture uses a disclosed stream-frame fallback', async ({ page }) => {
  await mockCamera(page, { failPhoto: true });
  await openCamera(page);
  await page.getByRole('button', { name: 'Take photo' }).click();
  await expect(page.locator('#photo-size')).toHaveText('480 × 480 px');
  await expect(page.locator('#photo-quality')).toContainText('Live frame');
});

test('camera zoom uses reported settings without applying a second digital crop', async ({ page }) => {
  await mockCamera(page, { hardwareZoom: true });
  await openCamera(page);
  await expect(page.locator('#zoom-mode')).toHaveText('Camera zoom');
  if (!(await page.locator('#zoom').isVisible())) await page.getByRole('button', { name: 'Adjust zoom', exact: true }).click();
  await page.locator('#zoom').fill('2');
  await page.locator('#zoom').dispatchEvent('input');
  await expect(page.locator('#zoom-value')).toHaveText('2.0×');
  expect(await page.evaluate(() => cameraHarness.settings[0].zoom)).toBe(2);
  await expect(page.locator('#camera')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await page.getByRole('button', { name: 'Take photo' }).click();
  await expect(page.locator('#photo-size')).toHaveText('1,200 × 1,200 px');
});

test('rejected camera zoom falls back to digital zoom', async ({ page }) => {
  await mockCamera(page, { hardwareZoom: true, zoomFailure: true });
  await openCamera(page);
  if (!(await page.locator('#zoom').isVisible())) await page.getByRole('button', { name: 'Adjust zoom', exact: true }).click();
  await page.locator('#zoom').fill('2');
  await page.locator('#zoom').dispatchEvent('input');
  await expect(page.locator('#zoom-mode')).toHaveText('Digital zoom');
  await expect(page.locator('#zoom-value')).toHaveText('1.0×');
});

test('background interruption stops the camera and offers an explicit resume', async ({ page }) => {
  await mockCamera(page);
  await openCamera(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('button', { name: 'Resume camera' })).toBeVisible();
  expect(await page.evaluate(() => cameraHarness.tracks.every((track) => track.readyState === 'ended'))).toBe(true);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
  await page.getByRole('button', { name: 'Resume camera' }).click();
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled();
});

test('a late permission response cannot restart a backgrounded camera', async ({ page }) => {
  await mockCamera(page, { permissionDelay: 400 });
  await page.goto('/Donut_Camera/');
  await page.getByRole('button', { name: 'Open camera' }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => cameraHarness.tracks.length)).toBe(1);
  expect(await page.evaluate(() => cameraHarness.tracks[0].readyState)).toBe('ended');
  await expect(page.getByRole('button', { name: 'Resume camera' })).toBeVisible();
});

test('the app reopens offline, captures a photo, and opens file sharing', async ({ page, context }) => {
  await mockCamera(page);
  await page.goto('/Donut_Camera/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  const details = await page.evaluate(async () => ({
    scope: (await navigator.serviceWorker.ready).scope,
    manifest: await (await fetch('./manifest.webmanifest')).json(),
    caches: await caches.keys(),
  }));
  expect(details.scope).toContain('/Donut_Camera/');
  expect(details.manifest.display).toBe('standalone');
  expect(details.caches.some((key) => key.includes('/Donut_Camera/'))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open camera' })).toBeVisible();
  await page.getByRole('button', { name: 'Open camera' }).click();
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled();
  await page.getByRole('button', { name: 'Take photo' }).click();
  await expect(page.locator('#photo-size')).toHaveText('1,200 × 1,200 px');
  await page.getByRole('button', { name: 'Save photo' }).click();
  expect(await page.evaluate(() => cameraHarness.shareCalls[0][0].type)).toBe('image/jpeg');
});

test('phone and landscape layouts do not overflow', async ({ page }) => {
  await mockCamera(page);
  await page.goto('/Donut_Camera/');
  await page.screenshot({ path: test.info().outputPath('welcome.png') });
  for (const viewport of [{ width: 320, height: 568 }, { width: 440, height: 956 }, { width: 852, height: 393 }, { width: 1094, height: 810 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await page.locator('#viewfinder').boundingBox();
    expect(Math.abs(bounds.width - bounds.height)).toBeLessThan(1);
    const stage = await page.locator('.camera-area').boundingBox();
    expect(Math.abs(bounds.width - Math.min(stage.width, stage.height))).toBeLessThan(1);
    const app = await page.locator('.app').boundingBox();
    expect(app.width).toBe(viewport.width);
    expect(app.height).toBe(viewport.height);
    const panel = await page.locator('.control-panel').boundingBox();
    expect(Math.abs(panel.y + panel.height - viewport.height)).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    const shutter = await page.locator('#shutter').boundingBox();
    expect(shutter.y + shutter.height).toBeLessThanOrEqual(viewport.height);
    if (viewport.width > viewport.height) {
      expect(Math.abs(shutter.y + shutter.height / 2 - viewport.height / 2)).toBeLessThan(1);
    } else {
      expect(viewport.height - shutter.y - shutter.height).toBeLessThan(50);
    }
  }
});

test('EXIF-rotated camera JPEGs are normalized before square cropping', async ({ page }) => {
  await page.goto('/Donut_Camera/');
  const result = await page.evaluate(async () => {
    const { decodePhoto, squareJPEG } = await import('./photo.mjs');
    const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f02020'; ctx.fillRect(0, 0, 60, 80);
    ctx.fillStyle = '#2040f0'; ctx.fillRect(60, 0, 60, 80);
    const original = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 1));
    const bytes = new Uint8Array(await original.arrayBuffer());
    // A one-entry EXIF IFD: orientation 6 rotates the stored landscape image clockwise.
    const exif = new Uint8Array(32);
    exif.set([69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0]);
    const view = new DataView(exif.buffer);
    view.setUint16(16, 0x0112, true); view.setUint16(18, 3, true);
    view.setUint32(20, 1, true); view.setUint16(24, 6, true);
    const rotated = new Blob([bytes.subarray(0, 2), new Uint8Array([255, 225, 0, 34]), exif, bytes.subarray(2)], { type: 'image/jpeg' });
    const photo = await decodePhoto(rotated);
    const exported = await squareJPEG(photo.source, photo.width, photo.height);
    const decoded = await decodePhoto(exported.blob);
    canvas.width = canvas.height = 80;
    ctx.drawImage(decoded.source, 0, 0);
    const top = [...ctx.getImageData(40, 10, 1, 1).data];
    const bottom = [...ctx.getImageData(40, 70, 1, 1).data];
    const result = { width: photo.width, height: photo.height, size: exported.size, top, bottom };
    photo.release(); decoded.release();
    return result;
  });
  expect(result.width).toBe(80);
  expect(result.height).toBe(120);
  expect(result.size).toBe(80);
  expect(result.top[0]).toBeGreaterThan(220);
  expect(result.bottom[2]).toBeGreaterThan(220);
});

test('zoom panel opens on demand and dismisses without resetting the zoom', async ({ page }) => {
  await mockCamera(page);
  await openCamera(page);
  const toggle = page.getByRole('button', { name: 'Adjust zoom', exact: true });
  await expect(page.locator('#zoom')).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#zoom').fill('2');
  await page.locator('#zoom').dispatchEvent('input');
  await page.keyboard.press('Escape');
  await expect(page.locator('#zoom')).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(page.locator('#zoom-value')).toHaveText('2.0×');
  await toggle.click();
  await page.locator('#viewfinder').click();
  await expect(page.locator('#zoom')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#zoom-value')).toHaveText('2.0×');
});

test('two-finger gestures change zoom and release cleanly', async ({ page }) => {
  await mockCamera(page);
  await openCamera(page);
  await page.evaluate(() => {
    const finder = document.getElementById('viewfinder');
    // Synthetic pointer IDs cannot be captured by the browser; preserve gesture handling.
    finder.setPointerCapture = () => {};
    const pointer = (type, id, x) => finder.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: 100, pointerType: 'touch' }));
    pointer('pointerdown', 1, 100); pointer('pointerdown', 2, 150);
    pointer('pointermove', 2, 200);
    pointer('pointerup', 1, 100); pointer('pointerup', 2, 200);
  });
  await expect(page.locator('#zoom-value')).toHaveText('2.0×');
  await page.getByRole('button', { name: 'Take photo' }).click();
  await expect(page.locator('#photo-size')).toHaveText('600 × 600 px');
});

