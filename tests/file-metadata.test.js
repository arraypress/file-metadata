import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractMetadata, hasExtractableMetadata } from '../src/index.js';

// ── Test helpers: build minimal binary files ──

/**
 * Build a minimal JPEG with EXIF ImageDescription tag.
 */
function buildTestJpegWithExif(description) {
  const descBytes = new TextEncoder().encode(description + '\0');

  // TIFF header (little-endian)
  const tiffHeader = new Uint8Array([
    0x49, 0x49, // Intel byte order (LE)
    0x2A, 0x00, // TIFF magic (42)
    0x08, 0x00, 0x00, 0x00, // Offset to IFD0 (8)
  ]);

  // IFD0 with 1 entry: ImageDescription (0x010E)
  const ifdEntryCount = new Uint8Array([0x01, 0x00]); // 1 entry
  const valueOffset = 8 + 2 + 12 + 4; // tiff start + count + 1 entry + next IFD pointer

  const ifdEntry = new Uint8Array(12);
  const ifdView = new DataView(ifdEntry.buffer);
  ifdView.setUint16(0, 0x010E, true);  // Tag: ImageDescription
  ifdView.setUint16(2, 2, true);        // Type: ASCII
  ifdView.setUint32(4, descBytes.length, true); // Count
  if (descBytes.length <= 4) {
    ifdEntry.set(descBytes.slice(0, 4), 8);
  } else {
    ifdView.setUint32(8, valueOffset, true); // Offset to string data
  }

  const nextIfd = new Uint8Array([0x00, 0x00, 0x00, 0x00]); // No next IFD

  // Build EXIF data
  const exifData = new Uint8Array([
    ...new TextEncoder().encode('Exif'),
    0x00, 0x00, // padding
    ...tiffHeader,
    ...ifdEntryCount,
    ...ifdEntry,
    ...nextIfd,
    ...(descBytes.length > 4 ? descBytes : []),
  ]);

  // APP1 segment
  const app1Len = exifData.length + 2;
  const app1 = new Uint8Array([
    0xFF, 0xE1, // APP1 marker
    (app1Len >> 8) & 0xFF, app1Len & 0xFF, // Length
    ...exifData,
  ]);

  // JPEG = SOI + APP1 + EOI
  return new Uint8Array([
    0xFF, 0xD8, // SOI
    ...app1,
    0xFF, 0xD9, // EOI
  ]).buffer;
}

/**
 * Build a minimal MP3 with ID3v2.3 TIT2 and TPE1 frames.
 */
function buildTestMp3WithId3v2(title, artist) {
  const frames = [];

  function addFrame(id, text) {
    const textBytes = new TextEncoder().encode(text);
    const frameSize = 1 + textBytes.length; // encoding byte + text
    const header = new Uint8Array(10);
    const hView = new DataView(header.buffer);
    header.set(new TextEncoder().encode(id), 0); // Frame ID
    hView.setUint32(4, frameSize, false);         // Size (big-endian)
    // Flags: 0x0000
    const body = new Uint8Array([0x03, ...textBytes]); // 0x03 = UTF-8
    frames.push(new Uint8Array([...header, ...body]));
  }

  if (title) addFrame('TIT2', title);
  if (artist) addFrame('TPE1', artist);

  // Combine all frame bytes
  let totalFrameSize = 0;
  for (const f of frames) totalFrameSize += f.length;

  // ID3v2.3 header
  const id3Header = new Uint8Array(10);
  id3Header.set(new TextEncoder().encode('ID3'), 0);
  id3Header[3] = 3; // Version 2.3
  id3Header[4] = 0; // Revision
  id3Header[5] = 0; // Flags
  // Synchsafe size
  id3Header[6] = (totalFrameSize >> 21) & 0x7F;
  id3Header[7] = (totalFrameSize >> 14) & 0x7F;
  id3Header[8] = (totalFrameSize >> 7) & 0x7F;
  id3Header[9] = totalFrameSize & 0x7F;

  const result = new Uint8Array(10 + totalFrameSize);
  result.set(id3Header, 0);
  let offset = 10;
  for (const f of frames) {
    result.set(f, offset);
    offset += f.length;
  }

  return result.buffer;
}

/**
 * Build a minimal MP3 with ID3v1 tag (last 128 bytes).
 */
function buildTestMp3WithId3v1(title, artist, album) {
  const tag = new Uint8Array(128);
  tag.set(new TextEncoder().encode('TAG'), 0);
  if (title) tag.set(new TextEncoder().encode(title.slice(0, 30)), 3);
  if (artist) tag.set(new TextEncoder().encode(artist.slice(0, 30)), 33);
  if (album) tag.set(new TextEncoder().encode(album.slice(0, 30)), 63);

  // Prepend some fake MP3 data so the file is > 128 bytes
  const fakeMp3 = new Uint8Array(256);
  fakeMp3[0] = 0xFF; fakeMp3[1] = 0xFB; // MPEG sync
  fakeMp3.set(tag, 128);
  return fakeMp3.buffer;
}

// ── Tests ──────────────────────────────────

describe('extractMetadata — JPEG/EXIF', () => {
  it('extracts ImageDescription from EXIF', async () => {
    const buf = buildTestJpegWithExif('Sunset over mountains');
    const meta = await extractMetadata(buf);
    assert.equal(meta.type, 'image');
    assert.equal(meta.description, 'Sunset over mountains');
  });

  it('handles short description (≤4 bytes inline)', async () => {
    const buf = buildTestJpegWithExif('Hi');
    const meta = await extractMetadata(buf);
    assert.equal(meta.description, 'Hi');
  });

  it('returns empty for non-JPEG', async () => {
    const buf = new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer; // PNG header
    const meta = await extractMetadata(buf);
    assert.deepEqual(meta, {});
  });

  it('returns empty for empty buffer', async () => {
    const meta = await extractMetadata(new ArrayBuffer(0));
    assert.deepEqual(meta, {});
  });

  it('returns empty for malformed EXIF', async () => {
    const buf = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xD9]).buffer;
    const meta = await extractMetadata(buf);
    assert.deepEqual(meta, {});
  });
});

describe('extractMetadata — MP3/ID3v2', () => {
  it('extracts title and artist from ID3v2', async () => {
    const buf = buildTestMp3WithId3v2('Dark Ambient Pad', 'Studio X');
    const meta = await extractMetadata(buf);
    assert.equal(meta.type, 'audio');
    assert.equal(meta.title, 'Dark Ambient Pad');
    assert.equal(meta.artist, 'Studio X');
  });

  it('extracts title only', async () => {
    const buf = buildTestMp3WithId3v2('My Track', null);
    const meta = await extractMetadata(buf);
    assert.equal(meta.title, 'My Track');
  });

  it('returns empty for ID3v2 with no text frames', async () => {
    // Just the header, no frames
    const buf = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).buffer;
    const meta = await extractMetadata(buf);
    assert.deepEqual(meta, {});
  });
});

describe('extractMetadata — MP3/ID3v1', () => {
  it('extracts from ID3v1 tag', async () => {
    const buf = buildTestMp3WithId3v1('Lo-Fi Beat', 'Producer', 'Beats Vol 1');
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const meta = await extractMetadata(blob);
    assert.equal(meta.type, 'audio');
    assert.equal(meta.title, 'Lo-Fi Beat');
    assert.equal(meta.artist, 'Producer');
    assert.equal(meta.album, 'Beats Vol 1');
  });
});

describe('extractMetadata — security', () => {
  it('strips null bytes from strings', async () => {
    const buf = buildTestJpegWithExif('Hello\x00World\x00');
    const meta = await extractMetadata(buf);
    assert.equal(meta.description, 'HelloWorld');
  });

  it('strips control characters', async () => {
    const buf = buildTestJpegWithExif('Hello\x01\x02\x1FWorld');
    const meta = await extractMetadata(buf);
    assert.equal(meta.description, 'HelloWorld');
  });

  it('handles Blob input for images', async () => {
    const buf = buildTestJpegWithExif('Test description');
    const blob = new Blob([buf], { type: 'image/jpeg' });
    const meta = await extractMetadata(blob);
    assert.equal(meta.description, 'Test description');
  });

  it('never throws on garbage data', async () => {
    const garbage = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) garbage[i] = Math.floor(Math.random() * 256);
    const meta = await extractMetadata(garbage.buffer);
    assert.ok(typeof meta === 'object');
  });
});

describe('hasExtractableMetadata', () => {
  it('true for image/jpeg', () => assert.equal(hasExtractableMetadata('image/jpeg'), true));
  it('true for image/tiff', () => assert.equal(hasExtractableMetadata('image/tiff'), true));
  it('true for audio/mpeg', () => assert.equal(hasExtractableMetadata('audio/mpeg'), true));
  it('true for audio/mp3', () => assert.equal(hasExtractableMetadata('audio/mp3'), true));
  it('false for image/png', () => assert.equal(hasExtractableMetadata('image/png'), false));
  it('false for video/mp4', () => assert.equal(hasExtractableMetadata('video/mp4'), false));
  it('false for null', () => assert.equal(hasExtractableMetadata(null), false));
  it('false for empty', () => assert.equal(hasExtractableMetadata(''), false));
});
