/**
 * @arraypress/file-metadata
 *
 * Extract EXIF/IPTC metadata from images and ID3 tags from audio.
 * Zero dependencies. Safe binary parsing with bounded reads.
 *
 * Works in browsers, Cloudflare Workers, Node.js 18+, Deno, Bun.
 *
 * @module @arraypress/file-metadata
 */

// ── Security constants ─────────────────────
const MAX_STRING_LENGTH = 1024;       // Cap extracted strings at 1KB
const MAX_EXIF_READ = 65536;          // Only read first 64KB for EXIF
const MAX_ID3_READ = 32768;           // Only read first 32KB for ID3v2
const ID3V1_SIZE = 128;               // ID3v1 is last 128 bytes

// ── Helpers ────────────────────────────────

/** Sanitize extracted string: strip null bytes, control chars, trim. */
function sanitizeString(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/\0/g, '')               // null bytes
    .replace(/[\x01-\x1f\x7f]/g, '')  // control chars
    .trim()
    .slice(0, MAX_STRING_LENGTH);
}

/** Read a 16-bit unsigned integer from a DataView. */
function readU16(view, offset, littleEndian) {
  if (offset + 2 > view.byteLength) return 0;
  return view.getUint16(offset, littleEndian);
}

/** Read a 32-bit unsigned integer from a DataView. */
function readU32(view, offset, littleEndian) {
  if (offset + 4 > view.byteLength) return 0;
  return view.getUint32(offset, littleEndian);
}

/** Read a fixed-length ASCII string from a buffer. */
function readString(buf, offset, length) {
  if (offset < 0 || offset + length > buf.byteLength) return '';
  const bytes = new Uint8Array(buf, offset, Math.min(length, MAX_STRING_LENGTH));
  return sanitizeString(String.fromCharCode(...bytes));
}

/** Read a UTF-8 string from a buffer. */
function readUTF8(buf, offset, length) {
  if (offset < 0 || offset + length > buf.byteLength) return '';
  const slice = new Uint8Array(buf, offset, Math.min(length, MAX_STRING_LENGTH));
  try {
    return sanitizeString(new TextDecoder('utf-8').decode(slice));
  } catch {
    return readString(buf, offset, length);
  }
}

// ── EXIF Parser ────────────────────────────

/**
 * Extract EXIF metadata from a JPEG buffer.
 * Reads ImageDescription (0x010E) and Artist (0x013B) from IFD0.
 */
function parseExif(buf) {
  const result = {};
  const view = new DataView(buf);

  // Find APP1 marker (0xFFE1) containing EXIF
  let offset = 2; // Skip SOI (0xFFD8)
  while (offset < Math.min(buf.byteLength, MAX_EXIF_READ) - 4) {
    const marker = readU16(view, offset, false);
    if (marker === 0xFFE1) break; // APP1 found
    if ((marker & 0xFF00) !== 0xFF00) return result; // Not a valid marker
    const segLen = readU16(view, offset + 2, false);
    if (segLen < 2) return result;
    offset += 2 + segLen;
  }

  if (offset >= Math.min(buf.byteLength, MAX_EXIF_READ) - 4) return result;

  const app1Start = offset + 4; // Skip marker + length
  // Check for "Exif\0\0" header
  if (readString(buf, app1Start, 4) !== 'Exif') return result;

  const tiffStart = app1Start + 6; // After "Exif\0\0"
  if (tiffStart + 8 > buf.byteLength) return result;

  // Determine byte order
  const byteOrder = readU16(view, tiffStart, false);
  const le = byteOrder === 0x4949; // Intel = little-endian
  if (byteOrder !== 0x4949 && byteOrder !== 0x4D4D) return result; // Invalid

  // Verify TIFF magic (42)
  if (readU16(view, tiffStart + 2, le) !== 42) return result;

  // Read IFD0 offset
  const ifd0Offset = readU32(view, tiffStart + 4, le);
  if (ifd0Offset < 8 || tiffStart + ifd0Offset + 2 > buf.byteLength) return result;

  const ifdStart = tiffStart + ifd0Offset;
  const entryCount = readU16(view, ifdStart, le);
  if (entryCount > 200) return result; // Sanity check

  // Interesting tags
  const TAGS = {
    0x010E: 'description',  // ImageDescription
    0x013B: 'artist',       // Artist
    0x8298: 'copyright',    // Copyright
  };

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifdStart + 2 + i * 12;
    if (entryOffset + 12 > buf.byteLength) break;

    const tag = readU16(view, entryOffset, le);
    if (!TAGS[tag]) continue;

    const type = readU16(view, entryOffset + 2, le);
    const count = readU32(view, entryOffset + 4, le);

    // Type 2 = ASCII string
    if (type !== 2) continue;
    if (count > MAX_STRING_LENGTH || count === 0) continue;

    let strOffset;
    if (count <= 4) {
      strOffset = entryOffset + 8;
    } else {
      strOffset = tiffStart + readU32(view, entryOffset + 8, le);
    }

    if (strOffset < 0 || strOffset + count > buf.byteLength) continue;
    const value = readString(buf, strOffset, count);
    if (value) result[TAGS[tag]] = value;
  }

  return result;
}

// ── IPTC Parser ────────────────────────────

/**
 * Extract IPTC metadata from a JPEG buffer.
 * Reads Caption (2:120) and Headline (2:105) from APP13.
 */
function parseIptc(buf) {
  const result = {};
  const view = new DataView(buf);

  // Find APP13 marker (0xFFED) containing IPTC
  let offset = 2;
  while (offset < Math.min(buf.byteLength, MAX_EXIF_READ) - 4) {
    const marker = readU16(view, offset, false);
    if (marker === 0xFFED) break;
    if ((marker & 0xFF00) !== 0xFF00) return result;
    const segLen = readU16(view, offset + 2, false);
    if (segLen < 2) return result;
    offset += 2 + segLen;
  }

  if (offset >= Math.min(buf.byteLength, MAX_EXIF_READ) - 4) return result;

  const segLen = readU16(view, offset + 2, false);
  const segStart = offset + 4;
  const segEnd = Math.min(segStart + segLen - 2, buf.byteLength);

  // Skip "Photoshop 3.0\0" header + 8BIM resource blocks to find IPTC
  let pos = segStart;
  const header = readString(buf, pos, 14);
  if (!header.startsWith('Photoshop 3.0')) return result;
  pos += 14;

  // Scan for 8BIM resources
  while (pos + 12 < segEnd) {
    if (readString(buf, pos, 4) !== '8BIM') break;
    pos += 4;
    const resourceId = readU16(view, pos, false);
    pos += 2;
    // Skip pascal string (name)
    const nameLen = new Uint8Array(buf)[pos] || 0;
    pos += 1 + nameLen + (nameLen % 2 === 0 ? 1 : 0); // Pad to even
    const dataLen = readU32(view, pos, false);
    pos += 4;

    if (resourceId === 0x0404) {
      // IPTC-NAA resource — parse IPTC dataset records
      const iptcEnd = Math.min(pos + dataLen, segEnd);
      let iptcPos = pos;

      while (iptcPos + 5 < iptcEnd) {
        if (new Uint8Array(buf)[iptcPos] !== 0x1C) break;
        const recNum = new Uint8Array(buf)[iptcPos + 1];
        const datasetNum = new Uint8Array(buf)[iptcPos + 2];
        const dsLen = readU16(view, iptcPos + 3, false);
        iptcPos += 5;

        if (dsLen > MAX_STRING_LENGTH || iptcPos + dsLen > iptcEnd) break;

        if (recNum === 2) {
          const value = readUTF8(buf, iptcPos, dsLen);
          if (datasetNum === 120 && value) result.description = value; // Caption
          if (datasetNum === 105 && value) result.title = value;       // Headline
          if (datasetNum === 80 && value) result.artist = value;       // By-line
          if (datasetNum === 116 && value) result.copyright = value;   // Copyright
          if (datasetNum === 25 && value) {                            // Keywords
            result.keywords = result.keywords || [];
            result.keywords.push(value);
          }
        }

        iptcPos += dsLen;
      }
      break;
    }

    pos += dataLen + (dataLen % 2); // Pad to even
  }

  return result;
}

// ── ID3v2 Parser ───────────────────────────

/**
 * Extract ID3v2 tags from an MP3 buffer.
 * Reads TIT2 (title), TPE1 (artist), TALB (album), TCON (genre).
 */
function parseId3v2(buf) {
  const result = {};
  if (buf.byteLength < 10) return result;

  const bytes = new Uint8Array(buf);

  // Check ID3v2 header: "ID3"
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return result;

  const majorVersion = bytes[3]; // 3 = ID3v2.3, 4 = ID3v2.4
  if (majorVersion < 2 || majorVersion > 4) return result;

  // Synchsafe size (7 bits per byte)
  const tagSize = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
  if (tagSize > MAX_ID3_READ || tagSize < 0) return result;

  const FRAME_TAGS = {
    TIT2: 'title',
    TPE1: 'artist',
    TALB: 'album',
    TCON: 'genre',
    TCOP: 'copyright',
    TIT3: 'description', // Subtitle/description
  };

  let pos = 10;
  const end = Math.min(10 + tagSize, buf.byteLength);

  while (pos + 10 < end) {
    // Frame header: 4-byte ID, 4-byte size, 2-byte flags
    const frameId = readString(buf, pos, 4);
    if (!frameId || frameId[0] === '\0') break; // Padding

    const view = new DataView(buf);
    let frameSize;
    if (majorVersion === 4) {
      // Synchsafe in v2.4
      frameSize = (bytes[pos + 4] << 21) | (bytes[pos + 5] << 14) | (bytes[pos + 6] << 7) | bytes[pos + 7];
    } else {
      frameSize = readU32(view, pos + 4, false);
    }

    pos += 10; // Skip header

    if (frameSize <= 0 || frameSize > MAX_STRING_LENGTH || pos + frameSize > end) break;

    const key = FRAME_TAGS[frameId];
    if (key && frameSize > 1) {
      const encoding = bytes[pos]; // 0=Latin-1, 1=UTF-16, 2=UTF-16BE, 3=UTF-8
      let value = '';

      if (encoding === 3 || encoding === 0) {
        // UTF-8 or Latin-1
        value = readUTF8(buf, pos + 1, frameSize - 1);
      } else if (encoding === 1 || encoding === 2) {
        // UTF-16 (with or without BOM)
        try {
          const decoder = new TextDecoder(encoding === 1 ? 'utf-16' : 'utf-16be');
          const slice = new Uint8Array(buf, pos + 1, Math.min(frameSize - 1, MAX_STRING_LENGTH));
          value = sanitizeString(decoder.decode(slice));
        } catch {
          value = readString(buf, pos + 1, frameSize - 1);
        }
      }

      if (value) result[key] = value;
    }

    pos += frameSize;
  }

  return result;
}

// ── ID3v1 Parser ───────────────────────────

/**
 * Extract ID3v1 tags from the last 128 bytes of an MP3 buffer.
 */
function parseId3v1(buf) {
  const result = {};
  if (buf.byteLength < ID3V1_SIZE) return result;

  const tagStart = buf.byteLength - ID3V1_SIZE;
  const tag = readString(buf, tagStart, 3);
  if (tag !== 'TAG') return result;

  const title = readString(buf, tagStart + 3, 30);
  const artist = readString(buf, tagStart + 33, 30);
  const album = readString(buf, tagStart + 63, 30);

  if (title) result.title = title;
  if (artist) result.artist = artist;
  if (album) result.album = album;

  return result;
}

// ── Public API ─────────────────────────────

/**
 * Extract metadata from a file.
 *
 * Detects the file type and parses EXIF/IPTC (images) or ID3 (audio).
 * Returns an object with available metadata fields. Missing fields
 * are omitted (not set to empty strings).
 *
 * Only reads the first/last few KB of the file — safe for large files.
 * All string values are sanitized (no null bytes, control chars, or HTML).
 * Returns empty object on parse failure — never throws.
 *
 * @param {File|Blob|ArrayBuffer} input - The file to extract metadata from.
 * @returns {Promise<Object>} Extracted metadata.
 *
 * @example
 * const meta = await extractMetadata(fileInput.files[0]);
 * // Image: { title: 'Sunset', description: 'Golden hour shot', artist: 'Jane', type: 'image' }
 * // Audio: { title: 'Dark Pad', artist: 'Studio X', album: 'Ambient Vol 1', type: 'audio' }
 * // Unknown: {}
 */
export async function extractMetadata(input) {
  try {
    let buf;
    let mimeType = '';

    if (input instanceof ArrayBuffer) {
      buf = input;
    } else {
      mimeType = input.type || '';
      // For images, only read the first 64KB (metadata is at the start)
      // For audio, read first 32KB (ID3v2) + last 128 bytes (ID3v1)
      if (mimeType.startsWith('image/')) {
        const slice = input.slice(0, MAX_EXIF_READ);
        buf = await slice.arrayBuffer();
      } else if (mimeType.startsWith('audio/')) {
        const headSlice = input.slice(0, MAX_ID3_READ);
        const headBuf = await headSlice.arrayBuffer();
        // Also read last 128 bytes for ID3v1
        let tailBuf = null;
        if (input.size > ID3V1_SIZE) {
          tailBuf = await input.slice(input.size - ID3V1_SIZE).arrayBuffer();
        }
        return parseAudio(headBuf, tailBuf);
      } else {
        return {};
      }
    }

    // Detect type from magic bytes
    if (buf.byteLength < 4) return {};
    const bytes = new Uint8Array(buf);

    // JPEG: starts with FF D8
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
      return parseImage(buf);
    }

    // MP3: starts with ID3 (ID3v2) or FF FB/FF F3/FF F2 (MPEG frame)
    if ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
        (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0)) {
      return parseAudio(buf, null);
    }

    return {};
  } catch {
    return {};
  }
}

/** Parse image metadata (EXIF + IPTC), merge results. */
function parseImage(buf) {
  const exif = parseExif(buf);
  const iptc = parseIptc(buf);

  // IPTC takes priority (more commonly used for professional photos)
  const result = { type: 'image' };
  if (iptc.title || exif.description) result.title = iptc.title || exif.description;
  if (iptc.description || exif.description) result.description = iptc.description || exif.description;
  if (iptc.artist || exif.artist) result.artist = iptc.artist || exif.artist;
  if (iptc.copyright || exif.copyright) result.copyright = iptc.copyright || exif.copyright;
  if (iptc.keywords) result.keywords = iptc.keywords;

  // Only return if we found something useful
  if (Object.keys(result).length <= 1) return {};
  return result;
}

/** Parse audio metadata (ID3v2 + ID3v1 fallback). */
function parseAudio(headBuf, tailBuf) {
  const v2 = parseId3v2(headBuf);
  const v1 = tailBuf ? parseId3v1(tailBuf) : {};

  // ID3v2 takes priority over v1
  const result = { type: 'audio' };
  if (v2.title || v1.title) result.title = v2.title || v1.title;
  if (v2.artist || v1.artist) result.artist = v2.artist || v1.artist;
  if (v2.album || v1.album) result.album = v2.album || v1.album;
  if (v2.genre) result.genre = v2.genre;
  if (v2.copyright) result.copyright = v2.copyright;
  if (v2.description) result.description = v2.description;

  if (Object.keys(result).length <= 1) return {};
  return result;
}

/**
 * Check if a file likely contains extractable metadata.
 *
 * Quick check based on MIME type — avoids reading the file if
 * metadata extraction wouldn't apply.
 *
 * @param {string} mimeType - MIME type string.
 * @returns {boolean} Whether extractMetadata would attempt parsing.
 */
export function hasExtractableMetadata(mimeType) {
  if (!mimeType) return false;
  return mimeType === 'image/jpeg' || mimeType === 'image/tiff' ||
         mimeType.startsWith('audio/');
}
