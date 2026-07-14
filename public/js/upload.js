/* Client-side photo compression + resilient uploads for slow rural wifi. */

const PhotoUpload = {
  MAX_DIM: 1600,
  QUALITY: 0.82,

  // Shrink a photo before upload: phone photos are ~4-8 MB; this gets them to ~200-400 KB.
  async compress(file) {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, this.MAX_DIM / Math.max(bitmap.width, bitmap.height));
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', this.QUALITY)
      );
      // If compression somehow made it bigger (tiny images), keep the original.
      return blob && blob.size < file.size ? blob : file;
    } catch {
      return file; // never block a post because compression failed
    }
  },

  // XHR upload with progress callback; retries with backoff on flaky connections.
  uploadOnce(blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.timeout = 120000;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error(`Upload failed (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.ontimeout = () => reject(new Error('Upload timed out'));
      const form = new FormData();
      form.append('photo', blob, 'photo.jpg');
      xhr.send(form);
    });
  },

  async upload(blob, onProgress, retries = 3) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.uploadOnce(blob, onProgress);
      } catch (err) {
        lastErr = err;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  },
};
