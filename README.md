# File Downloader

A Chrome extension that lists the links, images and media on the current page, lets you filter and tick the ones you want, and downloads them through
Chrome's own download manager, so the site's sign-in applies. Files go into your Downloads folder, optionally into subfolders, named by a rule you set.

## Install

Chrome, Brave, Edge and other Chromium browsers:

1. Download `filedownloader-<version>.zip` from the [latest release](https://github.com/navara/filedownloader/releases/latest) and unzip it into a
   folder you keep in one place; the browser loads the extension from there every time it starts.
2. Open `chrome://extensions` and switch on Developer mode.
3. Click "Load unpacked" and choose the unzipped `filedownloader-<version>` folder (or the `extension` folder of a clone of this repository).
4. Pin the extension and click its icon on a page with links.

To update, replace the folder's contents with the new version and click the reload arrow on the extension's card. Chrome gives an extension loaded
this way an ID from the folder's location, so keep the location and your queue and settings stay.

## Use

- **Select**: filter by link text or address (plain text, or a regular expression with `.*`), by kind (links, images, audio and video) and by type
  (the file extension; "(none)" are generated download links that only the server names). Tick rows (shift-click ticks a range), "Select shown" ticks
  every match. Up to 1000 rows are drawn at once.
- **Folder and file name**: templates of at most 200 characters with these tokens:

  | Token | Value |
  |---|---|
  | `{name}` | file name without extension, as the server sends it |
  | `{ext}` | extension; added at the end when the name template does not use it |
  | `{text}` | link text |
  | `{title}` | page title |
  | `{host}` | host of the page the links came from |
  | `{n}`, `{n:3}` | position in the batch, `{n:3}` padded to three digits |
  | `{date}`, `{time}` | when the batch started, `YYYY-MM-DD` and `HHMMSS` |

  A `/` in the folder template makes subfolders; an empty folder template saves straight into Downloads. Characters Windows does not allow become `_`;
  invisible characters (zero width space, direction marks) are dropped, and names Windows or Chrome reserve (`CON`, `desktop.ini`, `x.lnk`) are
  defused. A path longer than Chrome allows is shortened to fit, longest parts first. "If the file exists" either adds a number (`same (1).pdf`) or
  replaces a file from an earlier download; two files of the same batch that would get the same name are always numbered.
- **Downloads at once** (1-10) and **Automatic retries** (0-5) are on the Select page, so they apply from the first file; the Downloads page has them
  too, for what is still waiting.
- **Download** starts the ticked files. **Queue** adds them without starting, so you can collect files from several pages and start later.
- **Downloads page**: progress per file; per file Start (not started yet), Pause, Resume, Cancel, Retry, Show in folder, Remove; per batch
  Pause all, Start all or Resume all, Retry failed, Cancel all, Clear finished; for everything Start everything and Pause everything. Resume and
  Start keep to "Downloads at once": a file waits for a free slot. The queue survives closing the browser and disabling the extension: files that were
  running start again, the rest continue, paused ones stay paused until you resume them. A batch of more than 300 files shows running, paused and
  failed rows first.
- While files are running, Chrome's own download bubble is switched off (it would cover the panel); it comes back when nothing is left to run.
  Paused and not-started files do not keep it off.
- The toolbar badge counts the files still to do: blue while something runs, grey when only paused or not-started files remain.
- A file that arrives as a web page although the link was not one is marked: the site most likely asked you to sign in. A file Chrome holds as
  possibly dangerous gets Keep and Cancel; Keep shows Chrome's own question.

## Limits

- Turn off "Ask where to save each file before downloading" in Chrome's download settings: with it on, Chrome asks once per file, and in some
  setups cancels the download at once (the row then says so).
- Only inside the Downloads folder (Chrome does not let extensions save elsewhere).
- Chrome does not send `SameSite=Strict` cookies with extension downloads; a site that relies on them will answer as if you were signed out.
- Frames from other sites inside the page cannot be read; the panel says how many were skipped.
- Streams (HLS, DASH, `blob:` addresses) are not downloaded.
- While a batch runs, Chrome's download bubble is also off for downloads you start yourself elsewhere; they still appear in `chrome://downloads`.
- Big batches of small files go at roughly 8 files a second (measured with 2 KB files on this machine); real files are limited by the network.

## Development

```
npm install
npm test            # unit tests
npm run test:e2e    # the extension in a throw-away Chromium against test/playground
npm run playground  # the test pages on http://127.0.0.1:8378/basic.html
npm run pack        # dist/filedownloader-<version>.zip, the release zip
```

A release is cut by pushing a tag that matches the version in `extension/manifest.json` (`git tag v1.0 && git push origin v1.0`): the workflow
checks the tag, runs the unit tests, builds the zip and publishes the GitHub release with the zip and `SHA256SUMS`. The browser test needs a full
Chromium and runs locally before tagging.

## License

File Downloader is free software under the GNU General Public License, version 3 or later; see [LICENSE](LICENSE).
