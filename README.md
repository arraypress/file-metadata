# @arraypress/file-metadata

Extract EXIF/IPTC metadata from images and ID3 tags from audio. Zero dependencies, safe binary parsing.

Works in browsers, Cloudflare Workers, Node.js 18+, Deno, and Bun.

## Installation

```bash
npm install @arraypress/file-metadata
```

## Usage

```js
import { extractMetadata } from '@arraypress/file-metadata';

// JPEG with EXIF/IPTC
const meta = await extractMetadata(fileInput.files[0]);
// { type: 'image', title: 'Sunset', description: 'Golden hour shot', artist: 'Jane', copyright: '© 2024' }

// MP3 with ID3 tags
const meta = await extractMetadata(audioFile);
// { type: 'audio', title: 'Dark Ambient Pad', artist: 'Studio X', album: 'Vol 1' }

// Unsupported type or no metadata
const meta = await extractMetadata(pngFile);
// {}
```

## API

### `extractMetadata(input)`

Extract metadata from a File, Blob, or ArrayBuffer. Returns a promise.

**Image metadata** (JPEG with EXIF/IPTC):
- `type` — `'image'`
- `title` — IPTC Headline or EXIF ImageDescription
- `description` — IPTC Caption or EXIF ImageDescription
- `artist` — IPTC By-line or EXIF Artist
- `copyright` — IPTC Copyright or EXIF Copyright
- `keywords` — IPTC Keywords (array)

**Audio metadata** (MP3 with ID3v1/v2):
- `type` — `'audio'`
- `title` — TIT2 (ID3v2) or Title (ID3v1)
- `artist` — TPE1 (ID3v2) or Artist (ID3v1)
- `album` — TALB (ID3v2) or Album (ID3v1)
- `genre` — TCON (ID3v2)
- `copyright` — TCOP (ID3v2)
- `description` — TIT3 subtitle (ID3v2)

Returns empty object `{}` for unsupported types, missing metadata, or parse failures.

### `hasExtractableMetadata(mimeType)`

Quick check if a MIME type supports metadata extraction. Returns `true` for `image/jpeg`, `image/tiff`, and `audio/*`.

## Security

- **Bounded reads** — only reads first 64KB (images) or 32KB (audio), never the whole file
- **Sanitized output** — all strings stripped of null bytes and control characters, capped at 1KB
- **Validated offsets** — every pointer/offset is bounds-checked before reading
- **Fail safe** — returns `{}` on any parse error, never throws
- **No execution** — purely reads bytes, no eval/Function/dynamic code

## Supported Formats

| Format | Source | Tags Read |
|---|---|---|
| JPEG | EXIF IFD0 | ImageDescription, Artist, Copyright |
| JPEG | IPTC-NAA | Headline, Caption, By-line, Copyright, Keywords |
| MP3 | ID3v2.3/v2.4 | TIT2, TPE1, TALB, TCON, TCOP, TIT3 |
| MP3 | ID3v1 | Title, Artist, Album |

PNG, WebP, GIF, WAV, FLAC, and other formats are not supported (they either don't contain EXIF/ID3 or use different metadata formats).

## License

MIT
