# BookForge

A browser-based audiobook compiler that converts multiple MP3 chapter files into a single M4B file with embedded metadata, chapters, and cover art.

Everything runs locally in the browser using [FFmpeg WASM](https://ffmpegwasm.netlify.app/) — no server required.

## Features

- Drag-and-drop MP3 chapters with automatic sort ordering
- Intelligent book/author/chapter inference from filenames and ID3 tags
- Book metadata lookup via Google Books and Open Library APIs
- Cover art extraction from ID3 tags or manual upload
- Chapter markers with editable names
- Exports a single `.m4b` file with AAC audio, chapters, and cover art

## Usage

Visit the [live site](https://possiblypengu.github.io/windsurf-project-2/) or serve the `docs/` directory locally:

```bash
npx serve docs
```

> First load downloads ~31 MB of FFmpeg WASM.

## Development

```bash
npm install          # install dev dependencies
npm test             # run tests
npm run lint         # run ESLint
npm run test:watch   # run tests in watch mode
```

## Architecture

```text
docs/
├── index.html           # single-page app entry point
├── coi-serviceworker.js  # COOP/COEP headers for WASM
├── css/main.css          # dark-theme UI
└── js/
    ├── app.js            # UI state, events, FFmpeg orchestration
    ├── metadata.js       # ID3 tag reading & audio info extraction
    ├── book-parser.js    # filename parsing & chapter name inference
    └── book-lookup.js    # Google Books & Open Library API integration
```

## License

ISC
