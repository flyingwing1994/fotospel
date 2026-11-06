'use strict';
// Controleert JPEG en verwijdert metadata (EXIF/GPS in APP1-APP15, commentaar).

function isJpeg(buf) {
  return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function stripJpegMetadata(buf) {
  if (!isJpeg(buf)) throw new Error('Geen JPEG');
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('Ongeldige JPEG');
    let marker = buf[i + 1];
    // vul-bytes overslaan
    while (marker === 0xff) { i++; marker = buf[i + 1]; }
    if (marker === 0xda) { // start of scan: rest ongewijzigd
      parts.push(buf.subarray(i));
      return Buffer.concat(parts);
    }
    if (marker === 0xd9) { parts.push(buf.subarray(i, i + 2)); return Buffer.concat(parts); }
    if (marker >= 0xd0 && marker <= 0xd7) { parts.push(buf.subarray(i, i + 2)); i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    const end = i + 2 + len;
    if (end > buf.length) throw new Error('Ongeldige JPEG');
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) parts.push(buf.subarray(i, end));
    i = end;
  }
  throw new Error('Ongeldige JPEG');
}

module.exports = { isJpeg, stripJpegMetadata };
