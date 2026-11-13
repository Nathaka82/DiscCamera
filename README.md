# Donut Camera

A small, private camera PWA for taking square photos to print on donuts. Built for iPhone, with no runtime dependencies, accounts, uploads, or backend.

- Fixed donut guide: the centre hole radius is **41% of the outer radius**. The outer circle touches the square's edges.
- Rear camera, selfie camera, and the lenses your browser exposes.
- Pinch/slider zoom: camera zoom when supported, digital crop otherwise.
- Full-screen responsive layout: compact bottom controls in portrait, a narrow control rail in landscape, and a square viewfinder sized to the available space. Tap the zoom value to open the slider; Reset returns to 1× (or the camera's nearest supported value).
- Maximum browser-exposed still-photo dimensions, square JPEG export, and no upscaling.
- Clean exports without the guide, plus review, retake, and iPhone file sharing.
- Home Screen installation and an offline app shell.

## Run locally

Use Node.js 22 or later:

```sh
npm ci
npm run dev
```

The server binds to **0.0.0.0:4173** by default. Open **http://127.0.0.1:4173/** on this computer, or **http://YOUR-COMPUTER-IP:4173/** from another device on your network. To restrict it to this computer, use `npm run dev -- --host=127.0.0.1`.

The app itself needs no package installation; `npm ci` installs the browser test tools. Camera APIs work on localhost or HTTPS. An ordinary HTTP address on your local network will not enable the camera on your iPhone; use the HTTPS GitHub Pages URL for phone testing.

```sh
npm run build
node scripts/serve.mjs --dir=dist
```

`build` copies the static app into `dist/` and assigns the service worker a content-based cache version. It does not transpile or bundle the app. The preview server also serves `/Donut_Camera/` to exercise repository subpaths. Only `dist/` is published; source files, tests, and dependencies are excluded.

## Publish on GitHub Pages

1. Create a GitHub repository and push this project to its `main` or `master` branch, including the `.github` directory and `package-lock.json`.
2. In the repository, open **Settings → Pages**, then select **GitHub Actions** as the source.
3. Run **Deploy Donut Camera** from the Actions tab, or push a change. The workflow tests the app, builds `dist/`, and deploys it to Pages.
4. Open the URL shown by the deployment. For a repository named `Donut_Camera`, it is normally `https://YOUR-USERNAME.github.io/Donut_Camera/`.

All assets, the manifest, and service-worker scope use relative paths, so a different repository name or a root-domain Pages site also works. No secrets or backend configuration are required. If the repository uses a different default branch, update the workflow's branch filter. The workflow follows [GitHub's custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

No GitHub repository or remote was supplied in this workspace, so this implementation includes deployment setup but does not create or publish a repository.

## Use on iPhone

1. Open the HTTPS app URL in Safari and allow camera access.
2. For installation, use Safari's Share menu → **Add to Home Screen**. Enable **Open as Web App** if shown.
3. Choose a lens at the top or switch to the selfie camera beside the shutter. Keep the important parts of the photo inside the clear ring. Pinch to zoom, or tap the zoom value to open the slider.
4. Tap the shutter. In review, the **Guide** button lets you check the composition without modifying the photo.
5. Tap **Save photo**, then choose **Save Image** in the iPhone share sheet. If file sharing is unavailable, use **Open image** and touch and hold it to save, or download a JPEG to Files.

Cancelling the share sheet keeps the photo ready to save again. The browser cannot confirm which share destination you chose. **Retake** and **New photo** discard the in-memory image and reopen the camera. Save before reloading, closing the app, or taking another picture. The app does not maintain a gallery.

After successful first loading and caching, the app opens offline. It stops camera tracks when backgrounded, with an explicit **Resume camera** action on return. Updates wait until all windows of the app are closed, so they do not reload a photo you are reviewing. iOS can reclaim website storage; reopen online if the offline cache has been removed.

## Resolution and device limitations

The app calls `ImageCapture.getPhotoCapabilities()` and requests the largest reported width and height via `takePhoto()`. If explicit dimensions are rejected, it retries the camera's default still capture. If still capture is unavailable, it uses the largest negotiated live-camera frame and labels that fallback in review.

The output is an orientation-normalized, centred square, encoded as JPEG at quality `1`. Its edge length is the source's shorter edge divided by digital zoom, rounded down. For example, a 4032 × 3024 source produces 3024 × 3024 pixels at 1× digital zoom, or 1512 × 1512 pixels at 2×. Camera zoom is applied by the camera and is not cropped a second time. Review shows the actual exported dimensions.

Browser access is not a guarantee of the iPhone's advertised sensor resolution or the native Camera app's processing. A camera may expose physical or virtual lenses; labels come from the browser and do not claim unverified optical magnifications. The selfie preview is mirrored, while review and export are unmirrored. Different hardware still/preview fields of view must be checked on the phone.

## Verify

```sh
npm test
npx playwright install chromium webkit
npm run test:browser
```

Unit tests cover geometry, zoom limits, filenames, manifest paths, and PNG dimensions. Browser tests run in Chromium and WebKit with simulated cameras and share sheets, covering capture/export, clean centre pixels, EXIF orientation, pinch gestures, camera switching, permission recovery, native/digital zoom, still-capture fallback, background interruption, late permission responses, offline subpath loading, and layout.

The browser test server uses port 4174 on localhost so it can run alongside the development server on port 4173.

Windows WebKit has no canvas-stream camera backend, so its test fixture substitutes that media boundary while the actual app, JPEG encoder, image decoder, and service worker run normally. These tests do **not** certify real iPhone camera hardware or the Photos share action.

Before relying on it for printing, check on the **iPhone 17 Pro Max / iOS 27.2**:

- Each exposed lens opens; zoom and selfie switching work.
- The exported image matches the square live framing, including after rotating the phone.
- Review's pixel dimensions are appropriate at 1× and when zoomed.
- Save Image adds the JPEG to Photos in both Safari and the installed PWA.
- Background/resume, camera permission recovery, and offline reopening work.
- A new deployment becomes available after closing all existing app windows.

Source is in `web/`; build/server/icon scripts are in `scripts/`. To regenerate the Home Screen PNGs after editing the ring artwork, update `scripts/icons.mjs` and run `npm run icons`.
