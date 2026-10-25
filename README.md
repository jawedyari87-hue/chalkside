# Chalkside

A voice tutor for maths, coding and computer science, on a tablet or a PC. You talk to Google's Gemini Live and write on squared paper with the S Pen. The tutor:

- sees your page (snapshots of what you've written, plus any photos or PDF pages you add)
- talks you through it out loud
- writes on a chalkboard beside your page as it talks, instead of reading things out: maths, steps, definitions, boxed answers, tables, graphs, code (coloured by language), diagrams (trees, graphs, automata, flowcharts) and pictures from Wikipedia
- hands hard problems (proofs, tricky derivations, code that doesn't work) to a slower model that thinks them through, and puts that working on the board
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

The `android` folder holds a small Android app for the Galaxy Tab. It lets the tutor see whatever is on screen: lecture PDFs, Samsung Notes, websites. It talks you through it while a floating bar, which opens into a notes panel, shows everything it says and writes. It loads this site in an overlay mode (`?overlay`), so it uses the same tutor, settings and lessons code. During a lesson the tutor can see your PC's screen too, such as lecture slides, through the PC link page (`pclink/`), which also shows the tutor's board on the PC so the tablet stays free for writing. See [android/README.md](android/README.md) to build and install it.

## Chalkside PC: the tutor sees your computer screen

For studying at a computer: lecture slides, PDFs, code in your editor, terminal errors. Open **[jawedyari87-hue.github.io/chalkside/pc](https://jawedyari87-hue.github.io/chalkside/pc/)** in Chrome or Edge. To open it like an app, click **Install** in the address bar.

1. **Share a screen or window.** A single window, such as your editor or the slides, works best, because then the tutor never sees its own notes.
2. **Open the tutor.** It opens in a small window that stays on top of your other apps. Press **Start tutor** there. The first time, it asks for your Gemini key; its settings are behind the sliders button.

The window is the tutor's board: everything it writes (maths, code, diagrams, graphs, pictures), with live captions of what it says underneath. It writes rather than reading things out. **Expand** on the board shows everything in one feed, and **A−/A+** change the board's size. The tutor gets a new picture only when your screen changes, up to 1600 pixels wide so code stays readable. The eye button hides your screen from it, and the expand button switches between the notes and a small bar. Keep the Chalkside PC page open, minimised if you like: closing it closes the tutor. If sharing stops, share again on that page. Switch to it from the taskbar, because Chrome's **Back to tab** button closes the tutor. In browsers that can't keep a window on top (Firefox, for example), the tutor appears beside the steps instead. On tablets and phones the page says it's for a computer, because they can't share their screen with a website.

The page is `pc/index.html`. The tutor is this app in screen mode (`?overlay&pc`), with `js/pcbridge.js` playing the Android app's part and `js/pccapture.js` taking the pictures. On a PC the tutor explains in words rather than drawing pen marks, since there's nothing to draw them on. To try it without a key, open http://localhost:8790/pc/?mock.

## Models

- **Fast** (`gemini-3.8-live`) is the default. It replies quickly and hands only the hardest problems to careful thinking (below).
- **Smart** uses the same voice, but hands *every* problem that needs working out to careful thinking first: any maths, code, a question on your screen, checking your working. It gets far more right, but each answer takes from about 20 seconds to 2 minutes. Google's live voice models are all Flash-sized (October 2026), so a cleverer voice isn't available; this is the smartest the live tutor gets. Smart works even with careful thinking turned off in Settings.
- **Deep thinking** (`gemini-3.8-live-extended-thinking`) has been taken out. Every tool call it makes fails on Google's side, so the tutor says "a system error occurred" whenever it tries to write on the board (tested October 2026, and again on the 25th). Chalkside moves anyone who picked it back to Fast. Careful thinking (below) does that job instead.
- **Another model ID** accepts any Live API model, for when Google releases new ones.

If Google stops accepting a setting, the app retries without it and carries on. Long lessons survive Google's 10-minute connection limit because the app resumes the session automatically.

### Careful thinking

Fast answers quickly but can slip on anything subtle. So when a problem needs careful reasoning (a proof, a derivation of several steps, a recurrence, whether an algorithm is correct, a bug), it hands the problem to a slower Gemini Flash model with its thinking turned up, through a tool called `think_deeply`. That model sees the newest picture of your page or screen, what was just said and the board. It works the problem out and writes the working on the board as a **Worked through** block. Fast then talks you through it rather than reading it out. While it works, the block shows what it's thinking about, and Fast keeps talking to you.

- It takes from about 20 seconds to 2 minutes, depending on how busy Google is.
- **Newest Flash model that's free** (the default in Settings) asks Gemini 3.8 Flash first. If Google says that model is busy, or this key has used its allowance for it, the next one gets the question: 3.7, then 3.6, then 3.5. If one hasn't started answering after 20 seconds, the next is asked as well, and the first answer wins. The block says which model answered.
- **Gemini Pro first, then Flash** asks Gemini Pro, which is cleverer still, and the Flash models if Pro can't answer. Google's free tier doesn't include Pro, so it only answers keys with billing turned on in Google AI Studio (and then charges for it); otherwise Chalkside says so and Flash answers instead.
- You can also pick one model, type another model ID, or turn careful thinking off.
- It uses the key's normal Gemini allowance, which is separate from the live one.
- If no model can answer, Fast says so and works the problem out itself.
- With **Hints only** chosen in Settings, Fast asks it for just a hint for the board, and gets the full answer privately to guide you, unless you ask for the full solution.

The code is in `js/deep.js`. With `?mock`, ask the fake tutor to "prove" something to see it work; `__mock.thinker` makes the fake model busy, out of allowance or slow.

## Try it on the PC first

```
py -3 -m http.server 8790
```

Open http://localhost:8790 in Chrome. Localhost counts as secure, so the microphone works. Add `?mock` to the address (http://localhost:8790/?mock) to try a fake tutor that needs no key: it beeps instead of talking, but it writes on the board, plots graphs and marks your page. `py -3 dev/serve.py` does the same with caching turned off. http://localhost:8790/?overlay&mock shows the Android app's floating bar, with a fake app supplying pictures of a pretend screen. The `dev/` folder holds the fake tutor, the fake app, the dev server and the icon generator; the app doesn't need it, but it's harmless to upload.
