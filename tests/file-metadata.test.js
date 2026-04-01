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

/**
 * Build JPEG with big-endian (Motorola) EXIF.
 */
function buildTestJpegWithExifBE(description) {
  const descBytes = new TextEncoder().encode(description + '\0');

  const tiffHeader = new Uint8Array([
    0x4D, 0x4D, // Motorola byte order (BE)
    0x00, 0x2A, // TIFF magic (42)
    0x00, 0x00, 0x00, 0x08, // Offset to IFD0 (8)
  ]);

  const ifdEntryCount = new Uint8Array([0x00, 0x01]); // 1 entry (BE)
  const valueOffset = 8 + 2 + 12 + 4;

  const ifdEntry = new Uint8Array(12);
  const ifdView = new DataView(ifdEntry.buffer);
  ifdView.setUint16(0, 0x010E, false);  // Tag: ImageDescription (BE)
  ifdView.setUint16(2, 2, false);        // Type: ASCII (BE)
  ifdView.setUint32(4, descBytes.length, false);
  if (descBytes.length <= 4) {
    ifdEntry.set(descBytes.slice(0, 4), 8);
  } else {
    ifdView.setUint32(8, valueOffset, false);
  }

  const nextIfd = new Uint8Array([0x00, 0x00, 0x00, 0x00]);

  const exifData = new Uint8Array([
    ...new TextEncoder().encode('Exif'), 0x00, 0x00,
    ...tiffHeader, ...ifdEntryCount, ...ifdEntry, ...nextIfd,
    ...(descBytes.length > 4 ? descBytes : []),
  ]);

  const app1Len = exifData.length + 2;
  return new Uint8Array([
    0xFF, 0xD8,
    0xFF, 0xE1, (app1Len >> 8) & 0xFF, app1Len & 0xFF,
    ...exifData,
    0xFF, 0xD9,
  ]).buffer;
}

/**
 * Build JPEG with multiple EXIF tags (description + artist + copyright).
 */
function buildTestJpegWithMultipleTags(tags) {
  const entries = [];
  const strData = [];
  let strOffset = 8 + 2 + Object.keys(tags).length * 12 + 4; // after IFD

  const TAG_IDS = { description: 0x010E, artist: 0x013B, copyright: 0x8298 };

  for (const [key, value] of Object.entries(tags)) {
    const tagId = TAG_IDS[key];
    if (!tagId) continue;
    const bytes = new TextEncoder().encode(value + '\0');
    const entry = new Uint8Array(12);
    const v = new DataView(entry.buffer);
    v.setUint16(0, tagId, true);
    v.setUint16(2, 2, true); // ASCII
    v.setUint32(4, bytes.length, true);
    if (bytes.length <= 4) {
      entry.set(bytes.slice(0, 4), 8);
    } else {
      v.setUint32(8, strOffset, true);
      strData.push(bytes);
      strOffset += bytes.length;
    }
    entries.push(entry);
  }

  const entryCount = new Uint8Array(2);
  new DataView(entryCount.buffer).setUint16(0, entries.length, true);

  const tiffHeader = new Uint8Array([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const nextIfd = new Uint8Array([0x00, 0x00, 0x00, 0x00]);

  const allEntries = new Uint8Array(entries.reduce((a, e) => a + e.length, 0));
  let off = 0;
  for (const e of entries) { allEntries.set(e, off); off += e.length; }

  const allStrData = new Uint8Array(strData.reduce((a, s) => a + s.length, 0));
  off = 0;
  for (const s of strData) { allStrData.set(s, off); off += s.length; }

  const exifData = new Uint8Array([
    ...new TextEncoder().encode('Exif'), 0x00, 0x00,
    ...tiffHeader, ...entryCount, ...allEntries, ...nextIfd, ...allStrData,
  ]);

  const app1Len = exifData.length + 2;
  return new Uint8Array([
    0xFF, 0xD8,
    0xFF, 0xE1, (app1Len >> 8) & 0xFF, app1Len & 0xFF,
    ...exifData,
    0xFF, 0xD9,
  ]).buffer;
}

/**
 * Build MP3 with ID3v2.4 (synchsafe frame sizes).
 */
function buildTestMp3WithId3v24(title, artist) {
  const frames = [];

  function addFrame(id, text) {
    const textBytes = new TextEncoder().encode(text);
    const frameSize = 1 + textBytes.length;
    const header = new Uint8Array(10);
    header.set(new TextEncoder().encode(id), 0);
    // Synchsafe frame size for v2.4
    header[4] = (frameSize >> 21) & 0x7F;
    header[5] = (frameSize >> 14) & 0x7F;
    header[6] = (frameSize >> 7) & 0x7F;
    header[7] = frameSize & 0x7F;
    const body = new Uint8Array([0x03, ...textBytes]); // UTF-8
    frames.push(new Uint8Array([...header, ...body]));
  }

  if (title) addFrame('TIT2', title);
  if (artist) addFrame('TPE1', artist);

  let totalFrameSize = 0;
  for (const f of frames) totalFrameSize += f.length;

  const id3Header = new Uint8Array(10);
  id3Header.set(new TextEncoder().encode('ID3'), 0);
  id3Header[3] = 4; // Version 2.4
  id3Header[6] = (totalFrameSize >> 21) & 0x7F;
  id3Header[7] = (totalFrameSize >> 14) & 0x7F;
  id3Header[8] = (totalFrameSize >> 7) & 0x7F;
  id3Header[9] = totalFrameSize & 0x7F;

  const result = new Uint8Array(10 + totalFrameSize);
  result.set(id3Header, 0);
  let offset = 10;
  for (const f of frames) { result.set(f, offset); offset += f.length; }
  return result.buffer;
}

/**
 * Build MP3 with multiple ID3v2 frames (title + artist + album + genre).
 */
function buildTestMp3WithAllTags(tags) {
  const frames = [];
  const FRAME_IDS = { title: 'TIT2', artist: 'TPE1', album: 'TALB', genre: 'TCON', copyright: 'TCOP', description: 'TIT3' };

  function addFrame(id, text) {
    const textBytes = new TextEncoder().encode(text);
    const frameSize = 1 + textBytes.length;
    const header = new Uint8Array(10);
    const hView = new DataView(header.buffer);
    header.set(new TextEncoder().encode(id), 0);
    hView.setUint32(4, frameSize, false);
    frames.push(new Uint8Array([...header, 0x03, ...textBytes]));
  }

  for (const [key, value] of Object.entries(tags)) {
    if (FRAME_IDS[key] && value) addFrame(FRAME_IDS[key], value);
  }

  let totalFrameSize = 0;
  for (const f of frames) totalFrameSize += f.length;

  const id3Header = new Uint8Array(10);
  id3Header.set(new TextEncoder().encode('ID3'), 0);
  id3Header[3] = 3;
  id3Header[6] = (totalFrameSize >> 21) & 0x7F;
  id3Header[7] = (totalFrameSize >> 14) & 0x7F;
  id3Header[8] = (totalFrameSize >> 7) & 0x7F;
  id3Header[9] = totalFrameSize & 0x7F;

  const result = new Uint8Array(10 + totalFrameSize);
  result.set(id3Header, 0);
  let offset = 10;
  for (const f of frames) { result.set(f, offset); offset += f.length; }
  return result.buffer;
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

  it('parses big-endian (Motorola) EXIF', async () => {
    const buf = buildTestJpegWithExifBE('Motorola byte order test');
    const meta = await extractMetadata(buf);
    assert.equal(meta.type, 'image');
    assert.equal(meta.description, 'Motorola byte order test');
  });

  it('parses multiple EXIF tags', async () => {
    const buf = buildTestJpegWithMultipleTags({
      description: 'A beautiful landscape',
      artist: 'Jane Photographer',
      copyright: '2024 Jane',
    });
    const meta = await extractMetadata(buf);
    assert.equal(meta.type, 'image');
    assert.equal(meta.description, 'A beautiful landscape');
    assert.equal(meta.artist, 'Jane Photographer');
    assert.equal(meta.copyright, '2024 Jane');
  });

  it('returns empty for JPEG with no APP1 marker', async () => {
    // JPEG with only SOI + APP0 (JFIF) + EOI
    const buf = new Uint8Array([
      0xFF, 0xD8,                     // SOI
      0xFF, 0xE0, 0x00, 0x10,         // APP0 marker + length
      0x4A, 0x46, 0x49, 0x46, 0x00,   // "JFIF\0"
      0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xFF, 0xD9,                     // EOI
    ]).buffer;
    const meta = await extractMetadata(buf);
    assert.deepEqual(meta, {});
  });

  it('handles JPEG with APP0 before APP1', async () => {
    // APP0 (JFIF) followed by APP1 (EXIF)
    const exifJpeg = new Uint8Array(buildTestJpegWithExif('After APP0'));
    const app0 = new Uint8Array([
      0xFF, 0xE0, 0x00, 0x10,
      0x4A, 0x46, 0x49, 0x46, 0x00,
      0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    ]);
    const combined = new Uint8Array(2 + app0.length + exifJpeg.length - 2);
    combined[0] = 0xFF; combined[1] = 0xD8; // SOI
    combined.set(app0, 2);
    combined.set(exifJpeg.slice(2), 2 + app0.length); // Skip SOI of inner
    const meta = await extractMetadata(combined.buffer);
    assert.equal(meta.description, 'After APP0');
  });

  it('returns empty for just SOI marker', async () => {
    const meta = await extractMetadata(new Uint8Array([0xFF, 0xD8]).buffer);
    assert.deepEqual(meta, {});
  });

  it('returns empty for wrong TIFF magic number', async () => {
    // Valid JPEG APP1 but TIFF magic is wrong
    const exifData = new Uint8Array([
      ...new TextEncoder().encode('Exif'), 0x00, 0x00,
      0x49, 0x49, 0x00, 0x99, // Wrong magic (should be 0x002A)
      0x08, 0x00, 0x00, 0x00,
    ]);
    const app1Len = exifData.length + 2;
    const buf = new Uint8Array([
      0xFF, 0xD8,
      0xFF, 0xE1, (app1Len >> 8) & 0xFF, app1Len & 0xFF,
      ...exifData,
      0xFF, 0xD9,
    ]).buffer;
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
    const buf = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).buffer;
    const meta = await extractMetadata(buf);
    assert.deepEqual(meta, {});
  });

  it('extracts from ID3v2.4 with synchsafe frame sizes', async () => {
    const buf = buildTestMp3WithId3v24('V2.4 Track', 'V2.4 Artist');
    const meta = await extractMetadata(buf);
    assert.equal(meta.type, 'audio');
    assert.equal(meta.title, 'V2.4 Track');
    assert.equal(meta.artist, 'V2.4 Artist');
  });

  it('extracts all tag types', async () => {
    const buf = buildTestMp3WithAllTags({
      title: 'Full Tags Track',
      artist: 'Multi Tag Artist',
      album: 'The Album',
      genre: 'Electronic',
      copyright: '2024 Studio',
      description: 'A subtitle',
    });
    const meta = await extractMetadata(buf);
    assert.equal(meta.title, 'Full Tags Track');
    assert.equal(meta.artist, 'Multi Tag Artist');
    assert.equal(meta.album, 'The Album');
    assert.equal(meta.genre, 'Electronic');
    assert.equal(meta.copyright, '2024 Studio');
    assert.equal(meta.description, 'A subtitle');
  });

  it('returns empty for invalid ID3 version', async () => {
    const buf = new Uint8Array([0x49, 0x44, 0x33, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).buffer; // Version 9
    const meta = await extractMetadata(buf);
    assert.deepEqual(meta, {});
  });

  it('returns empty for truncated ID3 header', async () => {
    const buf = new Uint8Array([0x49, 0x44, 0x33, 0x03]).buffer; // Only 4 bytes
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

describe('extractMetadata — MP3/ID3v1 edge cases', () => {
  it('handles ID3v1 with only title', async () => {
    const buf = buildTestMp3WithId3v1('Title Only', '', '');
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const meta = await extractMetadata(blob);
    assert.equal(meta.title, 'Title Only');
    assert.equal(meta.artist, undefined);
  });

  it('handles ID3v1 with empty fields', async () => {
    const buf = buildTestMp3WithId3v1('', '', '');
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const meta = await extractMetadata(blob);
    assert.deepEqual(meta, {}); // No useful data
  });

  it('returns empty when file is too small for ID3v1', async () => {
    const tiny = new Uint8Array(50);
    tiny[0] = 0xFF; tiny[1] = 0xFB;
    const blob = new Blob([tiny], { type: 'audio/mpeg' });
    const meta = await extractMetadata(blob);
    assert.deepEqual(meta, {});
  });

  it('returns empty when last 128 bytes are not TAG', async () => {
    const buf = new Uint8Array(256);
    buf[0] = 0xFF; buf[1] = 0xFB;
    // No TAG header at the end
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const meta = await extractMetadata(blob);
    assert.deepEqual(meta, {});
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

  it('never throws on repeated garbage runs', async () => {
    for (let run = 0; run < 10; run++) {
      const garbage = new Uint8Array(500 + Math.floor(Math.random() * 2000));
      crypto.getRandomValues(garbage);
      const meta = await extractMetadata(garbage.buffer);
      assert.ok(typeof meta === 'object');
    }
  });

  it('handles EXIF with oversized string count claim', async () => {
    // Build JPEG with EXIF claiming string is 999999 bytes
    const tiffHeader = new Uint8Array([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]);
    const ifdEntryCount = new Uint8Array([0x01, 0x00]);
    const ifdEntry = new Uint8Array(12);
    const v = new DataView(ifdEntry.buffer);
    v.setUint16(0, 0x010E, true); // ImageDescription
    v.setUint16(2, 2, true);      // ASCII
    v.setUint32(4, 999999, true);  // Absurd count
    v.setUint32(8, 50, true);     // Offset that's out of bounds
    const nextIfd = new Uint8Array([0x00, 0x00, 0x00, 0x00]);

    const exifData = new Uint8Array([
      ...new TextEncoder().encode('Exif'), 0x00, 0x00,
      ...tiffHeader, ...ifdEntryCount, ...ifdEntry, ...nextIfd,
    ]);
    const app1Len = exifData.length + 2;
    const buf = new Uint8Array([
      0xFF, 0xD8,
      0xFF, 0xE1, (app1Len >> 8) & 0xFF, app1Len & 0xFF,
      ...exifData,
      0xFF, 0xD9,
    ]).buffer;
    const meta = await extractMetadata(buf);
    assert.deepEqual(meta, {}); // Should safely return empty
  });

  it('handles ID3v2 with oversized frame claim', async () => {
    // Frame claiming to be 10MB
    const header = new Uint8Array(10);
    header.set(new TextEncoder().encode('ID3'), 0);
    header[3] = 3; header[9] = 100; // 100 bytes claimed tag size

    const frameHeader = new Uint8Array(10);
    frameHeader.set(new TextEncoder().encode('TIT2'), 0);
    new DataView(frameHeader.buffer).setUint32(4, 10000000, false); // 10MB frame

    const buf = new Uint8Array([...header, ...frameHeader, 0x03, 0x41]).buffer;
    const meta = await extractMetadata(buf);
    assert.ok(typeof meta === 'object'); // Should not crash
  });

  it('handles EXIF with out-of-bounds IFD offset', async () => {
    const tiffHeader = new Uint8Array([
      0x49, 0x49, 0x2A, 0x00,
      0xFF, 0xFF, 0xFF, 0x7F, // Huge IFD offset
    ]);
    const exifData = new Uint8Array([
      ...new TextEncoder().encode('Exif'), 0x00, 0x00,
      ...tiffHeader,
    ]);
    const app1Len = exifData.length + 2;
    const buf = new Uint8Array([
      0xFF, 0xD8,
      0xFF, 0xE1, (app1Len >> 8) & 0xFF, app1Len & 0xFF,
      ...exifData,
      0xFF, 0xD9,
    ]).buffer;
    const meta = await extractMetadata(buf);
    assert.deepEqual(meta, {});
  });

  it('handles strings with HTML injection attempts', async () => {
    const buf = buildTestJpegWithExif('<script>alert("xss")</script>');
    const meta = await extractMetadata(buf);
    // String should be preserved as-is (sanitization of HTML is the consumer's job)
    // But control chars should be stripped
    assert.ok(!meta.description?.includes('\x00'));
    assert.ok(typeof meta.description === 'string');
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
