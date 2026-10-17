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
- **Expand** opens the notes panel: everything the tutor says, live, with its written maths in between. **A−/A+** change the text size. The chips ask for a hint, a check of your working, an explanation of your screen, and so on. You can also type to the tutor. Drag the panel by its top bar, and tap the shrink button to go back to the small bar. A yellow number on the expand button counts new notes since you last looked.
- **Ask about what's on screen**: "what does this line mean?", "check my working", "is this step right?". The tutor sees the newest picture of your screen, including your handwriting in Samsung Notes or Notein.
- **Show the tutor a file** with the paperclip next to the typing box: pick a PDF and choose up to 6 pages, or pick a picture. The tutor gets those pages as pictures, marked as a file rather than your screen, and talks you through them.
- **Volume buttons** change the tutor's volume during a lesson. While the microphone is on, Android treats the lesson like a call, so the app routes the buttons to the tutor's voice.
- **End the lesson** with ✕ on the bar, **End lesson** in the notification, or **End lesson** in the app. The lesson is saved. If you start again within two hours it carries on where you left off.

What the tutor sees: a picture of the whole screen about once a second, only when something has changed, at most 1024 pixels on the long side. Chalkside's own bar and panel are blanked out in these pictures, so the tutor doesn't read its own notes. Pictures go straight from the tablet to Google with your key, as with the web app. If Android stops the screen sharing (some versions do when the tablet locks), the tutor can still hear you: open the app and tap **Share my screen again**.

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
| `src/.../FilePickerActivity.java` | Opens Android's file picker for the floating window's paperclip, which can't open one itself |
| `src/.../Web.java` | WebView set-up shared by both: storage, microphone, links open in the browser |
| `build.py` | The build |

In the web app, `?overlay` mode (in `js/app.js`) moves the live controls into a floating bar, opens the notes view (`js/notes.js`) as the panel, and sends the app's screen pictures down the same path the web app uses for pictures of your page (`realtimeInput.video`). The tutor's instructions change too (`buildSystemPrompt(settings, { screen: true })` in `js/prompt.js`): it's told it sees the whole screen, and the page-marking tools are left out. Opening `?overlay&mock` in a browser on the PC shows the bar with a fake tutor and a fake app (`dev/mock-native.js`).
