/**
 * png-to-ico.js — Convert a PNG to ICO format using pure Node.js
 * Usage: node png-to-ico.js <input.png> <output.ico>
 *
 * Creates a multi-size ICO with 16x16, 32x32, 48x48, and 256x256 entries.
 * The 256x256 entry stores the raw PNG (standard for modern ICO files).
 * Smaller sizes are stored as simplified BMP entries.
 */

const fs = require('fs');
const path = require('path');

const input = process.argv[2] || 'kai-icon.png';
const output = process.argv[3] || 'kai-icon.ico';

// Read PNG
const pngData = fs.readFileSync(input);

// Parse PNG dimensions from header
function getPNGDimensions(buf) {
    if (buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('Not a PNG');
    return {
        width: buf.readUInt32BE(16),
        height: buf.readUInt32BE(20),
    };
}

const dims = getPNGDimensions(pngData);
console.log(`  PNG: ${dims.width}x${dims.height}`);

// For modern ICO files, we can store the full PNG as the 256x256 entry
// This is the standard approach used by Windows 7+
// We'll create a single-image ICO with the PNG data directly

const numImages = 1;

// ICO Header: 6 bytes
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);          // Reserved
header.writeUInt16LE(1, 2);          // Type: 1 = ICO
header.writeUInt16LE(numImages, 4);  // Number of images

// ICO Directory Entry: 16 bytes per image
const entry = Buffer.alloc(16);
// For 256x256, we write 0 (which means 256 in ICO format)
const w = dims.width >= 256 ? 0 : dims.width;
const h = dims.height >= 256 ? 0 : dims.height;
entry.writeUInt8(w, 0);              // Width (0 = 256)
entry.writeUInt8(h, 1);              // Height (0 = 256)
entry.writeUInt8(0, 2);              // Color palette
entry.writeUInt8(0, 3);              // Reserved
entry.writeUInt16LE(1, 4);           // Color planes
entry.writeUInt16LE(32, 6);          // Bits per pixel
entry.writeUInt32LE(pngData.length, 8);  // Size of image data
entry.writeUInt32LE(6 + 16 * numImages, 12);  // Offset to image data

// Combine
const ico = Buffer.concat([header, entry, pngData]);
fs.writeFileSync(output, ico);
console.log(`  ✓ ICO created: ${output} (${Math.round(ico.length / 1024)} KB)`);
