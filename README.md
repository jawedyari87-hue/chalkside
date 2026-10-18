# Chalkside

A voice maths tutor for a tablet. You talk to Google's Gemini Live and write on squared paper with the S Pen. The tutor:

- sees your page (snapshots of what you've written, plus any photos or PDF pages you add)
- talks you through it out loud
- writes the maths on a chalkboard beside your page as it talks: steps, definitions, boxed answers, tables and graphs
- marks your page like a teacher: green ticks on right lines, red circles round mistakes, short notes

Everything runs in the browser. There's no server: the app connects straight from your tablet to Gemini using your own API key.

## What you need

1. **A Gemini API key.** It's free from [Google AI Studio](https://aistudio.google.com/apikey) using your Google account. A Gemini app subscription is separate and doesn't give you a key. On the free tier Google may use your sessions to improve its products. Turning on billing in AI Studio makes your sessions private but they're then charged per use. New keys start with `AQ.`. Chalkside swaps those for a short-lived Google sign-in token when it connects, and falls back to the key itself if that doesn't work. Settings shows which one worked last time.
2. **An https:// address for the app.** Browsers only allow the microphone on secure pages, so the app has to be hosted. GitHub Pages is free (see below).

## Put it on GitHub Pages

1. On github.com, create a new **public** repository, for example `chalkside`.
2. Click **uploading an existing file**, select everything inside this `tutor` folder (`index.html`, `manifest.webmanifest`, `sw.js`, `README.md` and the `css`, `js`, `icons` and `dev` folders) and drag it in. Click **Commit changes**.
3. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and click **Save**.
4. After a minute the app is live at `https://<your-username>.github.io/chalkside/`.

The repository holds no secrets. Your API key only ever lives in the browser on your tablet.

## On the Galaxy Tab

1. Open the link in Chrome, then use **⋮ → Add to home screen → Install**. It opens full screen like an app.
2. Tap the **settings** button (top right), paste your API key, and add a line about your modules.
3. Tap **Start tutor**, allow the microphone, and say hello.

Tips:

- **Board on the left** suits right-handed writers, so your palm doesn't cover the board. Swap sides in Settings if you're left-handed.
- With the S Pen in use, a finger scrolls the page and the pen writes. Hold the S Pen button to erase.
- **Check my work** sends the tutor your page and asks it to mark it. **Watch my working** (top bar) lets the tutor speak up when it spots a mistake as you write.
- Add a question or lecture slide with the **picture** or **PDF** buttons, then ask about it.
- Lessons save on the tablet. Open **Lessons** (top left) to name them, go back to old ones, or start a new one.
- Tap **Expand** on the board (or the captions strip) to read everything the tutor says, word by word as it talks, with its written maths in between, full screen and in large text. **A−/A+** change the size.
- **Reply speed** in Settings is *Quick* by default, so the tutor answers after a short pause, like Gemini Live. Choose *Patient* if it keeps cutting in while you're thinking aloud.
- A website can't see the rest of your screen: Chrome and Samsung Internet on Android don't let websites share the screen. To show the tutor something from another app, take a screenshot and add it with the picture button, or use the Android app (below).
- The **print** button on the board saves a PDF of the board and your page for revision.
- If the tutor keeps cutting itself off, its own voice is probably reaching the microphone. Use headphones, or tick *I'm somewhere noisy* in Settings.
- To keep your key safe, you can restrict it to the Gemini API in [Google Cloud's credentials page](https://console.cloud.google.com/apis/credentials).

## The Android app: the tutor sees your whole screen

The `android` folder holds a small Android app for the Galaxy Tab. It lets the tutor see whatever is on screen: lecture PDFs, Samsung Notes, websites. It talks you through it while a floating bar, which opens into a notes panel, shows everything it says and writes. It loads this site in an overlay mode (`?overlay`), so it uses the same tutor, settings and lessons code. During a lesson the tutor can see your PC's screen too, such as lecture slides, through the PC link page (`pclink/`). See [android/README.md](android/README.md) to build and install it.

## Models

- **Fast** (`gemini-3.8-live`) is the default.
- **Deep thinking** (`gemini-3.8-live-extended-thinking`) is slower but more careful, for proofs and long problems.
- **Another model ID** accepts any Live API model, for when Google releases new ones.

If Google stops accepting a setting, the app retries without it and carries on. Long lessons survive Google's 10-minute connection limit because the app resumes the session automatically.

## Try it on the PC first

```
py -3 -m http.server 8790
```

Open http://localhost:8790 in Chrome. Localhost counts as secure, so the microphone works. Add `?mock` to the address (http://localhost:8790/?mock) to try a fake tutor that needs no key: it beeps instead of talking, but it writes on the board, plots graphs and marks your page. `py -3 dev/serve.py` does the same with caching turned off. http://localhost:8790/?overlay&mock shows the Android app's floating bar, with a fake app supplying pictures of a pretend screen. The `dev/` folder holds the fake tutor, the fake app, the dev server and the icon generator; the app doesn't need it, but it's harmless to upload.
