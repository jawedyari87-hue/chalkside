# Chalkside for Android

A small Android app that lets the Chalkside tutor see your **whole screen**: lecture PDFs, Samsung Notes, problem sheets, websites. You talk to it while you work in other apps. It answers out loud, and a floating bar opens into a panel showing everything it has said and written, with the maths rendered.

A website can't do this. Chrome and Samsung Internet on Android don't let pages share the screen. The app uses Android's screen capture (MediaProjection) and puts the Chalkside website in a floating window. The tutor, the lessons and the settings are the same code as the web app, loaded from https://jawedyari87-hue.github.io/chalkside/ in a special overlay mode (`?overlay`), so web updates reach the app without rebuilding it.

## Install it on the tablet

You need the APK file, `android/build/chalkside.apk`. Build it with `py -3 android/build.py` (see *Build it yourself* below).

**Samsung Auto Blocker** (Settings → Security and privacy → Auto Blocker) blocks installing apps from outside the Play Store and switches off developer options. If it is on, or keeps turning itself back on, turn it off while you install. Once the app is installed you can turn it on again, and Chalkside keeps working.

**With adb, over USB or Wi-Fi (easiest to update):**

1. On the tablet, open **Settings → About tablet → Software information** and tap **Build number** seven times.
2. Go to **Settings → Developer options** and turn on **USB debugging**.
3. Connect the tablet to the PC, either way:
   - **USB:** plug it in with a data cable. When the tablet asks **Allow USB debugging?** and shows the computer's key fingerprint, tick *Always allow from this computer* and tap **Allow**. If the tablet shows no USB notification at all when plugged in, the cable only charges.
   - **Wi-Fi** (same network as the PC): turn on **Developer options → Wireless debugging**, open it, and tap **Pair device with pairing code**. On the PC run `adb pair <IP address & Port shown>` and type the 6-digit code. `adb mdns services` also lists the address while the pairing box is open. After pairing, adb reconnects by itself while Wireless debugging is on.
4. Run `py -3 android/build.py --install`.

**Without a cable:** copy `chalkside.apk` to the tablet any way you like, for example Google Drive, email, or a USB file transfer. Open it in **My Files**. Android asks you to allow installs from that app (**Settings → Install unknown apps**); allow it and tap **Install**. Google Play Protect may warn that it doesn't recognise the developer, because the app is signed with a personal debug key rather than published on the Play Store. Choose **Install anyway**.

## First lesson: permissions

Open **Chalkside** from the app drawer. The start screen lists what it needs, and **Start lesson** walks you through any that are missing:

| Permission | Why | How |
|---|---|---|
| Microphone | So the tutor can hear you | Android asks. Choose **While using the app**. |
| Show over other apps | The floating bar and notes panel | Opens Android's settings: turn on **Allow display over other apps** for Chalkside, then go back. |
| Notifications (optional) | A notification while a lesson runs, with **End lesson** | Android asks. |
| Gemini API key | The tutor runs on your own key, as in the web app | Opens Chalkside's settings (the same form as the web app). Paste your key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and tap **Save**. |
| Screen sharing | So the tutor can see your screen | Android asks **every time you start a lesson**. That's Android's rule, and the app can't remember it. Choose to share the **entire screen**. |

The app keeps its own storage, separate from Chrome, so add your key here even if the web app already has it. **Tutor settings** on the start screen changes the voice, model, how much help you get, and the line about your modules.

## Using it

After **Start lesson** the app gets out of the way and the tutor greets you. Open whatever you're working on.

- **The floating bar** has the microphone (tap to mute), the tutor's status, an **eye** (tap to hide your screen from the tutor, for example before you open messages or banking), **expand**, and **✕** to end the lesson. Drag the bar to move it.
- **Expand** opens the notes panel: everything the tutor says, live, with its written maths in between. **A−/A+** change the text size. The chips ask for a hint, a check of your working, an explanation of your screen, and so on. You can also type to the tutor. Drag the panel by its top bar to move it, and drag the small corner mark (in the corner nearest the middle of the screen) to make it wider, narrower, taller or shorter; it keeps that size, separately for landscape and portrait. Tap the shrink button to go back to the small bar. A yellow number on the expand button counts new notes since you last looked.
- **Ask about what's on screen**: "what does this line mean?", "check my working", "is this step right?". The tutor sees the newest picture of your screen, including your handwriting in Samsung Notes or Notein.
- **Show the tutor files** with the paperclip next to the typing box: pictures, PDFs, and code in any language (Python, Java, C, a Jupyter notebook and so on) or other text files. Pick several at once (up to 10); one note tells the tutor what they all were. A PDF goes over whole, a picture of each page about once a second, each labelled with its page number. A line shows the progress, with **Stop**, and the limit is 60 pages in all. Code goes over as text with line numbers added, so the tutor reads it exactly and can say "line 14"; long files are cut at about 440 lines. Everything is marked as a file rather than your screen, and the tutor talks you through it. (The Live API takes pictures and text, not documents.)
- **Check my working**: the tutor marks your writing on the screen itself, like the web app marks your page: a red ring round a mistake, a green tick by a right line, an amber wave under something to check, a blue bracket by a note. The marks go when you scroll or switch app, or when you tap the remove-marks button on the bar. Touches pass straight through them.
- **The tutor's volume**: tap the **speaker** on the bar for a volume slider right in the bar, or use the volume buttons. While the microphone is on, Android treats the lesson like a call, so the tutor's voice follows the *call* volume, not the media volume. If the volume is off when a lesson starts, the app says so.
- **End the lesson** with ✕ on the bar, **End lesson** in the notification, or **End lesson** in the app. The lesson is saved. If you start again within two hours it carries on where you left off.

What the tutor sees: a picture of the whole screen about once a second, only when something has changed, at most 1024 pixels on the long side. Chalkside's own bar and panel are blanked out in these pictures, so the tutor doesn't read its own notes. Pictures go straight from the tablet to Google with your key, as with the web app. If Android stops the screen sharing (some versions do when the tablet locks), the tutor can still hear you: open the app and tap **Share my screen again**.

## Show the tutor your PC too, with the board on the PC

For lecture slides on the PC while you write notes on the tablet. The tutor sees both screens, and its board shows on the PC, so the tablet stays free for writing:

1. Put the PC and the tablet on the same Wi-Fi, and start a lesson on the tablet.
2. On the PC, open the PC link page as a file in Chrome or Edge. The first time, go to **[jawedyari87-hue.github.io/chalkside/pclink](https://jawedyari87-hue.github.io/chalkside/pclink/)**, click **Download** and open the file it saves; keep it on your desktop for next time. (Browsers block a website from reaching the tablet over plain http, but a page opened from a file can.) On a PC with this project, `pclink/index.html` is the same page. Download it again after an update.
3. Type the **address** and **code** from the Chalkside start screen (under *Your PC's screen*), click **Share a screen or window**, and choose the window with your slides. A single window is better than the whole screen, because then the tutor doesn't see its own board.

The page sends a picture of what you shared, at most once a second and only when it has changed (moving the mouse doesn't count). The tutor gets these alongside your tablet's pictures, with a *PC screen* strip across the top so it can tell them apart. Ask about "the slide" or "my PC" and it looks at the newest PC picture. The bar shows **· PC** while the PC is linked. Keep the page open; its tab can be in the background, and its preview shows the last picture sent.

**The board on the PC.** Once linked, the page shows the tutor's board: everything it writes on the current page (maths, code, graphs, diagrams, careful working as it happens), with captions of what it says underneath. Leave the bar on the tablet small; while the PC shows the board, the bar stops counting new notes. On the page, drag the board's right edge, bottom edge or corner to resize it (it remembers the size; **Fit it to the window again** undoes it), or press **Full screen** in its bar to fill the whole screen (Esc returns). **Keep on top** (Chrome and Edge) moves the board into a small window that stays on top of your slides; drag its edges to resize it (it opens at that size next time), and **Back to the page** returns it. **A−/A+** change the writing size. Type a question under the board, or tap **Check my working**, **Explain my PC screen**, **Hint** or **Explain differently**, and the tutor on the tablet gets it as if you'd typed it there. **Just show the board** links the page without sharing the PC's screen. The tablet hands over the board only while the page is open, and only with the code.

- **Only during a lesson.** The tablet listens for the PC (on port 8792) only while a lesson runs, and only takes pictures that come with the code. **New code** on the start screen replaces the code; type the new one into the page. Ten wrong codes in a minute and the tablet stops listening to that computer until the minute is up.
- **If the page can't reach the tablet**, check that both are on the same Wi-Fi, that a lesson is running, and that the address is right. If the browser asks to allow access to devices on your local network, allow it. Networks that keep devices apart, as eduroam and many university and public networks do, block the link completely. Home Wi-Fi or a phone hotspot works.
- The PC does the sending, so nothing on the PC accepts connections and Windows Firewall needs no changes.
- The tutor's pen marks only go on the tablet. It describes things on the PC in words.
- PC pictures are at most 1280 pixels on the long side, so small slide text stays readable.

## Build it yourself

You need JDK 17 and the Android SDK command-line tools with `platforms/android-35` and `build-tools/35.0.0`. On this PC they're in `C:\Users\Jawed\Android\jdk-17` and `C:\Users\Jawed\Android\Sdk`. To use other locations, set `JAVA_HOME` and `ANDROID_HOME`.

```
py -3 android/build.py
```

That's the whole build, with no Gradle or Android Studio: `aapt2` compiles the resources and manifest, `javac` compiles the Java against `android.jar`, `d8` converts it to Android bytecode, then the script zips, aligns (`zipalign`) and signs (`apksigner`) `android/build/chalkside.apk`.

| Option | What it does |
|---|---|
| `--install` | Installs the APK on the plugged-in tablet with adb |
| `--launch` | Also opens the app |
| `--debug` | Makes the app debuggable, so you can inspect the page at `chrome://inspect` on the PC |
| `--base URL` | Loads the web app from somewhere else, such as the PC's dev server |

To test web changes on the tablet before publishing them, run the dev server (`py -3 dev/serve.py 8791`), then:

```
py -3 android/build.py --debug --base http://localhost:8791/ --install
adb reverse tcp:8791 tcp:8791
```

Add `?mock` (`--base "http://localhost:8791/?mock"`) for the fake tutor, which needs no API key. Build without `--base` again before you go back to normal use. The app's logs (including the page's console) are in `adb logcat -s Chalkside`.

**The signing key.** Builds are signed with the standard debug key, `~/.android/debug.keystore`, which the script creates the first time. Android only installs an update signed with the same key. If that file is lost, uninstall the app before installing a new build, and add your API key again.

## How it fits together

| File | What it does |
|---|---|
| `src/.../MainActivity.java` | Start screen: permissions, **Start lesson**, asking to share the screen |
| `src/.../TutorService.java` | Foreground service (screen capture + microphone) that holds the screen capture and the floating window for a lesson, and a media session so the volume buttons control the tutor |
| `src/.../ScreenCapture.java` | Mirrors the screen into an `ImageReader`, at most one JPEG a second, only when something changed, with Chalkside's own window blanked out |
| `src/.../Overlay.java` | The floating window: the web app's `?overlay` page in a WebView, sized by the page, draggable, and the `window.ChalksideAndroid` bridge |
| `src/.../SettingsActivity.java` | The web app's settings form (`?overlay&settings`) |
| `src/.../MarksView.java` | The tutor's pen marks, drawn in a full-screen layer over other apps that lets touches through |
| `src/.../FilePickerActivity.java` | Opens Android's file picker for the floating window's paperclip, which can't open one itself |
| `src/.../PcLink.java` | During a lesson, a tiny web server on port 8792 for the PC link page, answering only with the code: it takes pictures of your PC's screen, hands over the board (`GET /board`) and passes on what you type there (`POST /say`) |
| `../pclink/index.html` | The PC link page: shares a screen or window in the PC's browser and sends it to the tablet, and shows the tutor's board |
| `src/.../Web.java` | WebView set-up shared by both: storage, microphone, links open in the browser |
| `build.py` | The build |

In the web app, `?overlay` mode (in `js/app.js`) moves the live controls into a floating bar, opens the notes view (`js/notes.js`) as the panel, and sends the app's screen pictures down the same path the web app uses for pictures of your page (`realtimeInput.video`). The tutor's instructions change too (`buildSystemPrompt(settings, { screen: true })` in `js/prompt.js`): it's told it sees the whole screen, and the page-marking tools are left out. Opening `?overlay&mock` in a browser on the PC shows the bar with a fake tutor and a fake app (`dev/mock-native.js`).
