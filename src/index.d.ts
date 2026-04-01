export interface ImageMetadata {
  type: 'image';
  title?: string;
  description?: string;
  artist?: string;
  copyright?: string;
  keywords?: string[];
}

export interface AudioMetadata {
  type: 'audio';
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  copyright?: string;
  description?: string;
}

export type FileMetadata = ImageMetadata | AudioMetadata | Record<string, never>;

/**
 * Extract metadata from a file.
 * Parses EXIF/IPTC from JPEG images and ID3v1/v2 from MP3 audio.
 * Returns empty object for unsupported types or parse failures.
 */
export function extractMetadata(input: File | Blob | ArrayBuffer): Promise<FileMetadata>;

/** Check if a MIME type supports metadata extraction. */
export function hasExtractableMetadata(mimeType: string): boolean;
