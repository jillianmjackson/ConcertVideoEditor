# concert video editor

Turn a folder of concert photos and videos into a 9:16 recap video. Everything runs in your browser. Your media is never uploaded.

**Live site:** https://jillianmjackson.github.io/ConcertVideoEditor/ (once GitHub Pages is on)

## How it works

1. **Add your media.** Upload a folder or select photos and videos (on a phone, straight from the camera roll). iPhone HEIC photos and sideways phone video both work. Media is put in the order it was shot, and dark or blurry stretches of video are skipped.
2. **Choose a template.** Each one shows a looping preview:
   - **Stacked export** (7s): cards pile up on black, with the title on top.
   - **Info spread, mixed** (30s): each line of show info has a ( thumbnail ); half are still photos and half are videos playing straight through.
   - **Wheel spread** (21s): a turning wheel of cards with info text on both sides. It pauses 1s between swipes.

   Then fill in the words, one field per line (artist, city, venue, who you went with).
3. **Render video.** Scrub the preview, then render. The result is a 1080×1920 H.264 .mp4.
4. **Export.** Download it, or on a phone, save it to your photos from the share sheet.

Making the video needs a browser with WebCodecs: current Chrome, Edge or Safari. Firefox can preview but may not be able to encode H.264.

## Hosting

The site is static, so there's no build step. In **Settings → Pages**, set the source to *Deploy from a branch* and choose `main` with the `/ (root)` folder.

## Files

| Path | What it does |
|---|---|
| `index.html`, `styles.css` | Page and styling. They follow the ep / experience–perspective design system. |
| `js/app.js` | UI: the four screens (media, template, render, export). |
| `js/media.js` | Loads photos and videos, reads capture times, picks good clip segments. |
| `js/templates.js` | The three templates, drawn frame by frame on a 1080×1920 canvas. |
| `js/encoder.js` | Encodes with WebCodecs and packages the .mp4 with [mp4-muxer](https://github.com/Vanilagy/mp4-muxer). |
| `previews/` | Short looping preview clips shown on the template cards. |
| `fonts/` | Cossette Texte, under the SIL Open Font License (`fonts/OFL.txt`). |

Libraries are loaded from jsDelivr: mp4-muxer 5.1.3, exifr 7.1.3, and heic2any 0.0.4, which only loads when a HEIC photo needs converting.
